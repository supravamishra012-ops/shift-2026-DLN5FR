"""
LAYER 1 - EV adoption vs other fuel types, by district.

Inputs  (raw/):
  Clustering_analysis_Master_fuel.csv       VAHAN monthly registrations per RTO x fuel
  DISTRICT_BOUNDARY.shp (+ .dbf .prj ...)   district polygons (LCC projection)
  prophet_prediction_data_*.xlsx            Prophet forecasts (national + per cluster)

Outputs (data/):
  districts.geojson     simplified polygons + per-district fuel stats
  rtos.json             RTO points (for the map + Layer 3)
  forecast.json         yearly Prophet forecasts (national and per cluster)
  summary.json          national headline numbers

Method: each RTO office is a point (RTO_Lat/RTO_Long). It is assigned to the district
polygon it falls in (nearest district if it sits just outside a coastline).
Registrations are summed per district and fuel group.
"""
import numpy as np
import pandas as pd
import geopandas as gpd

from common import (FUEL_CSV, DISTRICT_SHP, PROPHET_CLUSTERED, PROPHET_UNCLUSTERED,
                    DATA, FUEL_GROUPS, GROUP_ORDER, YEARS, clean_name, write_json)

LCC = None  # filled from the shapefile CRS


def load_districts():
    g = gpd.read_file(DISTRICT_SHP)
    g = g[g.geometry.notna() & ~g.geometry.is_empty].copy()
    g["district"] = g["DISTRICT"].map(clean_name)
    g["state"] = g["STATE_UT"].map(clean_name)
    g["did"] = np.arange(len(g))  # stable id used by the website
    g["area_km2"] = (g.geometry.area / 1e6).round(1)
    return g[["did", "district", "state", "Dist_LGD", "area_km2", "geometry"]]


def load_vahan():
    df = pd.read_csv(FUEL_CSV, encoding="utf-8-sig", low_memory=False, thousands=",")
    month_cols = [c for c in df.columns if c[:4].isdigit() and "_" in c]
    df[month_cols] = df[month_cols].apply(pd.to_numeric, errors="coerce").fillna(0)
    # monthly -> yearly (built in one go to keep pandas fast)
    years = sorted({int(c[:4]) for c in month_cols})
    yearly = pd.DataFrame({f"y{y}": df[[c for c in month_cols if c.startswith(f"{y}_")]].sum(axis=1)
                           for y in years})
    base = df[["State", "Rto_name", "RTO_Code", "Cluster", "RTO_Lat", "RTO_Long", "Fuel"]].copy()
    base["group"] = base["Fuel"].map(FUEL_GROUPS).fillna("Other")
    return pd.concat([base, yearly], axis=1), years


def main():
    print("Layer 1: loading data ...")
    dist = load_districts()
    vahan, all_years = load_vahan()

    # ---- RTO points -> district (spatial join) ----
    rto = (vahan.groupby("RTO_Code")
           .agg(name=("Rto_name", "first"), state=("State", "first"),
                cluster=("Cluster", "first"), lat=("RTO_Lat", "first"), lon=("RTO_Long", "first"))
           .reset_index())
    pts = gpd.GeoDataFrame(rto, geometry=gpd.points_from_xy(rto.lon, rto.lat), crs=4326).to_crs(dist.crs)
    joined = gpd.sjoin_nearest(pts, dist[["did", "geometry"]], how="left", max_distance=50_000,
                               distance_col="dist_m")
    joined = joined.drop_duplicates("RTO_Code")
    rto = rto.merge(joined[["RTO_Code", "did"]], on="RTO_Code", how="left")
    print(f"  RTOs: {len(rto)}, matched to a district: {rto.did.notna().sum()}")

    v = vahan.merge(rto[["RTO_Code", "did"]], on="RTO_Code", how="inner").dropna(subset=["did"])
    v["did"] = v["did"].astype(int)
    ycols = [f"y{y}" for y in all_years]

    # ---- district x group x year totals ----
    agg = v.groupby(["did", "group"])[ycols].sum()
    stats = {}
    for did, sub in agg.groupby(level=0):
        sub = sub.droplevel(0)
        series = {grp: [int(sub.loc[grp, f"y{y}"]) if grp in sub.index else 0 for y in YEARS]
                  for grp in GROUP_ORDER}
        tot_by_year = np.sum([series[g] for g in GROUP_ORDER], axis=0)
        ev = np.array(series["EV"])
        last = YEARS.index(2024)
        ev24, tot24 = ev[last], tot_by_year[last]
        ev20 = ev[YEARS.index(2020)]
        cagr = ((ev24 / ev20) ** (1 / 4) - 1) * 100 if ev20 > 0 and ev24 > 0 else None
        cum_ev = int(sub.loc["EV", ycols].sum()) if "EV" in sub.index else 0
        cum_tot = int(sub[ycols].sum().sum())
        stats[did] = dict(
            series=series,
            ev_2024=int(ev24), total_2024=int(tot24),
            ev_share_2024=round(100 * ev24 / tot24, 2) if tot24 else None,
            ev_share_3y=round(100 * ev[-3:].sum() / tot_by_year[-3:].sum(), 2) if tot_by_year[-3:].sum() else None,
            ev_cagr_20_24=round(cagr, 1) if cagr is not None else None,
            ev_cum=cum_ev, total_cum=cum_tot,
            dominant_fuel=max(GROUP_ORDER, key=lambda g: series[g][last]),
            n_rto=int((rto.did == did).sum()),
            rto_codes=sorted(rto.loc[rto.did == did, "RTO_Code"].astype(str).tolist())[:6],
            cluster=int(rto.loc[rto.did == did, "cluster"].mode().iloc[0]),
        )

    # national EV share for the location quotient (EV share relative to India)
    nat_ev = sum(s["ev_2024"] for s in stats.values())
    nat_tot = sum(s["total_2024"] for s in stats.values())
    nat_share = 100 * nat_ev / nat_tot
    shares = pd.Series({d: s["ev_share_2024"] for d, s in stats.items()}).dropna()
    pct = shares.rank(pct=True)
    for d, s in stats.items():
        s["ev_lq"] = round(s["ev_share_2024"] / nat_share, 2) if s["ev_share_2024"] is not None else None
        s["ev_share_pctile"] = round(float(pct.get(d, np.nan)) * 100, 1) if d in pct else None

    # ---- write districts.geojson (simplified, WGS84) ----
    out = dist.to_crs(4326).copy()
    out["geometry"] = out.geometry.simplify(0.006, preserve_topology=True)
    feats = []
    for _, r in out.iterrows():
        s = stats.get(r.did, {})
        props = dict(did=int(r.did), district=r.district, state=r.state, lgd=str(r.Dist_LGD),
                     area_km2=float(r.area_km2), has_data=bool(s))
        props.update(s)
        feats.append(dict(type="Feature", properties=props,
                          geometry=_round_geom(r.geometry.__geo_interface__)))
    write_json(dict(type="FeatureCollection", years=YEARS, groups=GROUP_ORDER, features=feats),
               DATA / "districts.geojson")

    # ---- RTO points ----
    rto_tot = v.groupby("RTO_Code")[[f"y{y}" for y in (2022, 2023, 2024)]].sum().sum(axis=1)
    rto_ev = v[v.group == "EV"].groupby("RTO_Code")[[f"y{y}" for y in (2022, 2023, 2024)]].sum().sum(axis=1)
    rto["reg_22_24"] = rto.RTO_Code.map(rto_tot).fillna(0).astype(int)
    rto["ev_22_24"] = rto.RTO_Code.map(rto_ev).fillna(0).astype(int)
    rto_out = [dict(code=r.RTO_Code, name=r["name"], state=r.state, cluster=int(r.cluster),
                    lat=round(r.lat, 5), lon=round(r.lon, 5),
                    did=None if pd.isna(r.did) else int(r.did), reg=int(r.reg_22_24), ev=int(r.ev_22_24))
               for _, r in rto.iterrows()]
    write_json(rto_out, DATA / "rtos.json")

    # ---- Prophet forecasts -> yearly ----
    write_json(load_forecasts(), DATA / "forecast.json")

    # ---- national summary ----
    nat_series = {g: np.sum([s["series"][g] for s in stats.values()], axis=0).astype(int).tolist()
                  for g in GROUP_ORDER}
    write_json(dict(years=YEARS, series=nat_series, ev_share_2024=round(nat_share, 2),
                    ev_2024=int(nat_ev), total_2024=int(nat_tot),
                    n_districts=len(out), n_districts_with_data=len(stats), n_rto=len(rto)),
               DATA / "summary.json")
    print(f"  National EV share 2024: {nat_share:.2f}%")


def load_forecasts():
    """Prophet monthly forecasts -> yearly sums."""
    un = pd.read_excel(PROPHET_UNCLUSTERED, sheet_name=0)
    date_cols = [c for c in un.columns if hasattr(c, "year")]
    national = {}
    for _, r in un.iterrows():
        s = pd.Series(r[date_cols].values.astype(float), index=[c.year for c in date_cols])
        national[str(r["Fuel_Type"]).upper()] = {int(y): round(float(v)) for y, v in s.groupby(level=0).sum().items()}

    cl = pd.read_excel(PROPHET_CLUSTERED, sheet_name=0)
    date_cols = [c for c in cl.columns if hasattr(c, "year")]
    clusters = {}
    for _, r in cl.iterrows():
        s = pd.Series(r[date_cols].values.astype(float), index=[c.year for c in date_cols])
        yearly = s.groupby(level=0).sum().clip(lower=0)  # negative forecasts -> 0
        clusters.setdefault(str(int(r["Cluster"])), {})[str(r["Fuel_Type"]).upper()] = \
            {int(y): round(float(v)) for y, v in yearly.items()}
    return dict(national=national, clusters=clusters,
                note="Prophet forecasts, monthly values summed per calendar year; negatives clipped to 0.")


def _round_geom(g, nd=4):
    def rc(c):
        if isinstance(c[0], (float, int)):
            return [round(c[0], nd), round(c[1], nd)]
        return [rc(x) for x in c]
    return dict(type=g["type"], coordinates=rc(g["coordinates"]))


if __name__ == "__main__":
    main()
