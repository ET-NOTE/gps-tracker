import React,{useEffect,useImperativeHandle,useState} from 'react';
export default React.forwardRef(function PreviewMap({onReady},ref){
 const [markers,setMarkers]=useState({}),[path,setPath]=useState(null);
 useImperativeHandle(ref,()=>({updateMarker:(id,lat,lng,label)=>setMarkers(prev=>({...prev,[id]:{lat,lng,label}})),removeMarker:id=>setMarkers(prev=>{const next={...prev};delete next[id];return next;}),filterToDevice(){},setSeekerMode(){},clearSeekerPath:()=>setPath(null),clearSeekerPathCanvas:()=>setPath(null),drawSeekerPath:points=>setPath(points),drawSeekerPathCanvas:points=>setPath(points)}),[]);
 useEffect(()=>{onReady();},[onReady]);
 return <div style={{height:'100%',display:'grid',placeContent:'center',background:'#e8f0ed',color:'#416658',textAlign:'center',padding:24}}>
  <strong>모의 지도 · 실제 위치 데이터 미사용</strong><p>지도 SDK 대신 복구 상태와 배치를 검증합니다.</p>
  {Object.values(markers).map((m,i)=><p key={i}>{m.label} · {m.lat}, {m.lng}</p>)}
  {path&&<p>선택한 운행 · {path.length}개 위치 표시</p>}
 </div>;
});
