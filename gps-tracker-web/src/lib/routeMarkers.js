// Sampling affects display only: paths, timestamps and point details stay intact.
export function screenBearing(from, to) {
  if (![from?.x,from?.y,to?.x,to?.y].every(Number.isFinite)) return null;
  const dx=to.x-from.x,dy=to.y-from.y;
  return Math.hypot(dx,dy)<0.5 ? null : (Math.atan2(dx,-dy)*180/Math.PI+360)%360;
}
export function spacedMarkerIndexes(points, spacing=48, viewport=null) {
  const selected=new Set(),grid=new Map();
  const candidates=points.map((p,i)=>({...p,i})).filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)
    &&(!viewport||(p.x>=-24&&p.y>=-24&&p.x<=viewport.width+24&&p.y<=viewport.height+24)))
    .sort((a,b)=>(b.priority||0)-(a.priority||0)||b.i-a.i);
  for(const p of candidates){
    const x=Math.floor(p.x/spacing),y=Math.floor(p.y/spacing);let crowded=false;
    for(let dx=-1;dx<=1&&!crowded;dx++)for(let dy=-1;dy<=1&&!crowded;dy++)
      crowded=(grid.get(`${x+dx}:${y+dy}`)||[]).some(q=>Math.hypot(p.x-q.x,p.y-q.y)<spacing);
    if(crowded)continue;
    selected.add(p.i);const key=`${x}:${y}`;if(!grid.has(key))grid.set(key,[]);grid.get(key).push(p);
  }
  return selected;
}
