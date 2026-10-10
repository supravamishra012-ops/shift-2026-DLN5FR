# Supreme
A shared planning tool for **municipalities** and **e-mobility service providers** (shared e-bike, e-scooter and battery-swap operators) in India. Both sides walk the same four steps on the same map and finish with a pilot plan they can both sign: zones, fleet and swap stations, parking and land, battery take-back, who does what, and a 90-day timeline.

Named after the green number plates on Indian EVs.

The first three steps are data layers:

| # | Layer | Question it answers | Data |
|---|---|---|---|
| 1 | **EV adoption** | Which districts adopt EVs faster than other fuels? | VAHAN registrations per RTO, 2001–2024, assigned to district polygons |
| 2 | **Battery waste** | How many tonnes of end-of-life batteries will each district produce, and of which chemistry (NMC / LFP / lead-acid)? | Cohort model from Layer 1 + Prophet EV forecast, or your own table |
| 3 | **Micromobility index** | Which ~2.8 km grid cells are the best places to launch or pilot micromobility? | Grid score from demand, urban core, EV share, EV growth, battery loop (+ population, POIs if added) |

Step 4, **Make the plan**, turns the chosen grid cells into numbers for both sides (fleet, swap stations, revenue and payback for the operator; parking bays, land, petrol and CO₂ saved, battery collection points for the city) and exports the plan as text, Markdown or CSV.

**Live site:** `https://<your-github-username>.github.io/<repo-name>/` once GitHub Pages is on (see the guide).

## Quick start

```bash
# 1. look at the site locally (data/ is already built)
python -m http.server 8000
# open http://localhost:8000

# 2. rebuild the data after changing inputs or assumptions
pip install -r requirements.txt
./run_pipeline.sh
```

Full walkthrough, from an empty folder to a published GitHub Pages site: **[docs/GUIDE.md](docs/GUIDE.md)**.

## Repository layout

```
index.html                  page shell
css/style.css               all styling (light + dark)
js/config.js                team name, lens weights, plan assumptions, colours  <- edit this first
js/app.js                   map, four steps, charts, rankings, pilot plan builder
vendor/                     Leaflet 1.9.4 and Chart.js 4.4.1 (no CDN needed)
data/                       processed JSON the site loads (committed)
scripts/01_prepare_layer1.py      VAHAN + districts -> districts.geojson, rtos.json, forecast.json
scripts/02_prepare_layer2_waste.py battery waste model -> waste.json
scripts/03_build_grid_index.py    grid suitability components -> grid.json
config/battery_assumptions.json   Layer 2 assumptions (vehicle mix, pack sizes, chemistries, lifetimes)
raw/                        your input files (git-ignored; see raw/README.md)
```

## Data caveats

- VAHAN counts vehicles where they are registered (the RTO office), not where they are driven. 451 of 951 districts have no RTO office in the extract and appear grey in Layers 1–2.
- 2024 data runs to early December, so 2024 counts are slightly low; shares are still comparable.
- Layer 2 default numbers are an illustrative model. Replace `config/battery_assumptions.json` or drop in `raw/layer2_waste.csv`.
- Layer 3 is a screening index. Add population and points of interest to sharpen it before using it for real siting.
