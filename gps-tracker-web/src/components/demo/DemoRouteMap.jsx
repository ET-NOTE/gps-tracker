import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { loadKakaoMaps } from '../../lib/kakaoSdk';
import Icon from '../Icon';

const ink = '#3476c8';
function marker(type, label) {
  const element = document.createElement('span');
  element.className = 'demo-map-marker demo-marker-' + type;
  element.textContent = label;
  return element;
}

// Keep a local overview of the recorded points available while tiles are loading.
function RouteSketch({ vehicle, position, zoom }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    function draw() {
      const {width,height} = canvas.getBoundingClientRect();
      if (width < 2 || height < 2) return;
      const scale = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(scale, scale);
      ctx.clearRect(0, 0, width, height);
      const projection = Math.cos(vehicle.points[0][0] * Math.PI/180);
      const xy = vehicle.points.map(([lat,lng]) => [lng * projection, -lat]);
      const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
      const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
      const fit = Math.min((width-110)/(xmax-xmin),(height-112)/(ymax-ymin));
      const points = xy.map(([x,y]) => [width/2+(x-(xmin+xmax)/2)*fit*zoom, height/2+(y-(ymin+ymax)/2)*fit*zoom]);
      const line = (coords, color, weight) => {
        ctx.strokeStyle = color; ctx.lineWidth = weight; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
        coords.forEach(([x,y],i) => i ? ctx.lineTo(x,y) : ctx.moveTo(x,y)); ctx.stroke();
      };
      line(points,'#ffffff',10);
      line(points,'#a8bcd3',6);
      line(points.slice(0,position+1),ink,5);
      function dot([x,y], radius, color) {
        ctx.beginPath(); ctx.arc(x,y,radius,0,Math.PI*2); ctx.fillStyle=color; ctx.fill();
        ctx.strokeStyle='white'; ctx.lineWidth=3; ctx.stroke();
      }
      dot(points[0],7,'#348771');
      dot(points.at(-1),7,'#284a73');
      dot(points[position],8,ink);
      ctx.font='600 13px system-ui, sans-serif';
      for (const [location,text,below] of [[points[0],vehicle.from,false],[points.at(-1),vehicle.to,true]]) {
        const tw=ctx.measureText(text).width;
        const x=Math.min(width-tw-13,Math.max(12,location[0]-tw/2));
        const y=Math.max(30,Math.min(height-20,location[1]+(below?27:-16)));
        ctx.lineWidth=5;ctx.strokeStyle='#fff';ctx.strokeText(text,x,y);ctx.fillStyle='#274564';ctx.fillText(text,x,y);
      }
    }
    const resize = new ResizeObserver(draw);
    resize.observe(canvas); draw();
    return () => resize.disconnect();
  }, [vehicle, position, zoom]);
  return <canvas ref={ref} className="demo-route-sketch" aria-label={vehicle.from + '에서 ' + vehicle.to + '까지의 예시 경로 약도'} role="img"/>;
}

export default function DemoRouteMap({ vehicle, position }) {
  const host = useRef(null);
  const engine = useRef(null);
  const latestPosition = useRef(position);
  latestPosition.current = position;
  const [tiles, setTiles] = useState(false);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    let cancelled=false;
    let dispose;
    setTiles(false); setZoom(1);
    loadKakaoMaps().then(kakao => {
      if (cancelled || !host.current) return;
      const node = host.current, maps = kakao.maps;
      const coords = vehicle.points.map(([lat,lng]) => new maps.LatLng(lat,lng));
      const map = new maps.Map(node, {center:coords[0],level:6,scrollwheel:false});
      const bounds = new maps.LatLngBounds();
      for (const point of coords) bounds.extend(point);
      const fit = () => { map.relayout(); map.setBounds(bounds,52,52,56,52); };
      const line = new maps.Polyline({map,path:coords,strokeWeight:5,strokeColor:ink,strokeOpacity:0.88});
      const pins = [
        new maps.CustomOverlay({map,position:coords[0],content:marker('start','출발'),yAnchor:1.2}),
        new maps.CustomOverlay({map,position:coords.at(-1),content:marker('end','도착'),yAnchor:1.2}),
      ];
      const tracking = new maps.CustomOverlay({map,position:coords.at(-1),content:marker('vehicle','●'),zIndex:5});
      const ready = () => {if (!cancelled) setTiles(true);};
      maps.event.addListener(map,'tilesloaded',ready);
      const observer = new ResizeObserver(fit);
      observer.observe(node);
      engine.current = {map,coords,tracking,fit};
      tracking.setPosition(coords[latestPosition.current]);
      fit();
      dispose=()=>{
        observer.disconnect();
        maps.event.removeListener(map,'tilesloaded',ready);
        line.setMap(null); tracking.setMap(null); pins.forEach(pin=>pin.setMap(null));
        node.replaceChildren();
      };
    }).catch(() => { if (!cancelled) setTiles(false); });
    return () => {cancelled=true;engine.current=null;dispose?.();};
  }, [vehicle]);
  useEffect(()=>{
    const active=engine.current;
    if (active) active.tracking.setPosition(active.coords[position]);
  },[position]);

  function adjust(level) {
    if (tiles && engine.current) {
      const map=engine.current.map;
      map.setLevel(Math.max(1,Math.min(14,map.getLevel()+level)));
    } else setZoom(v => Math.max(0.6, Math.min(2.4, v * (level > 0 ? 0.8 : 1.25))));
  }
  function fitAll() { setZoom(1);engine.current?.fit(); }
  return <div className="demo-map-stage">
    <div ref={host} className="demo-kakao-map" style={{opacity:tiles?1:0, pointerEvents:tiles?'auto':'none'}} role="img" aria-label={vehicle.name+' 예시 운행 지도'}/>
    {!tiles && <RouteSketch vehicle={vehicle} position={position} zoom={zoom}/>}
    <span className="demo-map-locality"><Icon name="mapPin" size={15}/>{vehicle.city}{!tiles && ' · 경로 약도'}</span>
    <div className="demo-map-controls" aria-label="지도 조작">
      <button type="button" aria-label="지도 확대" onClick={()=>adjust(-1)}>+</button>
      <button type="button" aria-label="지도 축소" onClick={()=>adjust(1)}>−</button>
      <button type="button" aria-label="전체 경로 보기" title="전체 경로 보기" onClick={fitAll}><Icon name="route" size={17}/></button>
    </div>
  </div>;
}
