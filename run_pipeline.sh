#!/usr/bin/env bash
# Rebuild every file in data/ from the raw inputs in raw/
set -euo pipefail
cd "$(dirname "$0")"
python scripts/01_prepare_layer1.py
python scripts/02_prepare_layer2_waste.py
python scripts/03_build_grid_index.py
echo "Done. Start a local server with:  python -m http.server 8000"
