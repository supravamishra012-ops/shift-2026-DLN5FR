import os; os.makedirs('build', exist_ok=True)
"""Contract + simplify the OSM road graph and export compact arrays for routing (Python + browser)."""
import warnings; warnings.filterwarnings('ignore')
import numpy as np, pickle, shapely, time, collections
from pyproj import Transformer
t0=time.time()
G=pickle.load(open('build/roads_graph.pkl','rb')); nxy=G['nxy']; keep=G['keep']
E=[e for e in G['E'] if keep[e[0]] and e[0]!=e[1]]
# --- contract degree-2 nodes where both edges share class & stress
adj=collections.defaultdict(list)
for k,e in enumerate(E): adj[e[0]].append(k); adj[e[1]].append(k)
alive=[True]*len(E)
edges=[list(e) for e in E]   # u,v,len,cls,stress,coords
for nd in list(adj.keys()):
    ks=[k for k in adj[nd] if alive[k]]
    if len(ks)!=2: continue
    a,b=ks
    if a==b: continue
    ea,eb=edges[a],edges[b]
    if ea[3]!=eb[3] or ea[4]!=eb[4]: continue
    # orient: ea ends at nd, eb starts at nd
    if ea[1]!=nd: ea=[ea[1],ea[0],ea[2],ea[3],ea[4],ea[5][::-1]]
    if eb[0]!=nd: eb=[eb[1],eb[0],eb[2],eb[3],eb[4],eb[5][::-1]]
    if ea[0]==eb[1]: continue  # would form self loop
    new=[ea[0],eb[1],ea[2]+eb[2],ea[3],ea[4],np.vstack([ea[5],eb[5][1:]])]
    edges[a]=new; alive[b]=False
    adj[eb[1]]=[a if k==b else k for k in adj[eb[1]]]
    adj[nd]=[]
edges=[e for e,al in zip(edges,alive) if al]
used=sorted(set([e[0] for e in edges])|set([e[1] for e in edges]))
remap={o:i for i,o in enumerate(used)}
NXY=nxy[used]
U=np.array([remap[e[0]] for e in edges],np.int32); V=np.array([remap[e[1]] for e in edges],np.int32)
LEN=np.array([e[2] for e in edges],np.float32); CL=np.array([e[3] for e in edges],np.uint8); HS=np.array([e[4] for e in edges],np.uint8)
GEO=[shapely.simplify(shapely.linestrings(e[5]),6.0) for e in edges]
GEO=[np.asarray(shapely.get_coordinates(x)) for x in GEO]
print('contracted nodes',len(NXY),'edges',len(U),'vertices',sum(len(x) for x in GEO), round(time.time()-t0,1),'s')
tr=Transformer.from_crs(32643,4326,always_xy=True)
lon,lat=tr.transform(NXY[:,0],NXY[:,1])
pickle.dump(dict(NXY=NXY,U=U,V=V,LEN=LEN,CL=CL,HS=HS,GEO=GEO,lat=np.array(lat),lon=np.array(lon)),open('build/roadnet.pkl','wb'))
