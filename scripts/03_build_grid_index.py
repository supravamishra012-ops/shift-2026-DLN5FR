"""
LAYER 3 - Grid-scale Micromobility Suitability Index (MSI).

A regular grid (default 0.025 deg ~ 2.8 km) is laid over India. Only cells within
RADIUS_KM of an RTO office are kept (where registration activity exists).

Each cell gets component scores in 0..100 (higher = more suitable):
  demand      registration intensity: Gaussian-weighted sum of all-fuel registrations
              (2022-24) of nearby RTOs (sigma = SIGMA_KM). Log-scaled.
  urban       closeness to the nearest RTO office (proxy for urban centre / services).
  ev_share    district EV share of new registrations, 2024 (percentile across districts).
  ev_growth   district EV CAGR 2020-24 (percentile).
  circular    district EOL Li-ion battery kWh in 2030 from Layer 2 (percentile) -
              where swap / second-life / recycling hubs make sense.
  population  OPTIONAL - if raw/population.tif (e.g. WorldPop 1 km) exists.
  poi         OPTIONAL - if raw/pois.geojson (OSM points: metro/bus stations, colleges,
              markets, offices) exists: POI count per cell, log-scaled.

The website combines components with weights chosen per user role
(Municipality / Service provider), so weights are NOT baked in here.

Output: data/grid.json  {cell, fields, rows:[[lat, lon, did, c1, c2, ...], ...]}
"""
import json
import math

import numpy as np
import geopandas as gpd

from common import RAW, DATA, write_json

CELL_DEG = 0.025
RADIUS_KM = 15
SIGMA_KM = 5


def pct_rank(d):
    """dict id->value  ->  dict id->percentile 0..100 (None stays None)."""
    items = [(k, v) for k, v in d.items() if v is not None]
    if not items:
        return {}
    vals = np.array([v for _, v in items], dtype=float)
    order = vals.argsort().argsort()
    return {k: 100.0 * r / max(len(items) - 1, 1) for (k, _), r in zip(items, order)}


def haversine_km(lat1, lon1, lat2, lon2):
    p = np.pi / 180
    a = (np.sin((lat2 - lat1) * p / 2) ** 2 +
         np.cos(lat1 * p) * np.cos(lat2 * p) * np.sin((lon2 - lon1) * p / 2) ** 2)
    return 12742 * np.arcsin(np.sqrt(a))


def main():
    print("Layer 3: grid suitability index ...")
    rtos = json.load(open(DATA / "rtos.json"))
    gj = json.load(open(DATA / "districts.geojson"))
    waste = json.load(open(DATA / "waste.json"))

    # ---- district-level components ----
    props = {f["properties"]["did"]: f["properties"] for f in gj["features"]}
    ev_share = pct_rank({d: p.get("ev_share_2024") for d, p in props.items()})
    ev_growth = pct_rank({d: p.get("ev_cagr_20_24") for d, p in props.items()})
    i30 = waste["years"].index(2030)
    circ = pct_rank({int(d): sum(v["kwh"][c][i30] for c in v["kwh"] if c != "Lead-acid")
                     for d, v in waste["districts"].items()})

    # ---- candidate cells around RTOs ----
    r_lat = np.array([r["lat"] for r in rtos]); r_lon = np.array([r["lon"] for r in rtos])
    r_reg = np.array([r["reg"] for r in rtos], dtype=float)
    dlat = RADIUS_KM / 111.0
    cells = set()
    for la, lo in zip(r_lat, r_lon):
        dlon = RADIUS_KM / (111.0 * math.cos(math.radians(la)))
        for i in range(int((la - dlat) / CELL_DEG), int((la + dlat) / CELL_DEG) + 1):
            for j in range(int((lo - dlon) / CELL_DEG), int((lo + dlon) / CELL_DEG) + 1):
                cells.add((i, j))
    cells = np.array(sorted(cells))
    c_lat = (cells[:, 0] + 0.5) * CELL_DEG
    c_lon = (cells[:, 1] + 0.5) * CELL_DEG
    print(f"  candidate cells: {len(cells):,}")

    # ---- distance-based components (chunked) ----
    demand = np.zeros(len(cells)); near = np.full(len(cells), np.inf)
    near_rto = np.zeros(len(cells), dtype=int)
    for s in range(0, len(cells), 4000):
        sl = slice(s, s + 4000)
        d = haversine_km(c_lat[sl, None], c_lon[sl, None], r_lat[None, :], r_lon[None, :])
        demand[sl] = (np.exp(-0.5 * (d / SIGMA_KM) ** 2) * r_reg[None, :]).sum(axis=1)
        near[sl] = d.min(axis=1)
        near_rto[sl] = d.argmin(axis=1)
    keep = near <= RADIUS_KM
    cells, c_lat, c_lon, demand, near, near_rto = (a[keep] for a in (cells, c_lat, c_lon, demand, near, near_rto))

    # ---- assign each cell to a district (point in polygon) ----
    dist = gpd.GeoDataFrame.from_features(gj["features"], crs=4326)[["did", "geometry"]]
    pts = gpd.GeoDataFrame({"k": np.arange(len(cells))},
                           geometry=gpd.points_from_xy(c_lon, c_lat), crs=4326)
    j = gpd.sjoin(pts, dist, how="left", predicate="within").drop_duplicates("k").sort_values("k")
    did = j["did"].to_numpy()
    inside = ~np.isnan(did.astype(float))
    cells, c_lat, c_lon, demand, near, did, near_rto = (
        a[inside] for a in (cells, c_lat, c_lon, demand, near, did, near_rto))
    did = did.astype(int)
    # districts without their own RTO borrow the stats of the nearest RTO's district
    stat_did = np.array([d if props[d].get("has_data") else rtos[r]["did"]
                         for d, r in zip(did, near_rto)])
    print(f"  cells kept (on land, within {RADIUS_KM} km of an RTO): {len(cells):,}")

    ld = np.log1p(demand)
    comp = {
        "demand": 100 * (ld - ld.min()) / (ld.max() - ld.min()),
        "urban": 100 * (1 - near / RADIUS_KM),
        "ev_share": np.array([ev_share.get(d, 0) for d in stat_did]),
        "ev_growth": np.array([ev_growth.get(d, 0) for d in stat_did]),
        "circular": np.array([circ.get(d, 0) for d in stat_did]),
    }

    # ---- optional extra components ----
    pop_tif = RAW / "population.tif"
    if pop_tif.exists():
        import rasterio  # pip install rasterio
        with rasterio.open(pop_tif) as src:
            vals = np.array([v[0] for v in src.sample(zip(c_lon, c_lat))], dtype=float)
        vals = np.log1p(np.clip(vals, 0, None))
        comp["population"] = 100 * vals / (vals.max() or 1)
        print("  + population component")
    poi_file = RAW / "pois.geojson"
    if poi_file.exists():
        pois = gpd.read_file(poi_file).to_crs(4326)
        pi = np.floor(pois.geometry.y / CELL_DEG).astype(int)
        pj = np.floor(pois.geometry.x / CELL_DEG).astype(int)
        counts = {}
        for a, b in zip(pi, pj):
            counts[(a, b)] = counts.get((a, b), 0) + 1
        v = np.log1p([counts.get((a, b), 0) for a, b in cells])
        comp["poi"] = 100 * v / (v.max() or 1)
        print("  + POI component")

    fields = list(comp)
    rows = [[round(float(c_lat[k]), 3), round(float(c_lon[k]), 3), int(did[k])] +
            [int(round(float(comp[f][k]))) for f in fields] for k in range(len(cells))]
    write_json(dict(cell_deg=CELL_DEG, radius_km=RADIUS_KM, fields=fields, rows=rows),
               DATA / "grid.json")


if __name__ == "__main__":
    main()
