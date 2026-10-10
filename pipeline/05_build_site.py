"""DRISHTI step 5: package model outputs, road graph and the web template into a single index.html."""
import json, pandas as pd

d = pd.read_csv('data/grid.csv', encoding='utf-8-sig').set_index('Grid_ID')
m = json.load(open('build/model.json'))
cells = []
for c in m['cells']:
    r = d.loc[c['id']]
    cells.append(dict(p=c['p'], la=c['la'], lo=c['lo'], D=c['D'], A=c['A'], F=c['F'], G=c['G'], E=c['E'], B=c['B'], st=c['st'],
                      el=c['el'], t=c['t'], nb=c['nb'], nbd=c['nbd'], nd=c['nd'], sd=c['sd'], r=c['r'],
                      ph=int(r['pharmacy_poi']), gr=int(r['grocerystore_poi']), rs=int(r['restaurant_poi']),
                      hp=int(r['hostelpg_poi']), poi=int(r['Total POI'])))
Mt = m['metrics']
out = dict(cells=cells,
           hubs=[dict(cell=h['cell'], station=h['station']) for h in m['hubs']],
           stations=[dict(cell=s['cell'], lat=s['lat'], lon=s['lon'], van_km=s['van_km']) for s in m['stations']],
           vans=[dict(station=v['station'], edges=v['edges']) for v in m['vans']],
           corridors=[dict(e=c['e'], load=c['load'], priority=c['priority']) for c in m['corridors']],
           scenarios=m['scenarios'],
           scenarioWeights={k: v['weights'] for k, v in Mt['scenarios'].items() if k != 'Balanced'},
           weights=Mt['weights'],
           params={k: Mt['params'][k] for k in ['adoption', 'trip_km', 'wh_per_km', 'battery_kwh', 'usable_dod',
                                                'charge_eff', 'trips_per_vehicle', 'station_capacity']})
html = (open('web/template.html').read()
        .replace('/*__LEAFLET_CSS__*/', open('web/leaflet.css').read())
        .replace('/*__ENGINE__*/', open('web/engine.js').read())
        .replace('/*__DATA__*/null', json.dumps(out, separators=(',', ':')))
        .replace('/*__ROADS__*/', open('build/roads.b64').read()))
head, sep, body = html.partition('<header class="topbar">')
html = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        '<meta name="description" content="DRISHTI: e-micromobility planning and journey platform for Delhi">\n'
        '<style>html,body{margin:0}</style>\n' + head + '</head>\n<body>\n' + sep + body + '\n</body>\n</html>\n')
open('index.html', 'w').write(html)
print('index.html written: %.1f MB' % (len(html) / 1e6))
