"""Shared paths and helpers for the data pipeline."""
import json
import os
from pathlib import Path

# GDAL can rebuild a missing .shx index file on the fly
os.environ.setdefault("SHAPE_RESTORE_SHX", "YES")

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "raw"
DATA = ROOT / "data"
CONFIG = ROOT / "config"
DATA.mkdir(exist_ok=True)

FUEL_CSV = RAW / "Clustering_analysis_Master_fuel.csv"
DISTRICT_SHP = RAW / "DISTRICT_BOUNDARY.shp"
PROPHET_CLUSTERED = RAW / "prophet_prediction_data_Clustered.xlsx"
PROPHET_UNCLUSTERED = RAW / "prophet_prediction_data_Unclustered.xlsx"

# VAHAN fuel labels -> dashboard fuel groups
FUEL_GROUPS = {
    "PURE EV": "EV",
    "ELECTRIC(BOV)": "EV",
    "STRONG HYBRID EV": "Hybrid",
    "PLUG-IN HYBRID EV": "Hybrid",
    "PETROL/HYBRID": "Hybrid",
    "DIESEL/HYBRID": "Hybrid",
    "PETROL": "Petrol",
    "PETROL/ETHANOL": "Petrol",
    "DIESEL": "Diesel",
    "CNG ONLY": "CNG/LPG",
    "PETROL/CNG": "CNG/LPG",
    "LPG ONLY": "CNG/LPG",
    "PETROL/LPG": "CNG/LPG",
    "NOT APPLICABLE": "Other",
}
GROUP_ORDER = ["EV", "Hybrid", "Petrol", "Diesel", "CNG/LPG", "Other"]

YEARS = list(range(2010, 2025))  # history kept for charts


def clean_name(s):
    """Fix the shapefile's broken diacritics (ā ī ū were saved as < > | \\ # @) and title-case."""
    if s is None or (isinstance(s, float)):
        return ""
    s = str(s).strip()
    for bad, good in {"<": "a", ">": "a", "|": "i", "\\": "i", "#": "u", "@": "u", "_": "-"}.items():
        s = s.replace(bad, good)
    return " ".join(w.capitalize() for w in s.lower().split())


def write_json(obj, path, **kw):
    path = Path(path)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False, **kw)
    print(f"  wrote {path.relative_to(ROOT)}  ({path.stat().st_size/1e6:.2f} MB)")
