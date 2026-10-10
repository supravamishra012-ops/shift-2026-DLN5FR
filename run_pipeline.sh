#!/usr/bin/env bash
# Rebuild DRISHTI from the raw inputs in data/. Run from the repository root.
set -euo pipefail
mkdir -p build
python3 pipeline/01_build_road_graph.py
python3 pipeline/02_simplify_road_network.py
python3 pipeline/03_optimise_network.py
python3 pipeline/04_export_road_graph.py
python3 pipeline/05_build_site.py
echo "Done: open index.html"
