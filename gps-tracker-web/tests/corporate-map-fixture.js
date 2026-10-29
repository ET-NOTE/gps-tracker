// Synthetic map for component interaction tests. Never imported by production.
export function installCorporateMapFixture() {
  const listeners=new WeakMap();
  class LatLng { constructor(lat,lng){this.lat=lat;this.lng=lng;} getLat(){return this.lat;} getLng(){return this.lng;} }
  class Bounds { constructor(){this.points=[];} extend(p){this.points.push(p);} getSouthWest(){return this.points[0];} }
  class Map {
    constructor(node,{center}){this.node=node;this.center=center;node.style.background='#e8f0ed';const label=document.createElement('p');label.textContent='모의 지도 · 배치·선택 동작 검증';label.style.cssText='position:absolute;bottom:0;left:12px;font-size:12px';node.append(label);}
    getCenter(){return this.center;} setCenter(p){this.center=p;} relayout(){} setLevel(){} setBounds(b){this.center=b.points[0];} panTo(p){this.center=p;listeners.get(this)?.();}
    getProjection(){return {containerPointFromCoords:p=>({x:this.node.clientWidth/2+(p.lng-126.978)*50000,y:100+(p.lat-37.5665)*50000})};}
  }
  class Overlay {constructor({map,content,position}){this.node=document.createElement('div');const p=map.getProjection().containerPointFromCoords(position);this.node.style.cssText=`position:absolute;left:${p.x}px;top:${p.y}px;transform:translate(-50%,-100%)`;this.node.append(content);map.node.append(this.node);}setMap(value){if(!value)this.node.remove();}}
  window.kakao={maps:{Map,LatLng,LatLngBounds:Bounds,CustomOverlay:Overlay,event:{addListener:(m,e,cb)=>listeners.set(m,cb),removeListener:m=>listeners.delete(m)}}};
}
