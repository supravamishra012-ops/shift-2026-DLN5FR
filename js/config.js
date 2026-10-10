/* Edit this file first. Everything a team member may want to change without touching app.js. */
window.ATLAS_CONFIG = {

  /* ---- who made this (shown in the intro and on every exported plan) ---- */
  team: {
    name: "Team Green Plate",                 // <- your team name
    event: "Hackathon 2026",                  // <- hackathon name
    members: "Add your names in js/config.js",
    contact: "team@example.com"
  },

  // Optional background map. Set to null for offline demos.
  basemap: {
    url: "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png",
    urlDark: "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png",
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
  },

  /* ---- Layer 3 lenses. Weights 0-5 per component. ----
     "joint" is the default: a cell scores high only if BOTH the city lens and the
     operator lens score it high (we take the lower of the two). */
  lenses: {
    city:     { label: "City lens",     weights: { demand: 3, urban: 2, ev_share: 2, ev_growth: 2, circular: 4, population: 4, poi: 2 } },
    operator: { label: "Operator lens", weights: { demand: 5, urban: 4, ev_share: 2, ev_growth: 3, circular: 1, population: 3, poi: 4 } }
  },

  gridFields: {
    demand: "Vehicle activity",
    urban: "Town centre",
    ev_share: "EV share",
    ev_growth: "EV growth",
    circular: "Battery loop",
    population: "Population",
    poi: "Trip anchors"
  },

  /* ---- Step 4 pilot plan: starting assumptions (users can edit them on the page) ---- */
  plan: {
    vehiclesPerZone: 60,        // e-bikes / e-scooters in a zone scoring 100
    ridesPerVehicleDay: 5,
    farePerRide: 30,            // ₹
    operatingMargin: 0.3,       // share of fare revenue left after running costs
    vehicleCost: 50000,         // ₹ per vehicle incl. first battery
    vehiclesPerSwapStation: 50,
    swapStationCost: 450000,    // ₹ per swap station
    vehiclesPerBay: 10,         // parking bays the city marks
    bayAreaSqm: 15,             // m² per bay
    swapStationAreaSqm: 20,     // m² of land per swap station
    tripKm: 2.5,
    shareReplacingPetrol: 0.4,  // share of rides that would otherwise be a petrol two-wheeler
    petrolKmPerLitre: 45,
    tonnesPerCollectionPoint: 50 // end-of-life battery tonnes one collection point can handle per year
  },

  groups: ["EV", "Hybrid", "Petrol", "Diesel", "CNG/LPG", "Other"],

  // sequential ramps, light -> dark (one hue per step)
  ramps: {
    adoption: ["#d9eee3", "#b2dcc6", "#84c6a5", "#52ac82", "#2d8f64", "#1a714d", "#0d5438"],
    waste:    ["#fbe7c6", "#f6d08f", "#efb65b", "#e09a2e", "#c47d16", "#9b5f0d", "#6f4307"],
    grid:     ["#e4e1f5", "#c6c0ec", "#a49be0", "#8277d0", "#6457bb", "#4b3f9c", "#33297a"]
  }
};
