# raw/ — input data (not committed)

Put these files here before running `./run_pipeline.sh`:

| File | Used by | Notes |
|---|---|---|
| `Clustering_analysis_Master_fuel.csv` | Layer 1 | VAHAN monthly registrations per RTO and fuel, with RTO lat/long and cluster |
| `DISTRICT_BOUNDARY.shp` + `.dbf` `.prj` `.cpg` (and `.shx` if you have it) | Layers 1–3 | District polygons. A missing `.shx` is rebuilt automatically. |
| `prophet_prediction_data_Unclustered.xlsx` | Layers 1–2 | National Prophet forecast by fuel |
| `prophet_prediction_data_Clustered.xlsx` | Layer 1 | Prophet forecast by fuel and RTO cluster |
| `layer2_waste.csv` *(optional)* | Layer 2 | Your own district battery-waste table: `district,state,year,chemistry,tonnes`. When present it replaces the model. |
| `population.tif` *(optional)* | Layer 3 | Population raster, e.g. WorldPop 1 km for India (needs `pip install rasterio`) |
| `pois.geojson` *(optional)* | Layer 3 | Trip anchors exported from OpenStreetMap: metro/bus stations, colleges, markets, offices |

These files are ignored by git. Only the processed `data/*.json` files are committed, which is all the website needs.
