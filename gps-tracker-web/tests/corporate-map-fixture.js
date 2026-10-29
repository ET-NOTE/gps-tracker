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
  class Shape {constructor({map}){this.node=document.createElement('span');this.node.textContent='● 구역';this.node.style.cssText='position:absolute;top:45%;left:45%;color:#2461ed';map.node.append(this.node);}setMap(m){if(!m)this.node.remove();}}
  const services={Status:{OK:'OK',ZERO_RESULT:'ZERO_RESULT'},Geocoder:class{addressSearch(q,cb){cb(q.includes('없음')?[]:[{address_name:'서울특별시 중구 세종대로 110',x:'126.978',y:'37.5665',road_address:{building_name:'서울시청',address_name:'서울특별시 중구 세종대로 110'}}],q.includes('없음')?'ZERO_RESULT':'OK');}},Places:class{keywordSearch(q,cb){cb([],'ZERO_RESULT');}}};
  window.kakao={maps:{Map,LatLng,LatLngBounds:Bounds,CustomOverlay:Overlay,Circle:Shape,Polygon:Shape,Marker:Shape,services,event:{addListener:(m,e,cb)=>{listeners.set(m,cb);if(e==='click'){m.click=ev=>cb({latLng:new LatLng(37.5665+ev.offsetY/100000,126.978+ev.offsetX/100000)});m.node.addEventListener('click',m.click);}},removeListener:(m,e)=>{listeners.delete(m);if(e==='click')m.node.removeEventListener('click',m.click);}}}};
}
