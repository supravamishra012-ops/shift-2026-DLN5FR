import warnings; warnings.filterwarnings('ignore')
"""DRISHTI step 3: suitability scoring, hub siting (MCLP), swap stations (p-median), corridors and van loops on the road network.

Inputs : grid CSV (attributes, corrected UMVI) + GeoPackage (hex geometry, EPSG:32643)
Outputs: out/model.json (dashboard data), out/cells.gpkg, out/metrics.json
"""
import json, math, sys
import numpy as np, pandas as pd, geopandas as gpd, networkx as nx, pulp
from scipy.spatial import cKDTree

CSV = 'data/grid.csv'      # grid attributes (corrected UMVI)
GPKG = 'data/grid.gpkg'    # hex grid geometry, EPSG:32643

# ---------------- parameters (all editable in dashboard) ----------------
P = dict(
    hub_radius_m=1500,        # hub service zone: 1.5 km road distance between cell centres
    trip_rate=1.3,            # motorised+cycle trips / person / day
    short_trip_share=0.45,    # share of trips < 5 km (micromobility-addressable)
    adoption=0.005,           # share of short trips captured by shared e-micromobility
    trip_km=3.0,              # mean e-bike trip length
    wh_per_km=22.0,           # energy use of a low-speed e-bike
    battery_kwh=1.0,          # pack size
    usable_dod=0.8,           # swap at 20 % state of charge
    charge_eff=0.90,
    trips_per_vehicle=5.0,    # target daily turnover
    battery_ratio=1.5,        # batteries in circulation per vehicle
    station_capacity=400,     # swaps / day a swap station can serve
    station_max_km=4.0,       # max hub -> swap station distance
    od_min_km=1.0, od_max_km=6.0,
)
W = dict(D=0.35, A=0.25, F=0.25, G=0.10, E=0.05)   # balanced scenario

def rk(s):
    """percentile rank 0-1 (robust to skew/outliers)"""
    s = pd.Series(s).astype(float)
    return s.rank(pct=True, method='average').fillna(0).values

# ---------------- load ----------------
d = pd.read_csv(CSV, encoding='utf-8-sig')
g = gpd.read_file(GPKG)[['Grid_ID', 'geometry']]
g = g.merge(d, on='Grid_ID', how='left')
assert len(g) == 2227
cen = g.geometry.centroid
X, Y = cen.x.values, cen.y.values
ll = gpd.GeoSeries(cen, crs=g.crs).to_crs(4326)
g['lon'], g['lat'] = ll.x.values, ll.y.values
n = len(g)

lulc = g['Total LULC'].replace(0, np.nan)
g['built_share'] = (g['built_up'] / lulc).fillna(0)
g['water_share'] = (g['permanent_water_bodies'] / lulc).fillna(0)
g['green_share'] = ((g['tree_cover'] + g['grassland']) / lulc).fillna(0)
g['pop'] = g['population_mean'] * g['Area (km2)']        # persons in the cell
g['yulu'] = (g['yulu_zone_density'] > 0) | (g['yulu_bike_density'] > 0)
traffic = g.avg_cars + 2 * g.avg_trucks + 2 * g.avg_buses + 0.5 * g.avg_motorcycles

# ---------------- sub-indices (0-1) ----------------
g['D'] = 0.40 * rk(g.Norm_CLEDS) + 0.25 * rk(g['pop']) + 0.20 * rk(g['Total POI']) + 0.15 * rk(g.ntl_mean)
g['A'] = (0.30 * rk(g.Norm_FAI) + 0.30 * rk(g.POI_ebike_10min_count)
          + 0.20 * rk(g.Norm_Intersection_Density) + 0.20 * rk(g.POI_diversity_index))
g['F'] = (0.20 * rk(g.lowstress_share) + 0.15 * (1 - rk(g.slope_mean)) + 0.15 * rk(g.Norm_Infra_Density)
          + 0.10 * rk(g.Norm_Safety_Density) + 0.10 * rk(g.avg_sidewalk_present)
          + 0.10 * rk(g.tree_pixel_ratio) + 0.20 * (1 - rk(traffic)))
g['F'] = rk(g['F'])                                     # re-spread to 0-1
g['G'] = 0.6 * (1 - rk(g.OMAS)) + 0.4 * (~g.yulu).astype(float)   # unserved market
g['E'] = 1 - rk(g['Socioeconomic Index'])                         # equity need
g['B'] = (0.30 * rk(g.built_share) + 0.30 * rk(g.ntl_mean) + 0.20 * rk(g.warehouse_poi + g.Total_Road_Length / 5000)
          + 0.20 * rk(g.Infrastructure_index))                    # battery / charging feasibility
g['stress'] = 1 - (0.35 * rk(g.lowstress_share) + 0.25 * (1 - rk(traffic)) + 0.15 * (1 - rk(g.slope_mean))
                   + 0.15 * rk(g.Norm_Infra_Density) + 0.10 * rk(g.Norm_Safety_Density))

def suit(w):
    return sum(w[k] * g[k].values for k in w) / sum(w.values())
g['S'] = suit(W)

# eligibility (hard constraints for siting a hub)
g['eligible'] = ((g.built_share >= 0.10) & (g.Total_Road_Length >= 3000) & (g.water_share < 0.25)
                 & (g.slope_mean < np.percentile(g.slope_mean, 97)))

# demand model
mult = 0.5 + g['D']
mult = mult / mult.mean()
def trips(adopt=P['adoption']):
    return g['pop'] * P['trip_rate'] * P['short_trip_share'] * adopt * mult
g['trips'] = trips()

# ---------------- coverage sets ----------------
tree = cKDTree(np.c_[X, Y])
# ---- road network (OSM, user-supplied) ----
import pickle
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra as sp_dijkstra
R = pickle.load(open('build/roadnet.pkl', 'rb'))
NN = len(R['NXY']); U_, V_, LEN_ = R['U'], R['V'], R['LEN'].astype(float)
CLF = np.array([1.8, 1.4, 1.15, 1.05, 1.0, 1.0, 1.0, 1.1])
BIKE_ = LEN_ * (1 + 1.5 * R['HS']) * CLF[R['CL']]
def mkgraph(w):
    return csr_matrix((np.r_[w, w], (np.r_[U_, V_], np.r_[V_, U_])), shape=(NN, NN))
GW, GB = mkgraph(LEN_), mkgraph(BIKE_)
ekey = {}
for k_, (a_, b_) in enumerate(zip(U_, V_)):
    kk = (min(a_, b_), max(a_, b_))
    if kk not in ekey or LEN_[k_] < LEN_[ekey[kk]]: ekey[kk] = k_
ntree = cKDTree(R['NXY'])
snap_d, cnode = ntree.query(np.c_[X, Y])
g['node'] = cnode; g['snap_m'] = snap_d
print('cell snap distance median/95%', np.percentile(snap_d, [50, 95]).round(0))
RAD = P['hub_radius_m']
uniq_nodes = np.unique(cnode)
N = [[] for _ in range(n)]; ND = [dict() for _ in range(n)]
for ch in range(0, n, 150):
    idx = np.arange(ch, min(n, ch + 150))
    Dm = sp_dijkstra(GW, directed=False, indices=cnode[idx], limit=RAD + 50)
    Dc = Dm[:, cnode] + snap_d[idx][:, None] + snap_d[None, :]
    for r_, i in enumerate(idx):
        js = np.where(Dc[r_] <= RAD)[0]
        if snap_d[i] > RAD: js = np.array([i])
        if i not in js: js = np.r_[js, i]
        N[i] = [int(j) for j in js]; ND[i] = {int(j): float(min(Dc[r_, j], 1e9)) for j in js}
print('network coverage sets: mean size', np.mean([len(x) for x in N]).round(1))
elig = np.where(g.eligible.values)[0]

def greedy(weights, p, allowed):
    covered = np.zeros(n, bool); chosen = []; gains = []
    allowed = set(allowed)
    for _ in range(p):
        best, bg = None, -1
        for j in allowed:
            gain = weights[[i for i in N[j] if not covered[i]]].sum()
            if gain > bg: best, bg = j, gain
        chosen.append(best); gains.append(bg); allowed.discard(best)
        covered[N[best]] = True
    return chosen, np.cumsum(gains)

def mclp(weights, p, allowed, time_limit=120):
    prob = pulp.LpProblem('MCLP', pulp.LpMaximize)
    x = {j: pulp.LpVariable(f'x{j}', cat='Binary') for j in allowed}
    cand_for = {i: [] for i in range(n)}
    for j in allowed:
        for i in N[j]: cand_for[i].append(j)
    ys = {i: pulp.LpVariable(f'y{i}', 0, 1) for i in range(n) if cand_for[i]}
    prob += pulp.lpSum(weights[i] * ys[i] for i in ys)
    prob += pulp.lpSum(x.values()) == p
    for i in ys: prob += ys[i] <= pulp.lpSum(x[j] for j in cand_for[i])
    prob.solve(pulp.HiGHS(msg=False, timeLimit=time_limit))
    chosen = [j for j in allowed if x[j].value() > 0.5]
    return chosen, pulp.value(prob.objective), pulp.LpStatus[prob.status]

w = g['S'].values * g['trips'].values / g['trips'].mean()      # suitability-weighted trip demand
w = w / w.sum()

# coverage curve (greedy) to pick p at the knee
_, curve = greedy(w, 260, elig)
marg = np.diff(np.r_[0, curve])
p_star = int(np.argmax(marg < 0.002) + 1)       # first hub adding < 0.2 % of weighted demand
p_star = max(60, min(p_star, 200))
print('p* =', p_star, 'coverage at p* (greedy)=', curve[p_star - 1].round(3))

hubs, obj, status = mclp(w, p_star, list(elig))
gr_hubs, gr_curve = greedy(w, p_star, elig)
print('exact', status, round(obj, 4), 'greedy', round(gr_curve[-1], 4))

# scenarios -> robustness
SCEN = {
    'Balanced': W,
    'Demand-led': dict(D=0.55, A=0.25, F=0.15, G=0.05, E=0.0),
    'Safety-first': dict(D=0.25, A=0.20, F=0.45, G=0.05, E=0.05),
    'Equity & white-space': dict(D=0.25, A=0.20, F=0.20, G=0.20, E=0.15),
}
robust = np.zeros(n, int); scen_res = {}
for name, ww in SCEN.items():
    sw = suit(ww) * g['trips'].values / g['trips'].mean(); sw = sw / sw.sum()
    if name == 'Balanced': ch, ob = hubs, obj
    else: ch, ob, st = mclp(sw, p_star, list(elig), 60)
    robust[ch] += 1
    cov = np.zeros(n, bool)
    for j in ch: cov[N[j]] = True
    scen_res[name] = dict(weights=ww, hubs=[int(c) for c in ch], weighted_cov=round(float(ob), 4),
                          pop_cov=round(float(g['pop'][cov].sum() / g['pop'].sum()), 4))
# neighbourhood robustness: a scenario 'agrees' if it places a hub within the hub radius
robust = np.zeros(n, int)
for name, v in scen_res.items():
    hs_ = set(v['hubs'])
    robust += np.array([any(j in hs_ for j in N[i]) for i in range(n)], int)
g['robust'] = robust

# ---------------- hub metrics ----------------
cov = np.zeros(n, bool); owner = -np.ones(n, int)
# assign each covered cell to nearest hub
hset = set(hubs)
for i in range(n):
    cand_h = [(ND[i][j], j) for j in N[i] if j in hset]
    if cand_h: owner[i] = min(cand_h)[1]
covered = owner >= 0
g['hub_owner'] = owner
hub_trips = g.groupby('hub_owner')['trips'].sum()
E_TRIP = P['trip_km'] * P['wh_per_km'] / 1000                 # kWh per trip
TRIPS_PER_CHARGE = P['battery_kwh'] * P['usable_dod'] / E_TRIP
H = []
for j in hubs:
    t = float(hub_trips.get(j, 0))
    fleet = math.ceil(t / P['trips_per_vehicle'])
    swaps = t / TRIPS_PER_CHARGE
    H.append(dict(cell=int(j), grid=int(g.Grid_ID[j]), lat=round(g.lat[j], 5), lon=round(g.lon[j], 5),
                  S=round(g.S[j], 3), D=round(g.D[j], 3), A=round(g.A[j], 3), F=round(g.F[j], 3),
                  B=round(g.B[j], 3), trips=round(t), fleet=fleet, swaps=round(swaps, 1),
                  robust=int(robust[j]), yulu=bool(g.yulu[j]), demand=g.demand_category[j]))
Hdf = pd.DataFrame(H)

# ---------------- battery swap stations (capacitated p-median) ----------------
tot_swaps = Hdf.swaps.sum()
cand = np.where(g.eligible.values & (g.B.values >= np.percentile(g.B.values[g.eligible.values], 40)))[0]
HUBN = cnode[hubs]
DH, PH = sp_dijkstra(GW, directed=False, indices=HUBN, return_predecessors=True)
DMAT = (DH[:, cnode[cand]] + snap_d[hubs][:, None] + snap_d[cand][None, :]) / 1000
def pmedian(q):
    dmat = DMAT
    prob = pulp.LpProblem('PMED', pulp.LpMinimize)
    yv = {k: pulp.LpVariable(f's{k}', cat='Binary') for k in range(len(cand))}
    pairs = [(h, k) for h in range(len(hubs)) for k in range(len(cand)) if dmat[h, k] <= P['station_max_km']]
    z = {(h, k): pulp.LpVariable(f'z{h}_{k}', cat='Binary') for h, k in pairs}
    prob += pulp.lpSum(Hdf.swaps[h] * dmat[h, k] * z[h, k] for h, k in pairs) - 0.5 * pulp.lpSum(g.B.values[cand[k]] * yv[k] for k in yv)
    prob += pulp.lpSum(yv.values()) == q
    byh = {}
    for h, k in pairs: byh.setdefault(h, []).append(k)
    for h in range(len(hubs)): prob += pulp.lpSum(z[h, k] for k in byh.get(h, [])) == 1
    byk = {}
    for h, k in pairs:
        prob += z[h, k] <= yv[k]
        byk.setdefault(k, []).append(h)
    for k, hs in byk.items():
        prob += pulp.lpSum(Hdf.swaps[h] * z[h, k] for h in hs) <= P['station_capacity'] * yv[k]
    prob.solve(pulp.HiGHS(msg=False, timeLimit=180))
    st = pulp.LpStatus[prob.status]
    if st not in ('Optimal',) and not any((v.value() or 0) > 0.5 for v in yv.values()):
        return None
    sel = [k for k in yv if (yv[k].value() or 0) > 0.5]
    assign = {}
    for (h, k), v in z.items():
        if (v.value() or 0) > 0.5: assign[h] = k
    if len(assign) < len(hubs): return None
    return sel, assign, dmat, st

q = max(6, math.ceil(tot_swaps / (0.8 * P['station_capacity'])))
res = None
while res is None and q < 60:
    res = pmedian(q)
    if res is None: q += 1
sel, assign, dmat, pst = res
print('swap stations', q, pst, 'total swaps/day', round(tot_swaps))
ST = []
for k in sel:
    c = cand[k]; served = [h for h, kk in assign.items() if kk == k]
    sw = float(Hdf.swaps[served].sum())
    kwh = sw * P['battery_kwh'] * P['usable_dod'] / P['charge_eff']
    ST.append(dict(cell=int(c), grid=int(g.Grid_ID[c]), lat=round(g.lat[c], 5), lon=round(g.lon[c], 5),
                   B=round(g.B[c], 3), hubs=[int(hubs[h]) for h in served], swaps=round(sw),
                   kwh_day=round(kwh), peak_kw=round(kwh / 10 * 1.5, 1),     # 10 h effective charge window, 1.5 peak factor
                   chargers=math.ceil(sw * 3 / 20),                           # 3 h charge, 20 h/day availability
                   stock=math.ceil(sw * 3 / 24 * 1.8) + 10,
                   util=round(sw / P['station_capacity'], 2),
                   mean_km=round(float(np.mean([dmat[h, k] for h in served])), 2) if served else 0))
Hdf['station'] = [int(cand[assign[h]]) for h in range(len(hubs))]
for h in range(len(hubs)): H[h]['station'] = int(cand[assign[h]])

# battery van routes: nearest-neighbour + 2-opt loop from station over its hubs
def tour(pts):
    if len(pts) <= 2: return list(range(len(pts)))
    order = [0]; rest = set(range(1, len(pts)))
    while rest:
        last = order[-1]; nx_ = min(rest, key=lambda r: math.dist(pts[last], pts[r])); order.append(nx_); rest.remove(nx_)
    improved = True
    def L(o): return sum(math.dist(pts[o[i]], pts[o[(i + 1) % len(o)]]) for i in range(len(o)))
    while improved:
        improved = False
        for i in range(1, len(order) - 1):
            for k in range(i + 1, len(order)):
                new = order[:i] + order[i:k + 1][::-1] + order[k + 1:]
                if L(new) < L(order) - 1e-6: order, improved = new, True
    return order
def tour_net(dm):
    m_ = len(dm)
    if m_ <= 2: return list(range(m_))
    order = [0]; rest = set(range(1, m_))
    while rest:
        last = order[-1]; nx_ = min(rest, key=lambda r: dm[last, r]); order.append(nx_); rest.remove(nx_)
    def L(o): return sum(dm[o[i], o[(i + 1) % len(o)]] for i in range(len(o)))
    improved = True
    while improved:
        improved = False
        for i in range(1, len(order) - 1):
            for k in range(i + 1, len(order)):
                new = order[:i] + order[i:k + 1][::-1] + order[k + 1:]
                if L(new) < L(order) - 1e-6: order, improved = new, True
    return order
def path_edges(pred, src, dst):
    out = []; cur = dst
    while cur != src and cur >= 0:
        p_ = pred[cur]
        if p_ < 0: break
        out.append(int(ekey[(min(p_, cur), max(p_, cur))])); cur = p_
    return out[::-1]
VAN = []
for s in ST:
    cells = [s['cell']] + s['hubs']
    nodes_ = [int(cnode[c]) for c in cells]
    Ds, Ps = sp_dijkstra(GW, directed=False, indices=nodes_, return_predecessors=True)
    dm_ = Ds[:, nodes_]
    o = tour_net(dm_)
    seq = [o[i] for i in range(len(o))] + [o[0]]
    km = sum(dm_[a, b] for a, b in zip(seq, seq[1:])) / 1000
    eids = []
    for a, b in zip(seq, seq[1:]):
        eids += path_edges(Ps[a], nodes_[a], nodes_[b])
    VAN.append(dict(station=s['cell'], edges=eids, km=round(km, 1), stops=[int(cells[i]) for i in seq]))
    s['van_km'] = round(km, 1)

# ---------------- riding corridors on the road network ----------------
hub_set = list(hubs)
OD = []
for i, a in enumerate(hub_set):
    for b in hub_set[i + 1:]:
        dk = math.dist((X[a], Y[a]), (X[b], Y[b])) / 1000
        if P['od_min_km'] <= dk <= P['od_max_km']:
            ta, tb = hub_trips.get(a, 0), hub_trips.get(b, 0)
            OD.append((ta * tb / dk ** 2, a, b, dk))
best = {}
for o in OD:
    for h in (o[1], o[2]): best.setdefault(h, []).append(o)
keep = set()
for h, lst in best.items():
    for o in sorted(lst, reverse=True)[:3]: keep.add(o)
OD = sorted(keep, reverse=True)
DB, PB = sp_dijkstra(GB, directed=False, indices=HUBN, return_predecessors=True)
hidx = {h: k for k, h in enumerate(hubs)}
edge_flow = {}; od_routes = []
for grav, a, b, dk in OD:
    ia = hidx[a]; eids = path_edges(PB[ia], int(HUBN[ia]), int(cnode[b]))
    Ls = float(sum(LEN_[e] for e in eids)); hsk = float(sum(LEN_[e] for e in eids if R['HS'][e]))
    sh = DH[ia, cnode[b]]
    od_routes.append(dict(a=int(a), b=int(b), gravity=float(grav), km=round(Ls / 1000, 2), short_km=round(float(sh) / 1000, 2),
                          detour=round(Ls / 1000 / dk, 2), hs_share=round(hsk / max(Ls, 1), 3)))
    for e in eids: edge_flow[e] = edge_flow.get(e, 0) + math.sqrt(grav)
mx = max(edge_flow.values())
COR = []
for e, f in edge_flow.items():
    risk = (1.0 if R['HS'][e] else 0.25) * CLF[R['CL'][e]] / 1.8
    COR.append(dict(e=int(e), load=round(f / mx, 4), hs=int(R['HS'][e]), cl=int(R['CL'][e]),
                    priority=round(float((f / mx) ** 0.5 * risk), 4)))
COR.sort(key=lambda c: -c['load'])
cor_df = pd.DataFrame(COR)
print('corridor edges', len(COR), 'km', round(sum(LEN_[c['e']] for c in COR) / 1000, 1))

# ---------------- metrics ----------------
covmask = owner >= 0
hi = g.demand_category.isin(['High', 'Very High'])
M = dict(
    cells=n, area_km2=round(float(g['Area (km2)'].sum()), 1), population=round(float(g['pop'].sum())),
    eligible_cells=int(g.eligible.sum()),
    hubs=p_star, stations=len(ST),
    pop_covered=round(float(g['pop'][covmask].sum() / g['pop'].sum()), 4),
    trips_city=round(float(g.trips.sum())), trips_covered=round(float(g.trips[covmask].sum())),
    hi_demand_cells=int(hi.sum()), hi_demand_covered=round(float((hi & covmask).sum() / hi.sum()), 4),
    hi_demand_no_yulu=round(float((hi & ~g.yulu).sum() / hi.sum()), 4),
    hi_demand_no_safety=round(float((hi & (g.Total_Safety_Point == 0)).sum() / hi.sum()), 4),
    hi_demand_no_nmr=round(float((hi & (g.Total_NMR_Length == 0)).sum() / hi.sum()), 4),
    yulu_cells=int(g.yulu.sum()),
    yulu_cells_hi=int((g.yulu & hi).sum()),
    pop_yulu_cov=round(float(g['pop'][g.yulu].sum() / g['pop'].sum()), 4),
    fleet=int(Hdf.fleet.sum()), swaps_day=round(float(tot_swaps)),
    batteries=int(math.ceil(Hdf.fleet.sum() * P['battery_ratio'])),
    energy_kwh_day=round(float(sum(s['kwh_day'] for s in ST))),
    van_km_day=round(float(sum(v['km'] for v in VAN)), 1),
    trips_per_charge=round(TRIPS_PER_CHARGE, 1), kwh_per_trip=round(E_TRIP, 3),
    mean_hub_station_km=round(float(np.mean([dmat[h, assign[h]] for h in range(len(hubs))])), 2),
    max_hub_station_km=round(float(np.max([dmat[h, assign[h]] for h in range(len(hubs))])), 2),
    exact_obj=round(float(obj), 4), greedy_obj=round(float(gr_curve[-1]), 4),
    hubs_robust_all4=int((robust[hubs] == 4).sum()),
    hubs_yulu_overlap=int(g.yulu.values[hubs].sum()),
    od_pairs=len(od_routes), mean_route_hs_share=round(float(np.mean([r['hs_share'] for r in od_routes])), 3),
    mean_vs_shortest=round(float(np.mean([r['km'] / max(r['short_km'], 0.01) for r in od_routes])), 3),
    corridor_km=round(float(sum(LEN_[c['e']] for c in COR) / 1000), 1),
    corridor_hs_km=round(float(sum(LEN_[c['e']] for c in COR if c['hs']) / 1000), 1),
    road_km=round(float(LEN_.sum() / 1000), 1), road_hs_km=round(float(LEN_[R['HS'] == 1].sum() / 1000), 1),
    road_nodes=int(NN), road_edges=int(len(U_)),
    road_km_by_class={k: round(float(LEN_[R['CL'] == i].sum() / 1000), 1) for i, k in enumerate(['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service'])},
    cells_no_road=int((snap_d > 500).sum()),
    mean_detour=round(float(np.mean([r['detour'] for r in od_routes])), 2),
    corr_demand_lowstress=round(float(pd.Series(g.Norm_CLEDS).corr(g.lowstress_share, method='spearman')), 3),
    corr_demand_tree=round(float(pd.Series(g.Norm_CLEDS).corr(g.tree_pixel_ratio, method='spearman')), 3),
    hi_stress_share_hi_demand=round(float((g.stress[hi] > g.stress.median()).mean()), 4),
    coverage_curve=[round(float(v), 4) for v in curve[:260]],
)
# demand by quintile vs supply (for problem chart)
g['Dq'] = pd.qcut(g.Norm_CLEDS.rank(method='first'), 5, labels=['Q1 lowest', 'Q2', 'Q3', 'Q4', 'Q5 highest'])
prob_tab = g.groupby('Dq', observed=True).agg(cells=('Grid_ID', 'size'), pop=('pop', 'sum'),
    yulu_pct=('yulu', 'mean'), omas=('OMAS', 'mean'), safety0=('Total_Safety_Point', lambda s: (s == 0).mean()),
    nmr0=('Total_NMR_Length', lambda s: (s == 0).mean()), stress=('stress', 'mean'), tree=('tree_pixel_ratio', 'mean'),
    trips=('trips', 'sum')).reset_index()
M['problem_table'] = prob_tab.round(4).astype({'Dq': str}).to_dict('records')
M['scenarios'] = {k: {kk: vv for kk, vv in v.items() if kk != 'hubs'} | {'overlap_with_balanced': len(set(v['hubs']) & set(map(int, hubs)))}
                  for k, v in scen_res.items()}
M['params'] = P; M['weights'] = W
print(json.dumps({k: v for k, v in M.items() if k not in ('coverage_curve', 'problem_table')}, indent=1))
print(prob_tab.round(3).to_string())

# ---------------- export ----------------
import os
os.makedirs('build', exist_ok=True)
g4 = g.to_crs(4326)
cells = []
for i in range(n):
    geom = g4.geometry.iloc[i]
    poly = list(geom.geoms)[0] if geom.geom_type == 'MultiPolygon' else geom
    coords = [[round(y, 5), round(x, 5)] for x, y in list(poly.exterior.coords)[:-1]]
    cells.append(dict(
        id=int(g.Grid_ID[i]), p=coords, la=round(g.lat[i], 5), lo=round(g.lon[i], 5),
        D=round(g.D[i], 3), A=round(g.A[i], 3), F=round(g.F[i], 3), G=round(g.G[i], 3), E=round(g.E[i], 3),
        B=round(g.B[i], 3), st=round(g.stress[i], 3), el=int(g.eligible[i]), pop=round(float(g['pop'][i])),
        t=round(float(g.trips[i]), 1), dc=g.demand_category[i], y=int(g.yulu[i]), om=round(float(g.OMAS[i]), 3),
        um=round(float(g.Norm_UMVI[i]), 3), nm=round(float(g.Norm_NMSI[i]), 3), mi=round(float(g.Norm_MIRI[i]), 3),
        cl=round(float(g.Norm_CLEDS[i]), 3), ty=g['UMVI—NMSI_Typology_Class'][i], sl=round(float(g.slope_mean[i]), 2),
        sf=int(g.Total_Safety_Point[i]), nmr=round(float(g.Total_NMR_Length[i])), tr=round(float(g.tree_pixel_ratio[i]), 3),
        r=int(robust[i]), ses=round(float(g['Socioeconomic Index'][i]), 3), poi=int(g['Total POI'][i]),
        nb=[int(k) for k in N[i]], nbd=[int(round(ND[i][k])) for k in N[i]], nd=int(cnode[i]), sd=round(float(snap_d[i]))))
model = dict(cells=cells, hubs=H, stations=ST, vans=VAN, corridors=COR, od=od_routes, metrics=M,
             scenarios={k: v['hubs'] for k, v in scen_res.items()})
json.dump(model, open('build/model.json', 'w'), separators=(',', ':'))
gx = g.drop(columns=['Dq']); seen=set(); keep=[]
for c in gx.columns:
    if c.lower() in seen: continue
    seen.add(c.lower()); keep.append(c)
gx[keep].to_file('build/cells.gpkg', driver='GPKG')
Hdf.to_csv('build/hubs.csv', index=False)
pd.DataFrame(ST).drop(columns=['hubs']).to_csv('build/swap_stations.csv', index=False)
cor_df.to_csv('build/corridor_edges.csv', index=False)
json.dump(M, open('build/metrics.json', 'w'), indent=1)
print('size MB', os.path.getsize('build/model.json') / 1e6)
