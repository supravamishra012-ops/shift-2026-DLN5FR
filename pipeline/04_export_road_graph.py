import os; os.makedirs('build', exist_ok=True)
import pickle, numpy as np, gzip, base64, struct
from pyproj import Transformer
R=pickle.load(open('build/roadnet.pkl','rb'))
tr=Transformer.from_crs(32643,4326,always_xy=True)
lat=np.round(R['lat']*1e6).astype(np.int64); lon=np.round(R['lon']*1e6).astype(np.int64)
U,V=R['U'],R['V']
cnt=[];dl=[]
mx_cnt=0
for k,geo in enumerate(R['GEO']):
    inner=geo[1:-1]
    if len(inner):
        lo,la=tr.transform(inner[:,0],inner[:,1]); la=np.round(np.array(la)*1e6).astype(np.int64); lo=np.round(np.array(lo)*1e6).astype(np.int64)
    else: la=lo=np.array([],np.int64)
    # orientation check: geo[0] should be node U
    pts_la=list(la); pts_lo=list(lo)
    prev=(lat[U[k]],lon[U[k]]); out=[]
    for a,b in zip(pts_la,pts_lo):
        # split big jumps
        while abs(a-prev[0])>32000 or abs(b-prev[1])>32000:
            step=(prev[0]+int(np.clip(a-prev[0],-32000,32000)),prev[1]+int(np.clip(b-prev[1],-32000,32000)))
            out.append((step[0]-prev[0],step[1]-prev[1])); prev=step
        out.append((a-prev[0],b-prev[1])); prev=(a,b)
    cnt.append(len(out)); dl+=out
cnt=np.array(cnt); print('max inner',cnt.max(),'total inner',cnt.sum())
# verify geometry orientation for a sample
bad=0
for k in range(0,len(U),5000):
    g0=R['GEO'][k][0]; nu=R['NXY'][U[k]]
    if np.hypot(*(g0-nu))>1: bad+=1
print('orientation mismatches (sample)',bad)
cnt16=cnt.astype(np.uint16)
lens=np.round(R['LEN']).astype(np.uint32)
attr=(R['CL']|(R['HS']<<3)).astype(np.uint8)
dl=np.array(dl,np.int16).reshape(-1)
parts=[lat.astype(np.int32).tobytes(),lon.astype(np.int32).tobytes(),U.astype(np.int32).tobytes(),V.astype(np.int32).tobytes(),
       lens.astype(np.uint32).tobytes(),cnt16.tobytes(),dl.tobytes(),attr.tobytes()]
hdr=struct.pack('<4I',len(lat),len(U),int(cnt.sum()),0)
raw=hdr+b''.join(parts)
z=gzip.compress(raw,9); b=base64.b64encode(z).decode()
open('build/roads.b64','w').write(b)
print('raw MB',len(raw)/1e6,'gz MB',len(z)/1e6,'b64 MB',len(b)/1e6)
