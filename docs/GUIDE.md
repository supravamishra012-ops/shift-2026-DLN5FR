# Step-by-step guide: build and publish Green Plate

This guide takes you from the raw hackathon data to a live website on GitHub Pages.
Every command is copy-paste ready. Windows users: run the commands in **Git Bash** (installed with Git), or replace `./run_pipeline.sh` with the three `python scripts/...` lines.

**Contents**

1. What you are building
2. Install the tools
3. Create the GitHub repository
4. Put the project files and raw data in place
5. Set up Python
6. Layer 1: EV adoption vs other fuels
7. Layer 2: battery waste and chemistry
8. Layer 3: grid-scale micromobility index
9. The website code
9b. Step 4: the pilot plan (how both sides take it from here)
9c. Make it yours
10. Run it locally
11. Merge your half-built website
12. Commit and push to GitHub
13. Publish with GitHub Pages
14. Working as a team
15. Troubleshooting
16. Demo script for judges

---

## 1. What you are building

```
raw data (VAHAN CSV, district shapefile, Prophet xlsx)
        │
        ▼  Python scripts (run on your laptop)
data/*.json  (small, processed files, committed to git)
        │
        ▼  static website: HTML + CSS + JavaScript (Leaflet map, Chart.js charts)
GitHub Pages  →  https://<user>.github.io/<repo>/
```

There is no server or database. GitHub Pages serves the files as-is, which is free and fast and cannot break during a demo.

The site is a four-step journey. Both users walk the same four steps and see the same map; at every step the rail shows a note **for the city** and a note **for the operator** side by side.

| Step | Question | City takes away | Operator takes away |
|---|---|---|---|
| 1 | Where are EVs catching on? | EV baseline for policy targets, RTO to ask for monthly data | Where riders already trust electric, and where growth is heading |
| 2 | Where will old batteries pile up? | How many collection points, where, by which year | Lithium-ion volumes for take-back and second-life swap storage |
| 3 | Where to start? | City-lens score: population, battery loop, EV share | Operator-lens score: vehicle activity, town centres. Default view = cells **both** rank highly |
| 4 | Make the plan | Parking bays, land, petrol and CO₂ saved, collection points | Fleet, swap stations, rides, revenue, upfront cost, payback |

Step 4 ends with a **who does what** split, a **90-day timeline** and a plan you can copy or download and send to the other side. That is the "how do they take it from here" part.

---

## 2. Install the tools

| Tool | Why | Get it |
|---|---|---|
| Git | version control, push to GitHub | https://git-scm.com/downloads |
| Python 3.10+ | data pipeline | https://www.python.org/downloads/ (tick "Add to PATH" on Windows) |
| VS Code | editor | https://code.visualstudio.com/ |
| GitHub account | hosting | https://github.com/ |

Check:

```bash
git --version
python --version      # or python3 --version
```

Tell git who you are (once per computer):

```bash
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"
```

---

## 3. Create the GitHub repository

1. Go to https://github.com/new
2. Repository name: `ev-micromobility-atlas` (any name works; it becomes part of the URL)
3. Public (GitHub Pages is free for public repos)
4. **Do not** tick "Add a README" (the project already has one)
5. Click **Create repository** and keep the page open; you need the URL `https://github.com/<user>/ev-micromobility-atlas.git`

If your team already has a repo with the half-built site, skip this and see step 11.

---

## 4. Put the project files and raw data in place

Unzip `ev-micromobility-atlas.zip` somewhere convenient, then:

```bash
cd ev-micromobility-atlas
ls
# README.md  index.html  css/  js/  vendor/  data/  scripts/  config/  raw/  docs/ ...
```

Copy your raw files into `raw/` with exactly these names:

```
raw/Clustering_analysis_Master_fuel.csv
raw/DISTRICT_BOUNDARY.shp
raw/DISTRICT_BOUNDARY.dbf
raw/DISTRICT_BOUNDARY.prj
raw/DISTRICT_BOUNDARY.cpg
raw/prophet_prediction_data_Clustered.xlsx
raw/prophet_prediction_data_Unclustered.xlsx
```

`raw/` is in `.gitignore`. The shapefile is 175 MB and GitHub rejects files over 100 MB, so raw data stays on your laptops (share it via Google Drive). The site only needs `data/`, which is about 5 MB.

> The zip already contains a built `data/` folder, so you can jump to step 10 to see the site straight away.

---

## 5. Set up Python

```bash
python -m venv .venv
# macOS / Linux
source .venv/bin/activate
# Windows (Git Bash)
source .venv/Scripts/activate

pip install -r requirements.txt
```

`geopandas` sometimes fails to install with pip on Windows. If it does, install Miniconda and run `conda install -c conda-forge geopandas openpyxl`.

Build everything:

```bash
./run_pipeline.sh
```

Expected output:

```
Layer 1: loading data ...
  RTOs: 1324, matched to a district: 1324
  wrote data/districts.geojson  (2.47 MB)
  ...
  National EV share 2024: 7.17%
Layer 2: battery waste ...
  India EOL battery mass 2030: 201,474 t  (mode=model)
Layer 3: grid suitability index ...
  cells kept (on land, within 15 km of an RTO): 64,891
```

---

## 6. Layer 1: EV adoption vs other fuels

**File:** `scripts/01_prepare_layer1.py`

### 6.1 Group the 14 VAHAN fuel labels

`scripts/common.py` maps VAHAN labels to six groups:

```python
FUEL_GROUPS = {
    "PURE EV": "EV", "ELECTRIC(BOV)": "EV",
    "STRONG HYBRID EV": "Hybrid", "PLUG-IN HYBRID EV": "Hybrid",
    "PETROL/HYBRID": "Hybrid", "DIESEL/HYBRID": "Hybrid",
    "PETROL": "Petrol", "PETROL/ETHANOL": "Petrol",
    "DIESEL": "Diesel",
    "CNG ONLY": "CNG/LPG", "PETROL/CNG": "CNG/LPG", "LPG ONLY": "CNG/LPG", "PETROL/LPG": "CNG/LPG",
    "NOT APPLICABLE": "Other",
}
```

### 6.2 Read the CSV correctly

The CSV has two quirks: a byte-order mark before `State`, and numbers like `"1,019"` with thousands commas.

```python
df = pd.read_csv(FUEL_CSV, encoding="utf-8-sig", low_memory=False, thousands=",")
```

Monthly columns (`2023_january` …) are summed into yearly columns `y2001 … y2024`.

### 6.3 Put each RTO into a district (spatial join)

Each RTO has a lat/long. The shapefile is in a Lambert Conformal Conic projection (metres), so points are projected into it, then matched to the polygon they fall in. RTOs on a coastline that land just outside a polygon go to the nearest district within 50 km.

```python
pts = gpd.GeoDataFrame(rto, geometry=gpd.points_from_xy(rto.lon, rto.lat), crs=4326).to_crs(dist.crs)
joined = gpd.sjoin_nearest(pts, dist[["did", "geometry"]], how="left",
                           max_distance=50_000, distance_col="dist_m")
```

The shapefile has no `.shx` index file. `common.py` sets `SHAPE_RESTORE_SHX=YES`, so GDAL rebuilds it on the fly.

District names in the shapefile have broken accents (`H<ssan`, `Bengal#ru`, `B|rbh@m`). `clean_name()` repairs them to `Hassan`, `Bengaluru`, `Birbhum`.

### 6.4 Metrics per district

| Field | Meaning |
|---|---|
| `ev_share_2024` | EV ÷ all registrations in 2024, % |
| `ev_share_3y` | same for 2022–2024 combined |
| `ev_2024` | EVs registered in 2024 |
| `ev_cagr_20_24` | compound annual growth of EV registrations 2020→2024 |
| `ev_lq` | location quotient: district EV share ÷ India EV share (1.0 = national average) |
| `series` | yearly registrations 2010–2024 for each fuel group (for the chart) |
| `cluster` | the RTO cluster from your clustering analysis (links to the Prophet cluster forecast) |

### 6.5 Outputs

| File | Used for |
|---|---|
| `data/districts.geojson` | map polygons (simplified to ~1 km detail) with all metrics in `properties` |
| `data/rtos.json` | RTO points with 2022–24 registrations (input to Layer 3) |
| `data/forecast.json` | Prophet forecasts summed per year (national and per cluster) |
| `data/summary.json` | national headline numbers |

---

## 7. Layer 2: battery waste and chemistry

**Files:** `scripts/02_prepare_layer2_waste.py`, `config/battery_assumptions.json`

### 7.1 Option A: use your team's Layer 2 data

Save it as `raw/layer2_waste.csv` in this long format:

```csv
district,state,year,chemistry,tonnes
Pune,Maharashtra,2025,NMC,412.5
Pune,Maharashtra,2025,LFP,288.0
Pune,Maharashtra,2025,Lead-acid,950.2
...
```

Use the chemistry names `NMC`, `LFP`, `Lead-acid` (others work too; they get a default 7 kg/kWh). Run `python scripts/02_prepare_layer2_waste.py`. The script prints any district names it could not match so you can fix spelling.

### 7.2 Option B: the built-in model (default)

For every district:

1. **Past EVs**: EV registrations per year 2010–2024 from Layer 1.
2. **Future EVs**: district share of India's EVs in 2022–24 × national Prophet EV forecast, 2025–2035.
3. **Battery energy per EV**: vehicle mix × pack size × chemistry split, from the config:

   ```json
   "vehicle_mix": {"e2W": 0.56, "e3W": 0.37, "e4W": 0.06, "eBus/Other": 0.01},
   "pack_kwh":    {"e2W": 2.5,  "e3W": 5.0,  "e4W": 30.0, "eBus/Other": 150.0},
   "chemistry_share": { "e2W": {"NMC": 0.6, "LFP": 0.4}, ... }
   ```

4. **Retirement**: each pack retires after its service life (NMC 6 y, LFP 8 y, lead-acid 2 y), spread as a normal curve (±25 %). Lead-acid packs in e-rickshaws are replaced several times during the vehicle's 8-year life, which is why lead-acid dominates the tonnage.
5. **Materials**: retired kWh × kg of each material per kWh (lithium, nickel, cobalt, manganese, graphite, copper, aluminium, iron, phosphorus, lead).

The script stores retired **kWh** per chemistry per year; the browser converts to tonnes and materials, so the site and the config always agree.

**All the numbers in `battery_assumptions.json` are illustrative defaults.** Replace them with figures your team can cite (for example the vehicle-category split from the VAHAN dashboard), re-run the script, and the map updates.

---

## 8. Layer 3: grid-scale micromobility index

**File:** `scripts/03_build_grid_index.py`

### 8.1 The grid

India is cut into squares of `CELL_DEG = 0.025` degrees (about 2.8 km). Only cells on land within `RADIUS_KM = 15` km of an RTO are kept: 64,891 cells, 2.2 MB.

To go finer for one city, change the constants at the top of the script, for example `CELL_DEG = 0.005` (about 550 m) and filter the RTO list to that city's state before building. Keep the output under ~10 MB so the page stays quick.

### 8.2 Components (each scored 0–100)

| Component | How it is computed | Why it matters |
|---|---|---|
| `demand` | Σ registrations of nearby RTOs × Gaussian distance weight (σ = 5 km), log-scaled | where vehicles (and trips) concentrate |
| `urban` | 1 − distance to nearest RTO ÷ 15 km | RTOs sit in town centres |
| `ev_share` | district EV share percentile (Layer 1) | riders already open to EVs |
| `ev_growth` | district EV CAGR percentile (Layer 1) | momentum |
| `circular` | district Li-ion end-of-life kWh in 2030, percentile (Layer 2) | where swap, second-life and recycling hubs pay off |
| `population` *(optional)* | population raster sampled at cell centre | residents |
| `poi` *(optional)* | count of trip anchors per cell | metro/bus stations, colleges, markets, offices |

Weights are **not** fixed in Python. The website scores every cell twice, once with the city lens and once with the operator lens (`lenses` in `js/config.js`), and users can move the sliders. "Both agree" is the lower of the two scores, so a cell only ranks high if it works for both sides:

```
score = Σ (weight_i × component_i) / Σ weight_i
```

### 8.3 Make it sharper: population and points of interest

These two inputs turn the screening index into a credible siting tool.

**Population.** Download the India population count raster (1 km, latest year) from WorldPop (https://hub.worldpop.org/, search "India population count"). Save it as `raw/population.tif`, then:

```bash
pip install rasterio
python scripts/03_build_grid_index.py      # prints "+ population component"
```

**Points of interest.** Export from OpenStreetMap using https://overpass-turbo.eu/ for each target city. Example for Bengaluru:

```
[out:json][timeout:120];
area["name"="Bengaluru"]["boundary"="administrative"]->.a;
(
  node["railway"="station"](area.a);
  node["station"="subway"](area.a);
  node["amenity"~"bus_station|college|university|marketplace"](area.a);
  node["office"](area.a);
);
out center;
```

Click **Export → GeoJSON**, save as `raw/pois.geojson` (merge several cities into one file if needed), and re-run the script. A "Trip anchors" slider appears automatically on the site.

---

## 9. The website code

No framework and no build step. Four files matter:

| File | Role |
|---|---|
| `index.html` | page skeleton: top bar with the four steps, the rail, the map, the "Why we built this" intro |
| `css/style.css` | design tokens (colours, fonts) for light and dark mode, layout, phone layout under 900 px |
| `js/config.js` | **edit this first**: team name, lens weights, plan assumptions, colour ramps, basemap |
| `js/app.js` | all behaviour (sections below) |

`js/app.js` sections, top to bottom:

| Section | What it does |
|---|---|
| `load()` | fetches the five JSON files in parallel |
| `ADOPT`, `WASTE` | metric definitions for steps 1 and 2; add a metric by adding one line |
| `computeScores()` | city-lens, operator-lens and "both agree" (the lower of the two) score for every cell |
| `initMap()`, `GridCanvas` | Leaflet map, district polygons, and the grid drawn on canvas tiles (fast for 65k cells) |
| `renderRail()` | builds the left rail for the current step |
| `answerText()` | the one-sentence answer under each step's question, written from the data |
| `renderBoth()` | the side-by-side "For the city" / "For the operator" cards |
| `renderDetail()` | district card with charts: fuel mix, cluster forecast, chemistry stack, materials |
| `computePlan()`, `planHTML()`, `planText()` | step 4: numbers, on-page plan, and the exported text |
| `setStep()`, `selectDistrict()` | navigation; the plan and the intro choice are remembered in the browser |

**Add a Layer 1 metric** (example: diesel share):

```js
// in ADOPT, js/app.js
diesel_share: { label: "Diesel share, 2024", unit: "%", d: 1,
  get: (p) => p.has_data ? 100 * p.series.Diesel.at(-1) / p.total_2024 : null },
```

**Change lens weights:** edit `lenses` in `js/config.js`. The keys match the component names in section 8.2.

**Remove the background map** (for offline demos): set `basemap: null` in `js/config.js`.

Libraries are copied into `vendor/` (Leaflet 1.9.4, Chart.js 4.4.1), so the site works without CDNs.

---

## 9b. Step 4: the pilot plan

How it works, so you can explain it to judges and change it:

1. **Pick zones.** "Suggest 5 zones" takes the district's cells with the highest "both agree" score and skips cells that touch an already chosen one, so zones spread across the city. Users can also click any cell and press **Add to pilot plan** (up to 8). Zones are saved per district in the browser, so switching districts never loses work.
2. **Size each zone.** Vehicles in a zone = `vehiclesPerZone × score ÷ 100`, rounded to 5.
3. **Operator numbers.** Swap stations = fleet ÷ vehicles per station. Rides/day = fleet × rides per vehicle. Revenue/month = rides × 30 × fare. Upfront cost = fleet × vehicle cost + stations × station cost. Payback = upfront ÷ (revenue × operating margin).
4. **City numbers.** Bays = fleet ÷ vehicles per bay. Land = bays × bay area + stations × station land. Petrol saved = rides × 30 × trip km × share replacing petrol ÷ km per litre. CO₂ = litres × 2.31 kg. Collection points = district retired battery tonnes in 2030 ÷ tonnes per point.
5. **Who does what** and the **90-day timeline** are generated from the same numbers (for example "Approve 21 parking bays").
6. **Take it from here:** *Copy plan as text*, *Download plan (.md)*, *Download zones (.csv)*. The .md opens in any editor, pastes into Google Docs or an email, and lists every assumption at the bottom so the other side can challenge them.

All starting assumptions live in `js/config.js` under `plan:` and are editable on the page under **Adjust the assumptions**. Replace our defaults with numbers from a real operator or a city's parking policy before you present them as fact.

The responsibilities list is the `RESP` array and the timeline is `timeline()` in `js/app.js`. Edit the wording there to match your city.

---

## 9c. Make it yours

- **Team name and contact:** `team` block at the top of `js/config.js`. It appears in the header, the intro, and every exported plan.
- **Product name:** we called it *Green Plate* after the green number plates on Indian EVs (the logo is a plate). Change the `<title>` and `<h1>` in `index.html` if you prefer another name.
- **Intro text:** the "Why we built this" dialog is plain HTML in `index.html`. Rewrite the paragraph in your own words; one real anecdote from your team (a ward officer you spoke to, a ride that went wrong) is worth more than any statistic.
- **Lens weights:** `lenses` in `js/config.js`.
- **Colours and fonts:** tokens at the top of `css/style.css` (light and dark).

---

## 10. Run it locally

Browsers block `fetch()` from `file://`, so double-clicking `index.html` shows "Could not load data". Start a tiny server instead:

```bash
python -m http.server 8000
```

Open http://localhost:8000 and check:

- [ ] The "Why we built this" intro opens on first visit; picking a card closes it
- [ ] Step 1 shows green districts; clicking one fills both "For the city" and "For the operator" cards
- [ ] Step 2 year slider moves from 2020 to 2035 and the map recolours
- [ ] Step 3 shows purple cells; "Both agree / City lens / Operator lens" recolours them
- [ ] Step 3 with a district selected: **Use the top 5 as pilot zones** opens step 4 with Z1–Z5 on the map
- [ ] Step 4: changing an assumption updates the numbers; **Download plan** saves a .md file
- [ ] Narrow the window below 900 px: the map moves above the panel

VS Code alternative: install the **Live Server** extension and click "Go Live".

---

## 11. Merge your half-built website

Pick the case that fits:

**A. Your existing site is plain HTML/JS.** Copy these folders into it: `css/`, `js/`, `vendor/`, `data/`. Then either use this `index.html` as a new page (rename to `atlas.html` and link to it from your menu), or paste the `<header>`, `<div class="shell">…</div>` and the five `<script>` tags into your page. Keep the element ids (`map`, `controls`, `detail`, `rank`, `kpis`, …) because `app.js` looks them up.

**B. Your existing site is React / Vite / Next.js.** Put `data/` in `public/data/`. Add the map as a page that loads `vendor/leaflet.js`, `vendor/chart.umd.min.js`, `js/config.js`, `js/app.js` from `public/`, or embed the atlas with an `<iframe src="/atlas/index.html">` (copy the whole atlas into `public/atlas/`). The iframe route takes five minutes and is the safest choice in a hackathon.

**C. Start from this repo** and move your existing pages in as extra `.html` files.

---

## 12. Commit and push to GitHub

From the project folder:

```bash
git init
git add .
git status            # check: no raw/*.shp or .venv in the list
git commit -m "Green Plate: four-step planning site, data pipeline, guide"
git branch -M main
git remote add origin https://github.com/<user>/ev-micromobility-atlas.git
git push -u origin main
```

GitHub asks for a login the first time. Use your username and a **personal access token** as the password (https://github.com/settings/tokens → "Generate new token (classic)" → tick `repo`), or sign in with GitHub Desktop / VS Code which handles this for you.

Pushing into the team's existing repo instead:

```bash
git clone https://github.com/<org>/<existing-repo>.git
cd <existing-repo>
git checkout -b atlas
# copy the atlas files in (step 11)
git add .
git commit -m "Add Green Plate"
git push -u origin atlas
# open a Pull Request on GitHub and merge it
```

---

## 13. Publish with GitHub Pages

1. On GitHub open the repo → **Settings** → **Pages**
2. **Source:** "Deploy from a branch"
3. **Branch:** `main`, folder `/ (root)` → **Save**
4. Wait 1–2 minutes and refresh. The URL appears at the top: `https://<user>.github.io/ev-micromobility-atlas/`

Every `git push` to `main` redeploys automatically. The empty `.nojekyll` file tells Pages to serve files as they are.

Updating data later:

```bash
./run_pipeline.sh
git add data/
git commit -m "Refresh data"
git push
```

---

## 14. Working as a team

Suggested split for a 4-person team:

| Person | Owns | Files |
|---|---|---|
| Data 1 | Layer 1 + forecasts | `scripts/01_*`, `common.py` |
| Data 2 | Layer 2 waste numbers | `config/battery_assumptions.json`, `raw/layer2_waste.csv`, `scripts/02_*` |
| GIS | Layer 3 population + POIs | `scripts/03_*`, `raw/population.tif`, `raw/pois.geojson` |
| Front-end | UI, pitch | `index.html`, `css/`, `js/` |

Rules that avoid merge pain:

- Work on a branch per person: `git checkout -b layer2-data`
- `git pull` before you start, push small commits often
- Only the person running the pipeline commits `data/` (regenerated JSON conflicts are painful)

---

## 15. Troubleshooting

| Symptom | Fix |
|---|---|
| "Could not load data" on the page | you opened the file directly; run `python -m http.server 8000` |
| `Unable to open DISTRICT_BOUNDARY.shx` | run scripts through `common.py` imports (they set `SHAPE_RESTORE_SHX`), or `export SHAPE_RESTORE_SHX=YES` |
| `ValueError: could not convert string to float: '1,019'` | read the CSV with `thousands=","` (already done in the script) |
| `KeyError: 'State'` | the BOM; read with `encoding="utf-8-sig"` |
| `git push` rejected, file > 100 MB | a raw file slipped in. `git rm --cached raw/DISTRICT_BOUNDARY.shp`, commit, push |
| Pages shows 404 | wait 2 minutes; make sure `index.html` is at the repo root and Pages uses branch `main` / root |
| Map shows districts but no background | the basemap tile server is blocked on that network; the site still works |
| A district is grey | it has no RTO office in the VAHAN extract; its vehicles are counted in the neighbouring district |

---

## 16. Demo script for judges (3 minutes)

1. **Open with the problem** (the "Why we built this" dialog). Read the headline, then click **Show me both**: "Same map, same plan, for the city and the operator."
2. **Step 1.** "About 7 in every 100 new vehicles in India in 2024 were electric." Search Lucknow: 16.6%, 2.3× the national rate. Point at the two cards: the city gets a policy baseline, the operator gets proof riders trust EVs.
3. **Step 2.** Slide to 2030: "Lucknow retires about 2,500 tonnes of battery packs that year, mostly lead-acid from e-rickshaws." Show the city card (collection points) and the operator card (take-back under the Battery Waste Management Rules, 2022).
4. **Step 3.** Show "Both agree", then flip to City lens and Operator lens: "They want different things. The purple cells are where they overlap, and that is where permits move fastest." Click a cell to show the three scores.
5. **Step 4.** Press **Use the top 5 as pilot zones**. Walk through: about 200 vehicles, 5 swap stations, 21 parking bays, roughly 680 litres of petrol saved a month, payback near 4 years. Change the fare and watch it update. Press **Download plan**: "This is the document a commissioner and an operator can sign on Monday."
