# Input data

Place these files here before running `run_pipeline.sh`. They are not committed (see `.gitignore`).

| File | Contents |
|---|---|
| `grid.csv` | Hex-grid attributes with corrected UMVI (one row per `Grid_ID`) |
| `grid.gpkg` | Hex-grid geometry, EPSG:32643, with `Grid_ID` |
| `roads.gpkg` | OpenStreetMap road network, EPSG:32643, fields `highway`, `Length_m`, `Stress` (`low`/`high`) |
