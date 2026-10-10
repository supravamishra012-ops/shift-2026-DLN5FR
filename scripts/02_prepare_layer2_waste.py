"""
LAYER 2 - End-of-life (EOL) EV battery waste and its chemistry, by district.

Two modes:
  A) YOUR DATA  - if raw/layer2_waste.csv exists, it is used directly.
                  Required columns: district, state, year, chemistry, tonnes
                  (chemistry e.g. NMC / LFP / Lead-acid). Names are matched to the
                  district boundary file (case-insensitive).
  B) MODEL      - otherwise a transparent cohort model is run:
        EV registrations per district per year (VAHAN, Layer 1, 2010-2024)
      + future EV registrations 2025-2035 = district's share of India's EVs (2022-24)
                                            x national Prophet EV forecast
      -> split into vehicle types and battery chemistries (config/battery_assumptions.json)
      -> each pack retires after its battery life (normal distribution around the mean),
         with replacement packs during the vehicle's life
      -> retired kWh per district / year / chemistry  (tonnes + materials computed in the browser)

Output: data/waste.json
"""
import json
import math

import numpy as np
import pandas as pd

from common import RAW, DATA, CONFIG, write_json, clean_name

OUT_YEARS = list(range(2020, 2036))


def retirement_kernel(life, sd_frac, vehicle_life, horizon=40):
    """Probability that a pack bought in year 0 retires in year k (k=0..horizon).
    Includes replacement packs: packs retire at life, 2*life, ... until the vehicle is scrapped."""
    k = np.arange(horizon + 1)
    w = np.zeros(horizon + 1)
    n = 1
    while True:
        mean = min(n * life, vehicle_life)
        sd = max(sd_frac * mean, 0.5)
        pdf = np.exp(-0.5 * ((k - mean) / sd) ** 2)
        w += pdf / pdf.sum()
        if n * life >= vehicle_life:
            break
        n += 1
    return w  # sum = number of packs per vehicle


def model_waste(cfg):
    gj = json.load(open(DATA / "districts.geojson"))
    years = gj["years"]
    forecast = json.load(open(DATA / "forecast.json"))["national"]["EV"]

    hist = {f["properties"]["did"]: dict(zip(years, f["properties"]["series"]["EV"]))
            for f in gj["features"] if f["properties"]["has_data"]}

    # each district's share of India's EV registrations, 2022-2024
    recent = {d: sum(h.get(y, 0) for y in (2022, 2023, 2024)) for d, h in hist.items()}
    nat_recent = sum(recent.values()) or 1
    f0, f1 = cfg["forecast_years"]

    # kWh per registered EV, by chemistry (fleet-mix weighted)
    kwh_per_ev = {}
    for vt, share in cfg["vehicle_mix"].items():
        for chem, cs in cfg["chemistry_share"][vt].items():
            kwh_per_ev[chem] = kwh_per_ev.get(chem, 0) + share * cs * cfg["pack_kwh"][vt]

    kernels = {c: retirement_kernel(cfg["battery_life_years"][c], cfg["life_sd_fraction"],
                                    cfg["vehicle_life_years"]) for c in kwh_per_ev}

    out = {}
    for d, h in hist.items():
        regs = dict(h)
        for y in range(f0, f1 + 1):
            regs[y] = forecast.get(str(y), 0) * recent[d] / nat_recent
        per_chem = {}
        for chem, kpe in kwh_per_ev.items():
            ker = kernels[chem]
            arr = []
            for Y in OUT_YEARS:
                kwh = sum(n * kpe * ker[Y - y] for y, n in regs.items() if 0 <= Y - y < len(ker))
                arr.append(round(kwh, 1))
            per_chem[chem] = arr
        out[str(d)] = dict(kwh=per_chem, ev_future_2030=round(regs.get(2030, 0)))
    return out, "model"


def load_user_table(path):
    """Mode A: user-supplied district waste table (tonnes)."""
    gj = json.load(open(DATA / "districts.geojson"))
    key = {(f["properties"]["district"].lower(), f["properties"]["state"].lower()): f["properties"]["did"]
           for f in gj["features"]}
    by_name = {f["properties"]["district"].lower(): f["properties"]["did"] for f in gj["features"]}
    cfg = json.load(open(CONFIG / "battery_assumptions.json"))
    t = pd.read_csv(path)
    out, missed = {}, set()
    for _, r in t.iterrows():
        dn, sn = clean_name(r["district"]).lower(), clean_name(r.get("state", "")).lower()
        did = key.get((dn, sn), by_name.get(dn))
        if did is None:
            missed.add(r["district"]); continue
        if int(r["year"]) not in OUT_YEARS:
            continue
        chem = str(r["chemistry"])
        kg_per_kwh = cfg["pack_kg_per_kwh"].get(chem, 7.0)
        slot = out.setdefault(str(did), dict(kwh={}))["kwh"].setdefault(chem, [0.0] * len(OUT_YEARS))
        slot[OUT_YEARS.index(int(r["year"]))] += float(r["tonnes"]) * 1000 / kg_per_kwh  # store as kWh
    if missed:
        print(f"  WARNING: {len(missed)} district names not matched, e.g. {sorted(missed)[:5]}")
    return out, "user"


def main():
    print("Layer 2: battery waste ...")
    cfg = json.load(open(CONFIG / "battery_assumptions.json"))
    user = RAW / "layer2_waste.csv"
    districts, mode = load_user_table(user) if user.exists() else model_waste(cfg)
    chems = sorted({c for v in districts.values() for c in v["kwh"]})
    write_json(dict(mode=mode, years=OUT_YEARS, chemistries=chems,
                    pack_kg_per_kwh=cfg["pack_kg_per_kwh"],
                    material_kg_per_kwh=cfg["material_kg_per_kwh"],
                    districts=districts), DATA / "waste.json")
    # quick national check
    kg = cfg["pack_kg_per_kwh"]
    for Y in (2025, 2030, 2035):
        i = OUT_YEARS.index(Y)
        t = sum(v["kwh"][c][i] * kg.get(c, 7) for v in districts.values() for c in v["kwh"]) / 1000
        print(f"  India EOL battery mass {Y}: {t:,.0f} t  (mode={mode})")


if __name__ == "__main__":
    main()
