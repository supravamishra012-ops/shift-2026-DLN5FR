import os; os.makedirs('build', exist_ok=True)
import warnings; warnings.filterwarnings('ignore')
import numpy as np, geopandas as gpd, shapely, collections, pickle, time
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
t0=time.time()
g=gpd.read_file('data/roads.gpkg').explode(index_parts=False).reset_index(drop=True)
CLS={'trunk':0,'primary':1,'secondary':2,'tertiary':3,'unclassified':4,'residential':5,'living_street':6,'service':7}
lines=[np.asarray(geom.coords) for geom in g.geometry]
hw=g.highway.map(CLS).values; hs=(g.Stress=='high').values.astype(np.uint8)
key=lambda xy:(round(xy[0],1),round(xy[1],1))
cnt=collections.Counter()
for L in lines:
    ks=[key(p) for p in L]
    for k in set(ks): cnt[k]+=1
    cnt[ks[0]]+=1; cnt[ks[-1]]+=1   # endpoints are junctions
nid={}; nxy=[]
def node(k,p):
    if k not in nid: nid[k]=len(nxy); nxy.append(p)
    return nid[k]
E=[]  # u,v,len,cls,stress,coords
for L,c,s in zip(lines,hw,hs):
    ks=[key(p) for p in L]; start=0
    for i in range(1,len(L)):
        if cnt[ks[i]]>1 or i==len(L)-1:
            seg=L[start:i+1]
            ln=float(np.sum(np.hypot(*np.diff(seg,axis=0).T)))
            if ln>0: E.append((node(ks[start],L[start]),node(ks[i],L[i]),ln,c,s,seg))
            start=i
nxy=np.array(nxy); print('nodes',len(nxy),'edges',len(E),time.time()-t0)
u=np.array([e[0] for e in E]); v=np.array([e[1] for e in E])
A=coo_matrix((np.ones(len(E)),(u,v)),shape=(len(nxy),)*2)
nc,lab=connected_components(A,directed=False)
big=np.bincount(lab).argmax(); keep=lab==big
print('components',nc,'largest share nodes',keep.mean(), 'edge km in largest', sum(e[2] for e in E if keep[e[0]])/1000)
pickle.dump(dict(nxy=nxy,E=E,keep=keep),open('build/roads_graph.pkl','wb'))
