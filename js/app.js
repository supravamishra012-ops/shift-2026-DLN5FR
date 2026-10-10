/* Green Plate: a four-step planning journey for cities and e-mobility operators.
   Static site (Leaflet + Chart.js). Data comes from data/*.json, built by scripts/0*_*.py */
(() => {
  "use strict";
  const CFG = window.ATLAS_CONFIG;
  const $ = (s, el = document) => el.querySelector(s);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (v, d = 0) => v == null || Number.isNaN(v) ? "–" :
    Number(v).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
  const big = (v) => v == null ? "–" : v >= 1e7 ? fmt(v / 1e7, 2) + " crore" : v >= 1e5 ? fmt(v / 1e5, 1) + " lakh" : fmt(v);
  const inr = (v) => "₹" + big(Math.round(v));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  };

  const STEPS = {
    1: { title: "Where EVs are catching on", layer: "adoption" },
    2: { title: "Where old batteries pile up", layer: "waste" },
    3: { title: "Where to start", layer: "grid" },
    4: { title: "Make the plan", layer: "grid" }
  };

  const state = {
    step: 1,
    focus: store.get("gp-focus", "both"),   // which notes come first: city | op | both
    adoptMetric: "ev_share_2024",
    wasteMetric: "total",
    wasteYear: 2030,
    lens: "joint",
    weights: { city: { ...CFG.lenses.city.weights }, operator: { ...CFG.lenses.operator.weights } },
    selected: null,
    plan: Object.assign({ did: null, zones: [], assume: { ...CFG.plan } }, store.get("gp-plan", {})),
    plans: store.get("gp-plans", {})   // zones saved per district, so switching districts never loses work
  };
  state.plan.assume = { ...CFG.plan, ...state.plan.assume };
  function usePlanFor(did) { state.plan.did = did; state.plan.zones = (state.plans[did] || []).slice(); }

  let D = {}, map, districtLayer, gridLayer, zoneLayer, charts = [];
  const byDid = new Map();

  /* ================================================================ data */
  async function load() {
    const get = (f) => fetch(`data/${f}`).then((r) => { if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.json(); });
    const [districts, summary, forecast, waste, grid] = await Promise.all(
      ["districts.geojson", "summary.json", "forecast.json", "waste.json", "grid.json"].map(get));
    D = { districts, summary, forecast, waste, grid };
    districts.features.forEach((f) => byDid.set(f.properties.did, f.properties));
    prepGrid();
  }
  const P = (did) => byDid.get(did);
  const plateOf = (p) => {
    if (!p.rto_codes || !p.rto_codes.length) return null;
    const c = [...p.rto_codes].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
    const m = c.match(/^([A-Z]+)(\d+)$/);
    return m ? `${m[1]} ${m[2].padStart(2, "0")}` : c;
  };

  /* ---- Layer 1 metrics ---- */
  const ADOPT = {
    ev_share_2024: { label: "EV share of new vehicles, 2024", unit: "%", d: 1, get: (p) => p.ev_share_2024 },
    ev_share_3y: { label: "EV share, 2022–24 average", unit: "%", d: 1, get: (p) => p.ev_share_3y },
    ev_2024: { label: "EVs registered in 2024", unit: "", d: 0, get: (p) => p.ev_2024 },
    ev_cagr_20_24: { label: "Yearly EV growth since 2020", unit: "%", d: 0, get: (p) => p.ev_cagr_20_24 },
    ev_lq: { label: "EV share compared with India", unit: "×", d: 2, get: (p) => p.ev_lq }
  };

  /* ---- Layer 2 ---- */
  const W = () => D.waste;
  function wasteValue(did, metric, year) {
    const w = W().districts[String(did)];
    if (!w) return null;
    const i = W().years.indexOf(year), kg = W().pack_kg_per_kwh, mat = W().material_kg_per_kwh;
    let t = 0;
    for (const [chem, arr] of Object.entries(w.kwh)) {
      const kwh = arr[i];
      if (metric === "total") t += kwh * (kg[chem] ?? 7) / 1000;
      else if (metric === "liion") { if (chem !== "Lead-acid") t += kwh * (kg[chem] ?? 7) / 1000; }
      else if (metric === "lead") { if (chem === "Lead-acid") t += kwh * kg[chem] / 1000; }
      else t += kwh * ((mat[chem] || {})[metric] || 0) / 1000;
    }
    return t;
  }
  const WASTE = {
    total: "All retired battery packs (t)",
    liion: "Lithium-ion packs (t)",
    lead: "Lead-acid packs (t)",
    Lithium: "Lithium inside them (t)",
    Cobalt: "Cobalt inside them (t)",
    Nickel: "Nickel inside them (t)"
  };
  const nationalWaste = (metric, year) => Object.keys(W().districts).reduce((a, d) => a + wasteValue(+d, metric, year), 0);

  /* ---- Layer 3 grid ---- */
  let G = null;
  function prepGrid() {
    const g = D.grid, cellIndex = new Map(), buckets = new Map();
    g.rows.forEach((r, k) => {
      cellIndex.set(Math.floor(r[0] / g.cell_deg) + "," + Math.floor(r[1] / g.cell_deg), k);
      const b = Math.floor(r[0]) + "," + Math.floor(r[1]);
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(k);
    });
    const n = g.rows.length;
    G = { fields: g.fields, rows: g.rows, step: g.cell_deg, cellIndex, buckets,
      city: new Float32Array(n), op: new Float32Array(n), joint: new Float32Array(n) };
    computeScores();
  }
  function weighted(arr, w) {
    const f = G.fields, ws = f.map((k) => w[k] ?? 0), sw = ws.reduce((a, b) => a + b, 0) || 1;
    G.rows.forEach((r, k) => { let s = 0; for (let q = 0; q < f.length; q++) s += ws[q] * r[3 + q]; arr[k] = s / sw; });
  }
  function computeScores() {
    weighted(G.city, state.weights.city);
    weighted(G.op, state.weights.operator);
    for (let k = 0; k < G.rows.length; k++) G.joint[k] = Math.min(G.city[k], G.op[k]);
    G.breaks = {};
    for (const l of ["city", "op", "joint"]) G.breaks[l] = quantileBreaks(Array.from(G[l]), 7);
    G.byDistrict = new Map();
    G.rows.forEach((r, k) => {
      const o = G.byDistrict.get(r[2]) || { n: 0, sum: 0, best: -1, bestK: k, both: 0, bestCity: -1, bestCityK: k, bestOp: -1, bestOpK: k };
      const j = G.joint[k];
      o.n++; o.sum += j;
      if (j > o.best) { o.best = j; o.bestK = k; }
      if (G.city[k] > o.bestCity) { o.bestCity = G.city[k]; o.bestCityK = k; }
      if (G.op[k] > o.bestOp) { o.bestOp = G.op[k]; o.bestOpK = k; }
      if (G.city[k] >= G.breaks.city[4] && G.op[k] >= G.breaks.op[4]) o.both++;
      G.byDistrict.set(r[2], o);
    });
    G.bothTotal = 0;
    G.byDistrict.forEach((o) => { G.bothTotal += o.both; });
  }
  const lensKey = () => state.lens === "operator" ? "op" : state.lens;
  const score = (k) => G[lensKey()][k];
  const cellKm2 = (lat) => (G.step * 111) * (G.step * 111 * Math.cos(lat * Math.PI / 180));

  function quantileBreaks(values, n) {
    const v = values.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
    if (!v.length) return [];
    const br = [];
    for (let k = 1; k < n; k++) br.push(v[Math.min(v.length - 1, Math.floor((k / n) * v.length))]);
    return br;
  }
  const classOf = (x, br) => { let i = 0; while (i < br.length && x > br[i]) i++; return i; };

  /* ================================================================ map */
  const layer = () => STEPS[state.step].layer;
  function districtValue(p) {
    if (layer() === "adoption") return p.has_data ? ADOPT[state.adoptMetric].get(p) : null;
    if (layer() === "waste") return wasteValue(p.did, state.wasteMetric, state.wasteYear);
    return null;
  }
  let breaks = [];
  const computeBreaks = () => { breaks = quantileBreaks(D.districts.features.map((f) => districtValue(f.properties)), 7); };

  function initMap() {
    map = L.map("map", { zoomSnap: 0.5, minZoom: 4, maxZoom: 14, preferCanvas: true }).fitBounds([[7.5, 68], [36.5, 97.5]]);
    const root = document.documentElement.dataset.theme;
    const dark = root === "dark" || (root !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    if (CFG.basemap) L.tileLayer(dark ? CFG.basemap.urlDark : CFG.basemap.url, { attribution: CFG.basemap.attribution, subdomains: "abcd", maxZoom: 19 }).addTo(map);
    map.createPane("gridPane").style.zIndex = 350;
    districtLayer = L.geoJSON(D.districts, {
      style: styleDistrict,
      onEachFeature: (f, lyr) => lyr.on({
        mousemove: (e) => showTip(e, f.properties),
        mouseout: hideTip,
        click: (e) => { if (layer() !== "grid") selectDistrict(f.properties.did, false); else gridClick(e.latlng, f.properties.did); }
      })
    }).addTo(map);
    zoneLayer = L.layerGroup().addTo(map);
    map.on("moveend", () => { if (layer() === "grid" && state.step === 3 && state.selected == null) renderRank(); });
    map.on("popupopen", (e) => {
      const b = e.popup.getElement().querySelector("[data-add]");
      if (b) b.onclick = () => { addZone(+b.dataset.add); map.closePopup(); };
    });
  }
  function styleDistrict(f) {
    const p = f.properties, sel = p.did === state.selected;
    if (layer() === "grid") return { color: sel ? css("--sel") : css("--ink-3"), weight: sel ? 2.4 : 0.4, fillOpacity: 0, opacity: sel ? 1 : 0.45 };
    const v = districtValue(p);
    return { fillColor: v == null ? css("--nodata") : CFG.ramps[layer()][classOf(v, breaks)], fillOpacity: v == null ? 0.55 : 0.9,
      color: sel ? css("--sel") : css("--poly-line"), weight: sel ? 2.6 : 0.5, opacity: 1 };
  }
  function restyle() {
    districtLayer.setStyle(styleDistrict);
    if (state.selected != null) districtLayer.eachLayer((l) => { if (l.feature.properties.did === state.selected) l.bringToFront(); });
  }

  const tip = $("#tip");
  function showTip(e, p) {
    let h = `<b>${esc(p.district)}</b> <small>${esc(p.state)}</small><br>`;
    if (layer() === "adoption") {
      const m = ADOPT[state.adoptMetric];
      h += p.has_data ? `${m.label}: <b class="num">${fmt(m.get(p), m.d)}${m.unit}</b>` : `<i>No RTO office here. Its vehicles are registered next door.</i>`;
    } else if (layer() === "waste") {
      const v = wasteValue(p.did, state.wasteMetric, state.wasteYear);
      h += v == null ? `<i>No EV registrations recorded here</i>` : `${WASTE[state.wasteMetric]}, ${state.wasteYear}: <b class="num">${fmt(v, v < 10 ? 1 : 0)}</b>`;
    } else {
      const s = G.byDistrict.get(p.did);
      h += s ? `${s.both} cells where city and operator agree` : `<i>No scored cells</i>`;
    }
    tip.innerHTML = h; tip.hidden = false;
    const r = $("#map").getBoundingClientRect();
    let x = e.originalEvent.clientX - r.left + 14; const y = e.originalEvent.clientY - r.top + 14;
    if (x + 270 > r.width) x -= 290;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  }
  function hideTip() { tip.hidden = true; }

  const GridCanvas = L.GridLayer.extend({
    createTile(coords) {
      const tile = document.createElement("canvas"), size = this.getTileSize();
      tile.width = size.x; tile.height = size.y;
      const ctx = tile.getContext("2d"), nwP = coords.scaleBy(size);
      const nw = map.unproject(nwP, coords.z), se = map.unproject(nwP.add(size), coords.z);
      const ramp = CFG.ramps.grid, st = G.step, arr = G[lensKey()], br = G.breaks[lensKey()], gap = coords.z >= 9 ? 1 : 0;
      for (let a = Math.floor(se.lat) - 1; a <= Math.floor(nw.lat); a++) {
        for (let b = Math.floor(nw.lng) - 1; b <= Math.floor(se.lng); b++) {
          const list = G.buckets.get(a + "," + b);
          if (!list) continue;
          for (const k of list) {
            const r = G.rows[k];
            const p1 = map.project([r[0] + st / 2, r[1] - st / 2], coords.z).subtract(nwP);
            const p2 = map.project([r[0] - st / 2, r[1] + st / 2], coords.z).subtract(nwP);
            if (p2.x < 0 || p2.y < 0 || p1.x > size.x || p1.y > size.y) continue;
            ctx.fillStyle = ramp[classOf(arr[k], br)];
            ctx.fillRect(p1.x, p1.y, Math.max(1, p2.x - p1.x - gap), Math.max(1, p2.y - p1.y - gap));
          }
        }
      }
      return tile;
    }
  });
  function showGrid(on) {
    if (on && !gridLayer) gridLayer = new GridCanvas({ pane: "gridPane", opacity: 0.85 }).addTo(map);
    if (!on && gridLayer) { map.removeLayer(gridLayer); gridLayer = null; }
  }
  const redrawGrid = () => { if (gridLayer) gridLayer.redraw(); };

  function cellPopup(k) {
    const r = G.rows[k], p = P(r[2]), inPlan = state.plan.zones.includes(k);
    const bars = G.fields.map((f, q) => `<div><span>${CFG.gridFields[f] || f}</span><i style="width:${r[3 + q]}%"></i><span>${r[3 + q]}</span></div>`).join("");
    return `<b>${esc(p.district)}</b> <small>${r[0].toFixed(3)}, ${r[1].toFixed(3)} · ${fmt(cellKm2(r[0]), 1)} km²</small>
      <div class="scores3">
        <div style="background:var(--city-soft)"><b>${fmt(G.city[k])}</b>City</div>
        <div style="background:var(--op-soft)"><b>${fmt(G.op[k])}</b>Operator</div>
        <div style="background:var(--plate-soft)"><b>${fmt(G.joint[k])}</b>Both agree</div>
      </div>
      <div class="comp-bars">${bars}</div>
      ${inPlan ? `<span class="note">Already in your plan</span>` : `<button type="button" class="btn solid small" data-add="${k}">Add to pilot plan</button>`}`;
  }
  function gridClick(latlng, did) {
    const k = G.cellIndex.get(Math.floor(latlng.lat / G.step) + "," + Math.floor(latlng.lng / G.step));
    if (k == null) { if (did != null && state.step !== 4) selectDistrict(did, false); return; }
    if (state.step !== 4 && state.selected !== G.rows[k][2]) selectDistrict(G.rows[k][2], false, true);
    L.popup().setLatLng([G.rows[k][0], G.rows[k][1]]).setContent(cellPopup(k)).openOn(map);
  }

  function drawZones() {
    zoneLayer.clearLayers();
    if (layer() !== "grid") return;
    const st = G.step;
    state.plan.zones.forEach((k, i) => {
      const r = G.rows[k];
      L.rectangle([[r[0] - st / 2, r[1] - st / 2], [r[0] + st / 2, r[1] + st / 2]], { color: css("--sel"), weight: 2.5, fill: false }).addTo(zoneLayer);
      L.marker([r[0] + st / 2, r[1] - st / 2], { icon: L.divIcon({ className: "zone-label", html: `Z${i + 1}`, iconSize: null, iconAnchor: [0, 16] }), interactive: false }).addTo(zoneLayer);
    });
  }

  /* ================================================================ rail */
  const rail = $("#rail");
  function destroyCharts() { charts.forEach((c) => c.destroy()); charts = []; }
  function chartDefaults() {
    Chart.defaults.font.family = css("--f-body") || "system-ui";
    Chart.defaults.font.size = 11.5;
    Chart.defaults.color = css("--ink-2");
    Chart.defaults.borderColor = css("--line");
  }

  function renderRail() {
    destroyCharts(); chartDefaults();
    rail.className = "rail focus-" + state.focus;
    const s = state.step;
    let html = `<section>
      <div class="eyebrow">Step ${s} of 4</div>
      <h2 class="q">${STEPS[s].title}</h2>
      <p class="answer" id="answer"></p>
      <div class="field"><label for="search">Pick a district</label>
        <input type="search" id="search" list="district-list" placeholder="Type a district, e.g. Lucknow" value="${state.selected != null ? esc(P(state.selected).district + ", " + P(state.selected).state) : ""}">
      </div></section>`;
    if (s === 4) html += planHTML();
    else {
      html += `<section id="controls"></section>
        <section><div class="eyebrow">What this means for you</div><div class="both" id="both"></div></section>
        <section id="detail"></section>
        <section><div class="eyebrow" id="rank-title"></div><ol class="rank" id="rank"></ol><div id="export-box"></div></section>`;
    }
    html += `<section class="row" style="justify-content:space-between">
        ${s > 1 ? `<button type="button" class="btn" data-go="${s - 1}">← ${STEPS[s - 1].title}</button>` : "<span></span>"}
        ${s < 4 ? `<button type="button" class="btn solid" data-go="${s + 1}">Next: ${STEPS[s + 1].title} →</button>` : ""}
      </section>
      <section><p class="note" id="method-note">${methodNote()}</p></section>`;
    rail.innerHTML = html;
    rail.querySelectorAll("[data-go]").forEach((b) => b.onclick = () => { setStep(+b.dataset.go); rail.scrollTop = 0; });
    wireSearch();
    $("#answer").innerHTML = answerText();
    if (s === 4) { wirePlan(); return; }
    renderControls(); renderBoth(); renderDetail(); renderRank();
  }

  /* ---- headline sentence per step ---- */
  function answerText() {
    const p = state.selected != null ? P(state.selected) : null;
    const nat = D.summary;
    if (state.step === 1) {
      if (!p) return `In 2024, about <b>${fmt(nat.ev_share_2024, 0)} in every 100</b> new vehicles registered in India were electric. In the leading districts it was more than 1 in 5. Darker green means further ahead.`;
      if (!p.has_data) return `<b>${esc(p.district)}</b> has no RTO office in the VAHAN data, so its vehicles are registered in a neighbouring district.`;
      const lq = p.ev_lq >= 1 ? `<b>${fmt(p.ev_lq, 1)}×</b> the national rate` : `below the national ${fmt(nat.ev_share_2024, 1)}%`;
      return `In <b>${esc(p.district)}</b>, <b>${fmt(p.ev_share_2024, 1)}%</b> of new vehicles in 2024 were electric, ${lq}.` +
        (p.ev_cagr_20_24 != null ? ` EV registrations grew about ${fmt(p.ev_cagr_20_24)}% a year since 2020.` : "");
    }
    if (state.step === 2) {
      const y = state.wasteYear;
      if (!p) {
        const t = nationalWaste("total", y), lead = nationalWaste("lead", y);
        return `In <b>${y}</b>, EVs in India will retire about <b>${fmt(t / 1000, 0)} thousand tonnes</b> of battery packs. ${fmt(100 * lead / t)}% of that is lead-acid, mostly from e-rickshaws; lithium-ion is the part growing fastest.`;
      }
      const t = wasteValue(p.did, "total", y), li = wasteValue(p.did, "liion", y), lith = wasteValue(p.did, "Lithium", y);
      if (t == null) return `No EV registrations are recorded at an RTO in <b>${esc(p.district)}</b>.`;
      return `<b>${esc(p.district)}</b> will retire about <b>${fmt(t)} t</b> of battery packs in ${y}, including ${fmt(li)} t of lithium-ion holding roughly ${fmt(lith, 1)} t of lithium.`;
    }
    if (state.step === 3) {
      if (!p) return `<b>${fmt(G.bothTotal)}</b> grid cells rank in the top tier for <b>both</b> a city and an operator. Those overlaps are the pilots that are easiest to agree on, so the map shows them by default.`;
      const s = G.byDistrict.get(p.did);
      if (!s) return `No grid cells within ${D.grid.radius_km} km of an RTO office in <b>${esc(p.district)}</b>.`;
      return `<b>${esc(p.district)}</b> has <b>${s.both}</b> cells where both sides agree. The strongest scores ${fmt(s.best)}/100. Click any cell to see why, then add it to your plan.`;
    }
    return `Choose a district, pick up to 8 zones, and adjust the numbers to match what you know locally. Both sides get their numbers, a split of who does what, and a 90-day plan you can copy into an email or a proposal.`;
  }

  /* ---- step controls ---- */
  function renderControls() {
    const c = $("#controls");
    if (state.step === 1) {
      c.innerHTML = `<div class="field"><label for="adopt-metric">Colour districts by</label>
        <select id="adopt-metric">${Object.entries(ADOPT).map(([k, m]) => `<option value="${k}" ${k === state.adoptMetric ? "selected" : ""}>${m.label}</option>`).join("")}</select></div>${legendHTML()}`;
      $("#adopt-metric").onchange = (e) => { state.adoptMetric = e.target.value; refresh(); };
    } else if (state.step === 2) {
      const ys = W().years;
      c.innerHTML = `<div class="field"><label for="waste-metric">Show</label>
        <select id="waste-metric">${Object.entries(WASTE).map(([k, l]) => `<option value="${k}" ${k === state.wasteMetric ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="field"><label for="waste-year">Year: <span class="num" id="wy">${state.wasteYear}</span> <span class="note" id="wy-note">${state.wasteYear > 2024 ? "(forecast)" : ""}</span></label>
        <input type="range" id="waste-year" min="${ys[0]}" max="${ys[ys.length - 1]}" step="1" value="${state.wasteYear}"></div>${legendHTML()}`;
      $("#waste-metric").onchange = (e) => { state.wasteMetric = e.target.value; refresh(); };
      $("#waste-year").oninput = (e) => {
        state.wasteYear = +e.target.value; $("#wy").textContent = state.wasteYear; $("#wy-note").textContent = state.wasteYear > 2024 ? "(forecast)" : "";
        computeBreaks(); restyle(); $(".legend").outerHTML = legendHTML(); $("#answer").innerHTML = answerText(); renderBoth(); renderDetail(); renderRank(); renderMapTitle();
      };
    } else {
      const sliders = (who) => G.fields.map((f) => `<div class="w"><label for="w-${who}-${f}">${CFG.gridFields[f] || f}</label>
        <input type="range" id="w-${who}-${f}" data-who="${who}" data-f="${f}" min="0" max="5" step="1" value="${state.weights[who][f] ?? 0}"><output>${state.weights[who][f] ?? 0}</output></div>`).join("");
      c.innerHTML = `<div class="field"><span class="lbl">Colour the grid by</span>
        <div class="seg" role="group" aria-label="Lens">
          ${[["joint", "Both agree"], ["city", "City lens"], ["operator", "Operator lens"]].map(([k, l]) => `<button type="button" data-lens="${k}" aria-pressed="${state.lens === k}">${l}</button>`).join("")}
        </div></div>
        ${legendHTML()}
        <details><summary>Adjust what each side cares about</summary>
          <div class="weights"><span class="tag city">City</span>${sliders("city")}<span class="tag op" style="margin-top:6px">Operator</span>${sliders("operator")}</div>
          <div class="row" style="margin-top:8px"><button type="button" class="btn small" id="w-reset">Reset both</button></div>
        </details>`;
      c.querySelectorAll("[data-lens]").forEach((b) => b.onclick = () => { state.lens = b.dataset.lens; redrawGrid(); renderControls(); renderRank(); renderMapTitle(); });
      c.querySelectorAll("input[data-who]").forEach((inp) => inp.oninput = () => {
        state.weights[inp.dataset.who][inp.dataset.f] = +inp.value; inp.nextElementSibling.textContent = inp.value;
        clearTimeout(state._t); state._t = setTimeout(() => { computeScores(); redrawGrid(); $(".legend").outerHTML = legendHTML(); $("#answer").innerHTML = answerText(); renderBoth(); renderDetail(); renderRank(); }, 120);
      });
      $("#w-reset").onclick = () => { state.weights = { city: { ...CFG.lenses.city.weights }, operator: { ...CFG.lenses.operator.weights } }; computeScores(); redrawGrid(); renderRail(); };
    }
  }
  function legendHTML() {
    const ramp = CFG.ramps[layer()];
    let br = breaks, d = 0, unit = "";
    if (layer() === "grid") br = G.breaks[lensKey()];
    else if (layer() === "adoption") { d = ADOPT[state.adoptMetric].d; unit = ADOPT[state.adoptMetric].unit; }
    const lab = (i) => br[i] == null ? "" : fmt(br[i], br[i] < 10 ? Math.max(d, 1) : d) + unit;
    return `<div class="legend"><div class="ramp">${ramp.map((c) => `<i style="background:${c}"></i>`).join("")}</div>
      <div class="ramp-labels"><span>${layer() === "grid" ? "0" : "lowest"}</span><span>${lab(1)}</span><span>${lab(3)}</span><span>${lab(5)}</span><span>${layer() === "grid" ? "100" : "highest"}</span></div>
      ${layer() !== "grid" ? `<div class="cat-legend"><span><i style="background:${css("--nodata")}"></i>No RTO office in the district</span></div>` : `<div class="note">Seven equal-sized groups of cells, so each colour covers one-seventh of India's scored cells.</div>`}</div>`;
  }

  /* ---- both perspectives ---- */
  function card(kind, html) { return `<div class="pcard ${kind}"><span class="tag">${kind === "city" ? "For the city" : "For the operator"}</span>${html}</div>`; }
  function renderBoth() {
    const p = state.selected != null ? P(state.selected) : null;
    const A = CFG.plan;
    let c = "", o = "";
    if (state.step === 1) {
      if (p && p.has_data) {
        c = `<b class="big">${fmt(p.ev_share_2024, 1)}%</b><p>Use this as your baseline for an EV target. Ask RTO ${esc(plateOf(p) || "")} for monthly VAHAN data to track it.</p>`;
        o = `<b class="big">${fmt(p.ev_2024)} EVs</b><p>registered here in 2024. Riders are ${fmt(p.ev_lq, 1)}× as likely as the average Indian buyer to choose electric.</p>`;
      } else {
        c = `<p>Dark green districts are ready for EV-first parking, charging rules and e-bike lanes. Start your policy conversations there.</p>`;
        o = `<p>High share means riders already trust electric. High growth shows where demand is heading before other operators arrive.</p>`;
      }
    } else if (state.step === 2) {
      const y = state.wasteYear;
      const t = p ? wasteValue(p.did, "total", y) : nationalWaste("total", y);
      const li = p ? wasteValue(p.did, "liion", y) : nationalWaste("liion", y);
      const pts = Math.max(1, Math.ceil((t || 0) / A.tonnesPerCollectionPoint));
      c = `<b class="big">${fmt(pts)} collection point${pts > 1 ? "s" : ""}</b><p>would handle ${fmt(t)} t in ${y} at ${A.tonnesPerCollectionPoint} t each. Place them near e-rickshaw stands and swap stations, and tie up with an authorised recycler under the Battery Waste Management Rules, 2022.</p>`;
      o = `<b class="big">${fmt(li)} t lithium-ion</b><p>retires ${p ? "here" : "across India"} in ${y}. Battery producers carry the collection target under the 2022 rules, so agree take-back terms with your supplier. Healthy packs can get a second life as swap-station storage.</p>`;
    } else {
      const s = p ? G.byDistrict.get(p.did) : null;
      const cell = (k) => `${G.rows[k][0].toFixed(2)}, ${G.rows[k][1].toFixed(2)}`;
      if (s) {
        c = `<b class="big">${fmt(s.bestCity)}/100</b><p>Best cell on the city lens (${cell(s.bestCityK)}). This lens weighs population, battery collection and EV share more.</p>`;
        o = `<b class="big">${fmt(s.bestOp)}/100</b><p>Best cell on the operator lens (${cell(s.bestOpK)}). This lens weighs vehicle activity and town centres more.</p>`;
      } else {
        c = `<p>Switch to the city lens to see where residents, battery collection and EV policy point. Pick a district to compare its best cells.</p>`;
        o = `<p>Switch to the operator lens to see where vehicle activity and town centres point. The cells both lenses like are where permits move fastest.</p>`;
      }
    }
    const cards = state.focus === "op" ? card("op", o) + card("city", c) : card("city", c) + card("op", o);
    $("#both").innerHTML = cards;
  }

  /* ---- district detail ---- */
  function dhead(p) {
    const pl = plateOf(p);
    return `<div class="dhead"><div><h2>${esc(p.district)}</h2><div class="sub">${esc(p.state)}${p.has_data ? ` · ${p.n_rto} RTO office${p.n_rto > 1 ? "s" : ""} · cluster ${p.cluster}` : ""}</div></div>
      <div class="row">${pl ? `<span class="plate"><small>IND</small>${pl}</span>` : ""}<button type="button" class="btn small" id="clear-sel">All India</button></div></div>`;
  }
  const wireClear = () => { const b = $("#clear-sel"); if (b) b.onclick = () => selectDistrict(null, false); };
  const groupColors = () => CFG.groups.map((_, i) => css(`--s${i + 1}`));

  function renderDetail() {
    destroyCharts(); chartDefaults();
    const el = $("#detail"), p = state.selected != null ? P(state.selected) : null;
    if (state.step === 1) {
      if (!p) {
        el.innerHTML = `<div class="eyebrow">India · what new vehicles ran on</div><div class="chart-box"><canvas id="c1"></canvas></div>
          <div class="eyebrow">Your Prophet forecast · EVs registered per year in India</div><div class="chart-box" style="height:150px"><canvas id="c2"></canvas></div>`;
        mixChart("c1", D.summary.years, D.summary.series);
        const nat = D.forecast.national.EV, yrs = Object.keys(nat).map(Number).filter((y) => y <= 2035);
        lineChart("c2", yrs, yrs.map((y) => nat[y]), css("--s1"));
        return;
      }
      if (!p.has_data) { el.innerHTML = dhead(p); return wireClear(); }
      el.innerHTML = dhead(p) + `<div class="stats">
          <div class="stat"><b>${fmt(p.ev_share_2024, 1)}%</b><small>EV share 2024</small></div>
          <div class="stat"><b>${p.ev_cagr_20_24 == null ? "–" : fmt(p.ev_cagr_20_24) + "%"}</b><small>yearly growth since 2020</small></div>
          <div class="stat"><b>${fmt(p.ev_share_pctile)}</b><small>percentile among districts</small></div></div>
        <div class="eyebrow">What new vehicles ran on</div><div class="chart-box"><canvas id="c1"></canvas></div>
        <div class="eyebrow">Cluster ${p.cluster} forecast · EV share of new vehicles</div><div class="chart-box" style="height:140px"><canvas id="c2"></canvas></div>`;
      wireClear();
      mixChart("c1", D.districts.years, p.series);
      const cf = D.forecast.clusters[String(p.cluster)];
      if (cf && cf.EV) {
        const yrs = Object.keys(cf.EV).map(Number).filter((y) => y <= 2035);
        lineChart("c2", yrs, yrs.map((y) => { const t = ["EV", "PETROL", "DIESEL", "CNG"].reduce((a, k) => a + ((cf[k] || {})[y] || 0), 0); return t ? +(100 * cf.EV[y] / t).toFixed(2) : null; }), css("--s1"), "%");
      }
    } else if (state.step === 2) {
      const ys = W().years, chems = W().chemistries, kg = W().pack_kg_per_kwh, mat = W().material_kg_per_kwh, i = ys.indexOf(state.wasteYear);
      let kwh;
      if (p) {
        const w = W().districts[String(p.did)];
        if (!w) { el.innerHTML = dhead(p); return wireClear(); }
        kwh = w.kwh;
      } else {
        kwh = {}; chems.forEach((c) => { kwh[c] = ys.map((_, j) => Object.values(W().districts).reduce((a, d) => a + (d.kwh[c] ? d.kwh[c][j] : 0), 0)); });
      }
      const tons = (c, j) => kwh[c][j] * (kg[c] ?? 7) / 1000, mats = {};
      chems.forEach((c) => Object.entries(mat[c] || {}).forEach(([m, v]) => { mats[m] = (mats[m] || 0) + kwh[c][i] * v / 1000; }));
      el.innerHTML = (p ? dhead(p) : `<div class="eyebrow">India · retired battery packs by type</div>`) +
        `<div class="chart-box"><canvas id="c1"></canvas></div>
        <div class="eyebrow">What is inside them in ${state.wasteYear}</div>
        <div style="overflow-x:auto"><table class="mini"><thead><tr><th>Material</th><th class="num">Tonnes</th></tr></thead><tbody>
        ${Object.entries(mats).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([m, v]) => `<tr><td>${m}</td><td class="num">${fmt(v, v < 10 ? 1 : 0)}</td></tr>`).join("")}</tbody></table></div>`;
      wireClear();
      const col = { NMC: css("--s2"), LFP: css("--s1"), "Lead-acid": css("--s6") };
      charts.push(new Chart($("#c1"), { type: "bar",
        data: { labels: ys, datasets: chems.map((c) => ({ label: c, data: ys.map((_, j) => +tons(c, j).toFixed(1)), backgroundColor: col[c] || css("--s5"), borderColor: css("--panel"), borderWidth: { top: 1 }, borderRadius: 2, maxBarThickness: 16 })) },
        options: opts({ stacked: true, unit: " t", hi: i }) }));
    } else {
      if (!p) { el.innerHTML = `<div class="eyebrow">How a cell gets its score</div><p class="note" style="color:var(--ink-2)">India is split into ${fmt(G.rows.length)} cells of about ${fmt(G.step * 111, 1)} km a side, within ${D.grid.radius_km} km of an RTO office. Each cell scores 0–100 on ${G.fields.map((f) => (CFG.gridFields[f] || f).toLowerCase()).join(", ")}. The city lens and the operator lens weigh these differently. "Both agree" keeps the lower of the two scores, so a cell only looks good if it works for both sides.</p>`; return; }
      const s = G.byDistrict.get(p.did);
      if (!s) { el.innerHTML = dhead(p); return wireClear(); }
      const means = G.fields.map((f, q) => { let t = 0, n = 0; G.rows.forEach((r) => { if (r[2] === p.did) { t += r[3 + q]; n++; } }); return t / n; });
      el.innerHTML = dhead(p) + `<div class="stats">
          <div class="stat"><b>${fmt(s.best)}</b><small>best "both agree" score</small></div>
          <div class="stat"><b>${s.both}</b><small>cells both sides rank highly</small></div>
          <div class="stat"><b>${s.n}</b><small>cells scored in district</small></div></div>
        <div class="eyebrow">Average of each ingredient here (0–100)</div>
        <div class="comp-bars">${G.fields.map((f, q) => `<div><span>${CFG.gridFields[f] || f}</span><i style="width:${means[q]}%"></i><span>${fmt(means[q])}</span></div>`).join("")}</div>`;
      wireClear();
    }
  }

  function opts({ stacked = false, unit = "", percent = false, hi = null } = {}) {
    return { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10, boxHeight: 10, padding: 8 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.parsed.y, percent || unit === "%" ? 1 : 0)}${percent ? "%" : unit}` } } },
      scales: { x: { stacked, grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 8, color: (c) => hi != null && c.index === hi ? css("--ink") : css("--ink-3") } },
        y: { stacked, beginAtZero: true, max: percent ? 100 : undefined, grid: { color: css("--line") },
          ticks: { callback: (v) => (Math.abs(v) >= 1e5 ? fmt(v / 1e5, 1) + "L" : fmt(v)) + (percent || unit === "%" ? "%" : "") } } } };
  }
  function mixChart(id, years, series) {
    const from = years.indexOf(2015), ys = years.slice(from), cols = groupColors();
    const tot = ys.map((_, k) => CFG.groups.reduce((a, g) => a + series[g][from + k], 0));
    charts.push(new Chart(document.getElementById(id), { type: "bar",
      data: { labels: ys, datasets: CFG.groups.map((g, i) => ({ label: g, data: ys.map((_, k) => tot[k] ? +(100 * series[g][from + k] / tot[k]).toFixed(2) : 0),
        backgroundColor: cols[i], borderColor: css("--panel"), borderWidth: { top: 1 }, maxBarThickness: 22 })) },
      options: opts({ stacked: true, percent: true }) }));
  }
  function lineChart(id, labels, data, color, unit = "") {
    const o = opts({ unit }); o.plugins.legend = { display: false };
    charts.push(new Chart(document.getElementById(id), { type: "line",
      data: { labels, datasets: [{ label: unit === "%" ? "EV share" : "EVs", data, borderColor: color, backgroundColor: color + "26", fill: true, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.25 }] },
      options: o }));
  }

  /* ---- ranking ---- */
  function renderRank() {
    const ol = $("#rank"); if (!ol) return;
    ol.innerHTML = "";
    if (layer() === "grid") {
      const lens = { joint: "both sides agree", city: "city lens", operator: "operator lens" }[state.lens];
      $("#rank-title").textContent = state.selected != null ? `Best cells in ${P(state.selected).district} · ${lens}` : `Best cells in the map view · ${lens}`;
      const b = map.getBounds(), ks = [];
      G.rows.forEach((r, k) => { if (state.selected != null ? r[2] === state.selected : b.contains([r[0], r[1]])) ks.push(k); });
      ks.sort((a, z) => score(z) - score(a));
      ks.slice(0, 10).forEach((k) => {
        const r = G.rows[k], li = document.createElement("li");
        li.innerHTML = `<span class="nm">${esc(P(r[2]).district)} <small>${r[0].toFixed(2)}, ${r[1].toFixed(2)}</small></span><span class="v">${fmt(score(k))}</span>`;
        li.onclick = () => { map.flyTo([r[0], r[1]], 12, { duration: 0.8 }); L.popup().setLatLng([r[0], r[1]]).setContent(cellPopup(k)).openOn(map); };
        ol.appendChild(li);
      });
      if (!ks.length) ol.innerHTML = `<li style="cursor:default">No scored cells here. Zoom out or pick another district.</li>`;
      $("#export-box").innerHTML = state.selected != null && ks.length ? `<button type="button" class="btn solid" id="to-plan">Use the top 5 as pilot zones →</button>` : "";
      const tp = $("#to-plan");
      if (tp) tp.onclick = () => { suggestZones(state.selected, 5); setStep(4); };
      return;
    }
    $("#rank-title").textContent = layer() === "adoption" ? `Top districts · ${ADOPT[state.adoptMetric].label}` : `Top districts · ${WASTE[state.wasteMetric]}, ${state.wasteYear}`;
    const m = layer() === "adoption" ? ADOPT[state.adoptMetric] : { d: 0, unit: " t" };
    D.districts.features.map((f) => ({ p: f.properties, v: districtValue(f.properties) })).filter((x) => x.v != null)
      .sort((a, b) => b.v - a.v).slice(0, 10).forEach((x) => {
        const li = document.createElement("li");
        li.innerHTML = `<span class="nm">${esc(x.p.district)} <small>${esc(x.p.state)}</small></span><span class="v">${fmt(x.v, m.d)}${m.unit}</span>`;
        li.onclick = () => selectDistrict(x.p.did, true);
        ol.appendChild(li);
      });
    $("#export-box").innerHTML = "";
  }

  /* ================================================================ step 4: plan */
  function suggestZones(did, n) {
    const ks = []; G.rows.forEach((r, k) => { if (r[2] === did) ks.push(k); });
    ks.sort((a, b) => G.joint[b] - G.joint[a]);
    // spread zones out: skip cells that touch an already chosen zone
    const pick = [], near = (a, b) => Math.abs(G.rows[a][0] - G.rows[b][0]) < 1.5 * G.step && Math.abs(G.rows[a][1] - G.rows[b][1]) < 1.5 * G.step;
    for (const k of ks) { if (pick.length >= n) break; if (!pick.some((q) => near(q, k))) pick.push(k); }
    state.plan.did = did; state.plan.zones = pick;
    savePlan();
  }
  function addZone(k) {
    const did = G.rows[k][2];
    if (state.plan.did !== did) usePlanFor(did);
    if (!state.plan.zones.includes(k) && state.plan.zones.length < 8) state.plan.zones.push(k);
    savePlan(); drawZones();
    if (state.step === 4) { state.selected = did; restyle(); renderRail(); }
    else toast(`Added zone Z${state.plan.zones.length} in ${P(did).district}. Open step 4 to see the plan.`);
  }
  function savePlan() {
    if (state.plan.did != null) state.plans[state.plan.did] = state.plan.zones.slice();
    store.set("gp-plans", state.plans);
    store.set("gp-plan", { did: state.plan.did, zones: state.plan.zones, assume: state.plan.assume });
  }
  function toast(msg) {
    const t = document.createElement("div"); t.className = "map-tip"; t.style.cssText = "left:56px;bottom:16px;top:auto"; t.textContent = msg;
    $(".map-wrap").appendChild(t); setTimeout(() => t.remove(), 3500);
  }

  function computePlan() {
    const a = state.plan.assume, ks = state.plan.zones, p = state.plan.did != null ? P(state.plan.did) : null;
    const zones = ks.map((k, i) => {
      const r = G.rows[k], veh = Math.max(5, Math.round(a.vehiclesPerZone * G.joint[k] / 100 / 5) * 5);
      return { id: `Z${i + 1}`, k, lat: r[0], lon: r[1], joint: G.joint[k], city: G.city[k], op: G.op[k], veh, km2: cellKm2(r[0]) };
    });
    const fleet = zones.reduce((s, z) => s + z.veh, 0);
    const swaps = fleet ? Math.ceil(fleet / a.vehiclesPerSwapStation) : 0;
    const ridesDay = fleet * a.ridesPerVehicleDay;
    const revMonth = ridesDay * 30 * a.farePerRide;
    const capex = fleet * a.vehicleCost + swaps * a.swapStationCost;
    const payback = revMonth * a.operatingMargin > 0 ? capex / (revMonth * a.operatingMargin) : null;
    const bays = fleet ? Math.ceil(fleet / a.vehiclesPerBay) : 0;
    const landSqm = bays * a.bayAreaSqm + swaps * a.swapStationAreaSqm;
    const petrolL = ridesDay * 30 * a.tripKm * a.shareReplacingPetrol / a.petrolKmPerLitre;
    const co2t = petrolL * 12 * 2.31 / 1000;  // 2.31 kg CO2 per litre of petrol burned
    const eol30 = p ? (wasteValue(p.did, "total", 2030) || 0) : 0;
    const li30 = p ? (wasteValue(p.did, "liion", 2030) || 0) : 0;
    const points = eol30 ? Math.max(1, Math.ceil(eol30 / a.tonnesPerCollectionPoint)) : 0;
    return { p, zones, fleet, swaps, ridesDay, revMonth, capex, payback, bays, landSqm, petrolL, co2t, eol30, li30, points, a };
  }

  const ASSUME_LABELS = {
    vehiclesPerZone: "Vehicles in a top zone", ridesPerVehicleDay: "Rides per vehicle per day", farePerRide: "Fare per ride (₹)",
    operatingMargin: "Operating margin (0–1)", vehicleCost: "Cost per vehicle (₹)", vehiclesPerSwapStation: "Vehicles per swap station",
    swapStationCost: "Cost per swap station (₹)", vehiclesPerBay: "Vehicles per parking bay", bayAreaSqm: "Area per bay (m²)",
    swapStationAreaSqm: "Land per swap station (m²)", tripKm: "Average trip (km)", shareReplacingPetrol: "Rides replacing petrol bikes (0–1)",
    petrolKmPerLitre: "Petrol bike km per litre", tonnesPerCollectionPoint: "Tonnes per collection point / year"
  };

  function planHTML() {
    const R = computePlan(), p = R.p;
    if (!p || !R.zones.length) {
      const sel = state.selected != null ? P(state.selected) : null;
      return `<section><div class="empty">
        ${sel ? `<p><b>${esc(sel.district)}</b> is selected. Start with the five cells both sides rank highest, or go back to step 3 and click cells to add them one by one.</p>
          <div class="row" style="margin-top:10px"><button type="button" class="btn solid" id="suggest">Suggest 5 zones in ${esc(sel.district)}</button></div>`
        : `<p>Pick a district above, or click any coloured cell on the map and choose <b>Add to pilot plan</b>.</p>`}
      </div></section>`;
    }
    const zoneRows = R.zones.map((z) => `<li><span class="zid">${z.id}</span><span>${z.lat.toFixed(3)}, ${z.lon.toFixed(3)} <span class="note">· score ${fmt(z.joint)}</span></span><span class="num">${z.veh} veh</span><button type="button" aria-label="Remove ${z.id}" data-rm="${z.k}">×</button></li>`).join("");
    const a = R.a;
    return `<section>
        ${dhead(p)}
        <div class="eyebrow">Pilot zones (${R.zones.length} of up to 8)</div>
        <ul class="zones">${zoneRows}</ul>
        <div class="row"><button type="button" class="btn small" id="suggest">Replace with top 5</button><span class="note">Click more cells on the map to add zones.</span></div>
        <details><summary>Adjust the assumptions</summary>
          <div class="assume">${Object.keys(ASSUME_LABELS).map((k) => `<label for="a-${k}">${ASSUME_LABELS[k]}<input type="number" id="a-${k}" data-a="${k}" value="${a[k]}" step="any" min="0"></label>`).join("")}</div>
          <div class="row" style="margin-top:8px"><button type="button" class="btn small" id="a-reset">Reset to defaults</button></div>
        </details>
      </section>
      <section>
        <div class="both">
          <div class="pcard op"><span class="tag">Operator brings</span><div class="kv">
            <span>Fleet</span><span>${fmt(R.fleet)}</span>
            <span>Swap stations</span><span>${fmt(R.swaps)}</span>
            <span>Rides a day</span><span>${fmt(R.ridesDay)}</span>
            <span>Revenue a month</span><span>${inr(R.revMonth)}</span>
            <span>Upfront cost</span><span>${inr(R.capex)}</span>
            <span>Payback</span><span>${R.payback == null ? "–" : fmt(R.payback) + " mo"}</span></div></div>
          <div class="pcard city"><span class="tag">City provides</span><div class="kv">
            <span>Parking bays</span><span>${fmt(R.bays)}</span>
            <span>Land needed</span><span>${fmt(R.landSqm)} m²</span>
            <span>Petrol saved a month</span><span>${fmt(R.petrolL)} L</span>
            <span>CO₂ avoided a year</span><span>${fmt(R.co2t)} t</span>
            <span>Battery packs retiring, 2030</span><span>${fmt(R.eol30)} t</span>
            <span>Collection points</span><span>${fmt(R.points)}</span></div></div>
        </div>
      </section>
      <section>
        <div class="eyebrow">Who does what</div>
        <div style="overflow-x:auto">${whoTable(R)}</div>
      </section>
      <section>
        <div class="eyebrow">First 90 days</div>
        <ol class="timeline">${timeline(R).map(([w, who, t]) => `<li><span class="when">${w}</span><span><span class="who ${who}">${who === "both" ? "Together" : who === "city" ? "City" : "Operator"}</span>${t}</span></li>`).join("")}</ol>
      </section>
      <section>
        <div class="eyebrow">Take it from here</div>
        <div class="row">
          <button type="button" class="btn solid" id="copy-plan">Copy plan as text</button>
          <button type="button" class="btn" id="dl-plan">Download plan (.md)</button>
          <button type="button" class="btn" id="dl-zones">Download zones (.csv)</button>
        </div>
        <p class="note" id="copy-msg">Paste it into an email to the municipal commissioner or the operator's city team. Every number shows the assumption behind it.</p>
      </section>`;
  }
  const RESP = [
    ["Parking bays and signage in each zone", "city"], ["Single-window permit for the pilot area", "city"],
    ["Land or rooftop space for swap stations", "city"], ["Battery collection points near e-rickshaw stands", "city"],
    ["Vehicles, app and on-ground team", "op"], ["Swap stations and charging", "op"],
    ["Battery take-back with supplier and authorised recycler", "op"], ["Anonymised trip data to the city every month", "op"],
    ["Shared KPI dashboard and a 90-day review", "both"], ["Joint rider-safety and parking campaign", "both"]
  ];
  function whoTable() {
    return `<table class="mini"><tbody>${RESP.map(([t, w]) => `<tr><td>${t}</td><td><span class="who ${w}">${w === "both" ? "Together" : w === "city" ? "City" : "Operator"}</span></td></tr>`).join("")}</tbody></table>`;
  }
  function timeline(R) {
    return [
      ["Week 1–2", "both", `Agree the ${R.zones.length} pilot zones and sign a short MoU covering data sharing and battery take-back.`],
      ["Week 2–4", "city", `Approve ${fmt(R.bays)} parking bays and ${fmt(R.swaps * R.a.swapStationAreaSqm)} m² for ${fmt(R.swaps)} swap station${R.swaps === 1 ? "" : "s"}; issue the pilot permit.`],
      ["Week 3–6", "op", `Install swap stations, deploy ${fmt(R.fleet)} vehicles, and register an authorised battery recycler.`],
      ["Week 6", "both", `Soft launch in ${R.zones[0].id} and ${R.zones.length > 1 ? R.zones[1].id : "one more zone"}, then open the rest over two weeks.`],
      ["Day 90", "both", `Review: target ${fmt(R.ridesDay)} rides a day, at least 90% of vehicles available, every retired battery logged. Decide to scale, adjust or stop.`]
    ];
  }

  function planText(R) {
    const t = CFG.team, a = R.a, p = R.p;
    const L = [];
    L.push(`# Shared e-mobility pilot: ${p.district}, ${p.state}`);
    L.push(`Prepared with Green Plate by ${t.name} (${t.event}) · ${new Date().toLocaleDateString("en-IN")}`, "");
    L.push(`## Why here`);
    L.push(`- EV share of new vehicles in 2024: ${p.ev_share_2024 == null ? "n/a" : fmt(p.ev_share_2024, 1) + "% (India " + fmt(D.summary.ev_share_2024, 1) + "%)"}`);
    L.push(`- Battery packs retiring in the district in 2030: about ${fmt(R.eol30)} t (${fmt(R.li30)} t lithium-ion)`);
    L.push(`- Pilot zones chosen where the city lens and operator lens both score high`, "");
    L.push(`## Pilot zones`);
    L.push(`| Zone | Lat, Lon | Area km² | Score (both) | City | Operator | Vehicles |`, `|---|---|---|---|---|---|---|`);
    R.zones.forEach((z) => L.push(`| ${z.id} | ${z.lat.toFixed(4)}, ${z.lon.toFixed(4)} | ${fmt(z.km2, 1)} | ${fmt(z.joint)} | ${fmt(z.city)} | ${fmt(z.op)} | ${z.veh} |`));
    L.push("", `## Operator side`);
    L.push(`- Fleet: ${fmt(R.fleet)} vehicles; swap stations: ${fmt(R.swaps)} (1 per ${a.vehiclesPerSwapStation} vehicles)`);
    L.push(`- Rides a day: ${fmt(R.ridesDay)} (${a.ridesPerVehicleDay} per vehicle) · revenue a month: ${inr(R.revMonth)} at ₹${a.farePerRide} a ride`);
    L.push(`- Upfront cost: ${inr(R.capex)} · payback: ${R.payback == null ? "n/a" : fmt(R.payback) + " months"} at ${fmt(a.operatingMargin * 100)}% margin`, "");
    L.push(`## City side`);
    L.push(`- Parking bays: ${fmt(R.bays)} · land needed: ${fmt(R.landSqm)} m²`);
    L.push(`- Petrol saved: ${fmt(R.petrolL)} litres a month · CO₂ avoided: ${fmt(R.co2t)} t a year`);
    L.push(`- Battery collection points needed across the district by 2030: ${fmt(R.points)} (${a.tonnesPerCollectionPoint} t each)`, "");
    L.push(`## Who does what`);
    RESP.forEach(([x, w]) => L.push(`- ${w === "both" ? "Together" : w === "city" ? "City" : "Operator"}: ${x}`));
    L.push("", `## First 90 days`);
    timeline(R).forEach(([w, who, x]) => L.push(`- ${w} (${who === "both" ? "together" : who === "city" ? "city" : "operator"}): ${x}`));
    L.push("", `## Assumptions`);
    Object.keys(ASSUME_LABELS).forEach((k) => L.push(`- ${ASSUME_LABELS[k]}: ${a[k]}`));
    L.push("", `Data: VAHAN registrations by RTO (2001–2024), Prophet forecasts, district boundaries. Battery figures come from a cohort model with editable assumptions. Contact: ${t.contact}`);
    return L.join("\n");
  }
  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }

  function wirePlan() {
    const sg = $("#suggest");
    if (sg) sg.onclick = () => { suggestZones(state.plan.did ?? state.selected, 5); state.selected = state.plan.did; restyle(); drawZones(); renderRail(); fitPlan(); };
    rail.querySelectorAll("[data-rm]").forEach((b) => b.onclick = () => { state.plan.zones = state.plan.zones.filter((k) => k !== +b.dataset.rm); savePlan(); drawZones(); renderRail(); });
    rail.querySelectorAll("[data-a]").forEach((inp) => inp.onchange = () => {
      const v = parseFloat(inp.value); if (!Number.isNaN(v) && v >= 0) { state.plan.assume[inp.dataset.a] = v; savePlan(); renderRail(); $("details").open = true; }
    });
    const ar = $("#a-reset"); if (ar) ar.onclick = () => { state.plan.assume = { ...CFG.plan }; savePlan(); renderRail(); };
    wireClear();
    const R = computePlan();
    if (!R.zones.length) return;
    const fname = R.p.district.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    $("#copy-plan").onclick = () => navigator.clipboard.writeText(planText(R)).then(
      () => { $("#copy-msg").textContent = "Copied. Paste it into an email or a doc."; },
      () => { $("#copy-msg").textContent = "Your browser blocked copying. Use Download instead."; });
    $("#dl-plan").onclick = () => download(`pilot-plan-${fname}.md`, planText(R), "text/markdown");
    $("#dl-zones").onclick = () => download(`pilot-zones-${fname}.csv`,
      ["zone,lat,lon,area_km2,score_both,score_city,score_operator,vehicles"].concat(R.zones.map((z) => [z.id, z.lat, z.lon, z.km2.toFixed(2), z.joint.toFixed(1), z.city.toFixed(1), z.op.toFixed(1), z.veh].join(","))).join("\n"), "text/csv");
  }
  function fitPlan() {
    if (!state.plan.zones.length) return;
    const pts = state.plan.zones.map((k) => [G.rows[k][0], G.rows[k][1]]);
    map.flyToBounds(L.latLngBounds(pts).pad(0.6), { maxZoom: 12, duration: 0.8 });
  }

  /* ================================================================ wiring */
  function methodNote() {
    if (state.step === 1) return "VAHAN counts vehicles at the RTO office where they are registered. Each RTO is placed in the district that contains it, so districts without an RTO are grey. 2024 data runs to early December.";
    if (state.step === 2) return W().mode === "user" ? "Battery figures come from the team's district waste table." : "Battery figures are a model: past EV registrations plus each district's share of your Prophet EV forecast, split by vehicle type and battery chemistry, retiring after a typical service life. Assumptions live in config/battery_assumptions.json.";
    if (state.step === 3) return "Vehicle activity weighs registrations of RTOs within 15 km. Town centre is closeness to the nearest RTO. EV share, growth and battery loop come from steps 1 and 2. Adding population and trip anchors (stations, colleges, markets) makes it sharper.";
    return "Plan numbers are starting estimates. Change any assumption above and everything updates. Your plan is saved in this browser.";
  }
  function renderMapTitle() {
    let t, s;
    if (layer() === "adoption") { t = ADOPT[state.adoptMetric].label; s = "Step 1 · VAHAN registrations by district"; }
    else if (layer() === "waste") { t = `${WASTE[state.wasteMetric]} · ${state.wasteYear}`; s = "Step 2 · battery packs reaching end of life"; }
    else { t = { joint: "Where city and operator both agree", city: "City lens", operator: "Operator lens" }[state.lens]; s = `Step ${state.step} · ${fmt(G.step * 111, 1)} km grid cells, scored 0–100`; }
    $("#map-title").innerHTML = `<b>${t}</b><small>${s}</small>`;
  }
  function refresh() { computeBreaks(); restyle(); renderRail(); renderMapTitle(); }

  function setStep(s) {
    state.step = s;
    document.querySelectorAll(".step").forEach((b) => {
      const n = +b.dataset.step;
      if (n === s) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
      b.classList.toggle("done", n < s);
    });
    if (s === 4) { state.lens = "joint"; if (state.plan.did != null && state.selected == null) state.selected = state.plan.did; }
    map.closePopup();
    showGrid(layer() === "grid");
    computeBreaks(); restyle(); drawZones(); renderRail(); renderMapTitle();
    rail.scrollTop = 0; window.scrollTo(0, 0);
    if (s === 4) fitPlan();
  }
  function selectDistrict(did, fly, quiet) {
    state.selected = did;
    if (state.step === 4 && did != null && did !== state.plan.did) { usePlanFor(did); savePlan(); drawZones(); }
    restyle();
    if (did != null && fly) districtLayer.eachLayer((l) => { if (l.feature.properties.did === did) map.flyToBounds(l.getBounds(), { padding: [30, 30], duration: 0.8, maxZoom: 10 }); });
    if (!quiet || state.step !== 4) renderRail();
    renderMapTitle();
  }

  let names = [];
  function wireSearch() {
    const inp = $("#search");
    inp.addEventListener("change", () => {
      const v = inp.value.toLowerCase().trim();
      if (!v) return;
      const hit = names.find((p) => `${p.district}, ${p.state}`.toLowerCase() === v) || names.find((p) => p.district.toLowerCase().startsWith(v.split(",")[0].trim()));
      if (hit) selectDistrict(hit.did, true);
    });
  }

  function openIntro() {
    const el = $("#intro"); el.hidden = false;
    el.querySelectorAll("[data-focus]").forEach((b) => b.onclick = () => {
      state.focus = b.dataset.focus; store.set("gp-focus", state.focus); store.set("gp-seen", true);
      el.hidden = true; renderRail();
    });
    el.onclick = (e) => { if (e.target === el) { el.hidden = true; store.set("gp-seen", true); } };
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#intro").hidden = true; });

  async function main() {
    const t = CFG.team;
    $("#byline").textContent = `${t.name} · ${t.event}`;
    $("#intro-team").textContent = `${t.name} · ${t.event}`;
    try { await load(); }
    catch (err) {
      $("#loading").innerHTML = `We couldn't load the data (${esc(err.message)}).<br>Serve the folder over HTTP, for example <code>python -m http.server</code>, then open http://localhost:8000`;
      return;
    }
    names = D.districts.features.map((f) => f.properties).sort((a, b) => a.district.localeCompare(b.district));
    const dl = document.createElement("datalist"); dl.id = "district-list";
    dl.innerHTML = names.map((p) => `<option value="${esc(p.district)}, ${esc(p.state)}"></option>`).join("");
    document.body.appendChild(dl);
    initMap();
    $("#loading").remove();
    document.querySelectorAll(".step").forEach((b) => b.onclick = () => setStep(+b.dataset.step));
    $("#open-intro").onclick = openIntro;
    const h = location.hash.replace("#step", "");
    setStep([1, 2, 3, 4].includes(+h) ? +h : 1);
    if (!store.get("gp-seen", false)) openIntro();
  }
  main();
})();
