import {useEffect,useRef,useState} from 'react';
import {loadKakaoMaps} from '../../lib/kakaoSdk';

export default function FleetSiteMap({geometry,onPick,focus}){
 const canvas=useRef(null),map=useRef(null),pick=useRef(onPick);
 const [ready,setReady]=useState(false),[error,setError]=useState(false),[retry,setRetry]=useState(0);
 pick.current=onPick;
 useEffect(()=>{
  let disposed=false,observer,instance,click;
  setError(false);setReady(false);
  loadKakaoMaps().then(()=>{
   if(disposed||!canvas.current)return;
   const sdk=window.kakao.maps;instance=new sdk.Map(canvas.current,{center:new sdk.LatLng(36.5,127.5),level:12});map.current=instance;
   click=e=>pick.current?.([e.latLng.getLat(),e.latLng.getLng()]);sdk.event.addListener(instance,'click',click);
   observer=new ResizeObserver(()=>{const center=instance.getCenter();instance.relayout();instance.setCenter(center);});observer.observe(canvas.current);setReady(true);
  }).catch(()=>{if(!disposed)setError(true);});
  return()=>{disposed=true;observer?.disconnect();if(instance&&click)window.kakao.maps.event.removeListener(instance,'click',click);map.current=null;};
 },[retry]);
 useEffect(()=>{
  if(!ready||!map.current)return;const sdk=window.kakao.maps,items=[];
  if(geometry?.type==='circle'&&Number.isFinite(geometry.lat)&&Number.isFinite(geometry.lng)){
   const center=new sdk.LatLng(geometry.lat,geometry.lng);
   items.push(new sdk.Circle({map:map.current,center,radius:Math.max(20,Number(geometry.radius_m)||20),strokeWeight:2,strokeColor:'#2461ed',fillColor:'#2461ed',fillOpacity:.13}));
   items.push(new sdk.Marker({map:map.current,position:center}));
  }else if(geometry?.type==='polygon'&&geometry.points.length){
   const path=geometry.points.map(p=>new sdk.LatLng(p[0],p[1]));
   if(path.length>=3)items.push(new sdk.Polygon({map:map.current,path,strokeWeight:2,strokeColor:'#2461ed',fillColor:'#2461ed',fillOpacity:.13}));
   path.forEach(position=>items.push(new sdk.Marker({map:map.current,position})));
  }
  return()=>items.forEach(x=>x.setMap(null));
 },[geometry,ready]);
 useEffect(()=>{
  if(!ready||!map.current)return;const sdk=window.kakao.maps;
  const points=focus?[focus]:geometry?.type==='circle'&&Number.isFinite(geometry.lat)?[[geometry.lat,geometry.lng]]:geometry?.points||[];
  if(!points.length)return;
  if(points.length===1&&geometry?.type==='circle'){
   const [lat,lng]=points[0],dy=(Number(geometry.radius_m)||200)/111195,dx=dy/Math.cos(lat*Math.PI/180),bounds=new sdk.LatLngBounds();
   bounds.extend(new sdk.LatLng(lat-dy,lng-dx));bounds.extend(new sdk.LatLng(lat+dy,lng+dx));map.current.setBounds(bounds,40,40,40,40);
  }else if(points.length===1){map.current.setCenter(new sdk.LatLng(...points[0]));map.current.setLevel(4);}
  else{const b=new sdk.LatLngBounds();points.forEach(p=>b.extend(new sdk.LatLng(...p)));map.current.setBounds(b,35,35,35,35);}
 },[ready,focus]); // Drawing a vertex or adjusting a radius must not move the camera.
 return <div className="fleet-site-map-wrap"><div ref={canvas} className="fleet-site-map" aria-label={onPick?'지점 구역 지정 지도':'지점 위치 지도'}/>{(!ready||error)&&<div className="fleet-site-map-status" role="status">{error?<>지도를 불러오지 못했습니다.<button type="button" className="business-button" onClick={()=>setRetry(n=>n+1)}>다시 시도</button></>:'지도 불러오는 중…'}</div>}</div>;
}
