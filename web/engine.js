async function loadRoads(){
  const bin=Uint8Array.from(atob(ROADS_B64),c=>c.charCodeAt(0));
  const ds=new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
  const buf=await new Response(ds).arrayBuffer();
  const hdr=new Uint32Array(buf.slice(0,16));const NN=hdr[0],NE=hdr[1],NI=hdr[2];let o=16;
  const take=(Ctor,cnt)=>{const bytes=cnt*Ctor.BYTES_PER_ELEMENT;const a=new Ctor(buf.slice(o,o+bytes));o+=bytes;return a};
  const lat=take(Int32Array,NN),lon=take(Int32Array,NN),U=take(Int32Array,NE),V=take(Int32Array,NE),LEN=take(Uint32Array,NE),CNT=take(Uint16Array,NE),DL=take(Int16Array,NI*2),AT=take(Uint8Array,NE);
  const nla=new Float64Array(NN),nlo=new Float64Array(NN);for(let i=0;i<NN;i++){nla[i]=lat[i]/1e6;nlo[i]=lon[i]/1e6}
  const OFF=new Uint32Array(NE+1);for(let e=0;e<NE;e++)OFF[e+1]=OFF[e]+CNT[e];
  const ila=new Float64Array(NI),ilo=new Float64Array(NI);
  for(let e=0;e<NE;e++){let pa=lat[U[e]],po=lon[U[e]];for(let k=OFF[e];k<OFF[e+1];k++){pa+=DL[2*k];po+=DL[2*k+1];ila[k]=pa/1e6;ilo[k]=po/1e6}}
  const CL=new Uint8Array(NE),HS=new Uint8Array(NE);for(let e=0;e<NE;e++){CL[e]=AT[e]&7;HS[e]=AT[e]>>3}
  // CSR adjacency
  const deg=new Uint32Array(NN+1);for(let e=0;e<NE;e++){deg[U[e]+1]++;deg[V[e]+1]++}for(let i=0;i<NN;i++)deg[i+1]+=deg[i];
  const AE=new Int32Array(2*NE),fill=deg.slice(0,NN);for(let e=0;e<NE;e++){AE[fill[U[e]]++]=e;AE[fill[V[e]]++]=e}
  // mercator (0..1)
  const mx=v=>(v+180)/360,my=v=>{const s=Math.sin(v*Math.PI/180);return 0.5-Math.log((1+s)/(1-s))/(4*Math.PI)};
  const NX=new Float64Array(NN),NY=new Float64Array(NN);for(let i=0;i<NN;i++){NX[i]=mx(nlo[i]);NY[i]=my(nla[i])}
  const IX=new Float64Array(NI),IY=new Float64Array(NI);for(let k=0;k<NI;k++){IX[k]=mx(ilo[k]);IY[k]=my(ila[k])}
  // snap grid (0.01°)
  const grid=new Map();for(let i=0;i<NN;i++){const key=Math.floor(nla[i]*100)*100000+Math.floor(nlo[i]*100);let a=grid.get(key);if(!a){a=[];grid.set(key,a)}a.push(i)}
  // draw order: lower classes first
  const bk=Array.from({length:16},()=>[]);for(let e=0;e<NE;e++)bk[CL[e]*2+HS[e]].push(e);
  RN={NN,NE,NI,nla,nlo,U,V,LEN,CL,HS,OFF,ila,ilo,deg,AE,NX,NY,IX,IY,grid,bk:bk.map(a=>Int32Array.from(a))};
  // hub & station nodes
  $$('[data-roadstatus]').forEach(el=>el.hidden=true);
  roadWaiters.splice(0).forEach(f=>f());
}
function snap(la,lo){const R=RN;let best=-1,bd=1e18;for(let r=1;r<=4&&best<0;r++){const ki=Math.floor(la*100),kj=Math.floor(lo*100);
  for(let a=-r;a<=r;a++)for(let b=-r;b<=r;b++){const arr=R.grid.get((ki+a)*100000+(kj+b));if(!arr)continue;for(const i of arr){const d=(R.nla[i]-la)**2+((R.nlo[i]-lo)*0.88)**2;if(d<bd){bd=d;best=i}}}}
  return {node:best,dist:hav(la,lo,R.nla[best],R.nlo[best])}}
function wCost(e,lam){const R=RN;if(lam<0)return R.LEN[e];return R.LEN[e]*(1+lam*R.HS[e])*(1+(lam/1.5)*(CLF[R.CL[e]]-1))}
// generic search. mode: lam<0 → walking length; returns arrays
class Heap{constructor(){this.k=[];this.v=[]}push(key,val){const k=this.k,v=this.v;k.push(key);v.push(val);let i=k.length-1;while(i>0){const p=(i-1)>>1;if(k[p]<=k[i])break;[k[p],k[i]]=[k[i],k[p]];[v[p],v[i]]=[v[i],v[p]];i=p}}
  pop(){const k=this.k,v=this.v;const tv=v[0],tk=k[0];const lk=k.pop(),lv=v.pop();if(k.length){k[0]=lk;v[0]=lv;let i=0;for(;;){const l=2*i+1,r=l+1;let m=i;if(l<k.length&&k[l]<k[m])m=l;if(r<k.length&&k[r]<k[m])m=r;if(m===i)break;[k[m],k[i]]=[k[i],k[m]];[v[m],v[i]]=[v[i],v[m]];i=m}}return [tk,tv]}get size(){return this.k.length}}
function search(src,{lam=-1,dst=-1,targets=null,limit=Infinity}={}){
  const R=RN,NN=R.NN;const g=new Float64Array(NN).fill(Infinity),len=new Float64Array(NN).fill(Infinity),pe=new Int32Array(NN).fill(-1),done=new Uint8Array(NN);
  const H=new Heap();g[src]=0;len[src]=0;
  const hfun=dst>=0?(i=>hav(R.nla[i],R.nlo[i],R.nla[dst],R.nlo[dst])):(()=>0);
  H.push(hfun(src),src);let hit=-1;
  while(H.size){const [,i]=H.pop();if(done[i])continue;done[i]=1;
    if(i===dst){hit=i;break}if(targets&&targets.has(i)){hit=i;break}if(g[i]>limit)break;
    for(let k=R.deg[i];k<R.deg[i+1];k++){const e=R.AE[k];const j=R.U[e]===i?R.V[e]:R.U[e];const ng=g[i]+wCost(e,lam);
      if(ng<g[j]){g[j]=ng;len[j]=len[i]+R.LEN[e];pe[j]=e;H.push(ng+hfun(j),j)}}}
  return {g,len,pe,hit,done}}
function pathEdges(res,src,dst){const R=RN,out=[];let cur=dst;let guard=0;while(cur!==src&&guard++<1e6){const e=res.pe[cur];if(e<0)return null;out.push(e);cur=R.U[e]===cur?R.V[e]:R.U[e]}return out.reverse()}
function edgesToLatLng(edges,src){const R=RN,pts=[[R.nla[src],R.nlo[src]]];let cur=src;
  for(const e of edges){const fwd=R.U[e]===cur;const inner=[];for(let k=R.OFF[e];k<R.OFF[e+1];k++)inner.push([R.ila[k],R.ilo[k]]);if(!fwd)inner.reverse();pts.push(...inner);cur=fwd?R.V[e]:R.U[e];pts.push([R.nla[cur],R.nlo[cur]])}return pts}
function edgeStats(edges){const R=RN;let km=0,hs=0,art=0;const byc=new Float64Array(8);for(const e of edges){km+=R.LEN[e];if(R.HS[e])hs+=R.LEN[e];if(R.CL[e]<=1)art+=R.LEN[e];byc[R.CL[e]]+=R.LEN[e]}return {m:km,hs,art,byc}}
function route(a,b,lam){if(a===b)return {edges:[],m:0,hs:0,art:0,byc:new Float64Array(8)};const r=search(a,{lam,dst:b});if(r.hit<0)return null;const ed=pathEdges(r,a,b);if(!ed)return null;return Object.assign({edges:ed},edgeStats(ed))}

/* road canvas layer */
const RoadLayer=L.Layer.extend({
  initialize(opts){this.o=Object.assign({mode:'stress',faint:false,cor:false,prio:false,vans:false,hl:null},opts)},
  onAdd(map){this._map=map;this.cv=L.DomUtil.create('canvas','roadcanvas');map.getPanes().overlayPane.appendChild(this.cv);map.on('moveend zoomend resize',this.redraw,this);this.redraw()},
  onRemove(map){this.cv.remove();map.off('moveend zoomend resize',this.redraw,this)},
  set(o){Object.assign(this.o,o);this.redraw()},
  redraw(){if(!this._map||!RN)return;const map=this._map,R=RN,sz=map.getSize(),dpr=window.devicePixelRatio||1,cv=this.cv;
    cv.width=sz.x*dpr;cv.height=sz.y*dpr;cv.style.width=sz.x+'px';cv.style.height=sz.y+'px';L.DomUtil.setPosition(cv,map.containerPointToLayerPoint([0,0]));
    const ctx=cv.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.lineCap='round';ctx.lineJoin='round';
    const z=map.getZoom(),sc=256*Math.pow(2,z),pb=map.getPixelBounds().min,ox=pb.x,oy=pb.y;
    const b=map.getBounds().pad(0.05),la0=b.getSouth(),la1=b.getNorth(),lo0=b.getWest(),lo1=b.getEast();
    const minCl=z<11?3:z<12.25?4:z<13.25?6:7;
    const dk=isDark(),o=this.o;const roadC=css('--road'),hiC=css('--road-hi');
    const CLCOL=dk?['#e66767','#d95926','#c98500','#5598e7','#7d8ea5','#55667c','#55667c','#3d4b5d']:['#d03b3b','#eb6834','#c98500','#2a78d6','#7d8ea5','#9aa6b6','#9aa6b6','#c3cad4'];
    const W=[3.2,2.6,2.1,1.6,1.1,0.9,0.9,0.7].map(w=>w*(z>=14?1.6:z>=13?1.25:1));
    const alpha=o.faint?0.5:1;
    const vis=e=>{const u=R.U[e],v=R.V[e];const a1=R.nla[u],a2=R.nla[v],b1=R.nlo[u],b2=R.nlo[v];return !((a1<la0&&a2<la0)||(a1>la1&&a2>la1)||(b1<lo0&&b2<lo0)||(b1>lo1&&b2>lo1))};
    const trace=e=>{const u=R.U[e];ctx.moveTo(R.NX[u]*sc-ox,R.NY[u]*sc-oy);for(let k=R.OFF[e];k<R.OFF[e+1];k++)ctx.lineTo(R.IX[k]*sc-ox,R.IY[k]*sc-oy);const v=R.V[e];ctx.lineTo(R.NX[v]*sc-ox,R.NY[v]*sc-oy)};
    // base roads batched by (class, stress)
    ctx.globalAlpha=alpha;
    for(let cl=7;cl>=0;cl--){if(cl>minCl)continue;for(const hs of [0,1]){ctx.beginPath();let any=false;
      const list=R.bk[cl*2+hs];for(let q=0;q<list.length;q++){const e=list[q];if(!vis(e))continue;trace(e);any=true}
      if(!any)continue;ctx.lineWidth=W[cl];
      ctx.strokeStyle=o.faint?roadC:(o.mode==='class'?CLCOL[cl]:(hs?hiC:roadC));ctx.stroke()}}
    ctx.globalAlpha=1;
    if(o.cor){const list=M.corridors;const mxp=Math.max(...list.map(c=>c.priority));const O=dk?ORNG_D:ORNG_L,cc=css('--corridor');
      const sorted=o.prio?list.slice().sort((a,b)=>a.priority-b.priority):list.slice().sort((a,b)=>a.load-b.load);
      for(const c of sorted){const v=o.prio?c.priority/mxp:c.load;if(v<0.03||!vis(c.e))continue;ctx.beginPath();trace(c.e);ctx.lineWidth=(1.4+6*Math.sqrt(v))*(z>=13?1.3:1);ctx.strokeStyle=o.prio?ramp(O,0.3+0.7*v):cc;ctx.stroke()}}
    if(o.vans){ctx.setLineDash([6,5]);ctx.strokeStyle=css('--van');ctx.lineWidth=2.4;ctx.beginPath();M.vans.forEach(v=>v.edges.forEach(e=>{if(vis(e))trace(e)}));ctx.stroke();ctx.setLineDash([])}
    if(o.hl){ctx.lineWidth=7;ctx.strokeStyle=css('--gold');ctx.beginPath();trace(o.hl);ctx.stroke()}
  }});
