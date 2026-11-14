import DialogHost, {confirmDialog} from '../src/components/Dialog';
// Isolated UI fixture: no account tokens, backend calls or device writes.
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import '../src/index.css';
import {initTheme} from '../src/theme';
import Modal from '../src/components/ui/Modal';
import RouteNotice from '../src/components/RouteNotice';
import FleetDashboard from '../src/pages/FleetDashboard';
import KakaoMap from '../src/components/KakaoMap';
import {api} from '../src/api';
import {TrackerWS} from '../src/ws';
initTheme();
for(const name of Object.keys(api))api[name]=async()=>{throw Error('No backend in fixture');};
const at=new Date().toISOString();
Object.assign(api,{listDevices:async()=>[{id:1,display_name:'차량 A',last_seen_at:at,last_event_kind:'sleep_enter'}, {id:2,display_name:'차량 B',last_seen_at:at,last_fix_at:at}],getDeviceEvents:async()=>[],listTrips:async()=>[]});
for(const name of ['connect','subscribe','disconnect'])TrackerWS.prototype[name]=()=>{};
let broken=true;
const append=document.head.appendChild.bind(document.head);
document.head.appendChild=node=>{
 if(node.dataset?.kakaoMapSdk){
   node.removeAttribute('src');
   const result=append(node);
   setTimeout(()=>{
     if(broken)node.dispatchEvent(new Event('error'));
     else{
       class LatLng{constructor(lat,lng){this.lat=lat;this.lng=lng;}getLat(){return this.lat;}getLng(){return this.lng;}}
       class Map{constructor(node,opts){this.node=node;this.center=opts.center;this.level=opts.level;node.style.background='#e8f2ef';node.insertAdjacentHTML('beforeend','<p style="padding:30px;color:#326457">지도 초기화 완료 · 모의 지도</p>');}getNode(){return this.node;}getLevel(){return this.level;}getCenter(){return this.center;}setCenter(c){this.center=c;}relayout(){} }
       window.kakao={maps:{Map,LatLng,InfoWindow:class{close(){}},MarkerClusterer:class{clear(){}},event:{addListener(){},removeListener(){}}}};
       node.dispatchEvent(new Event('load'));
     }
   },20);return result;
 }
 return append(node);
};
function Preview(){
 const [mode,setMode]=useState('fleet'),[open,setOpen]=useState(false),[nested,setNested]=useState(false),[network,setNetwork]=useState(false);
 return <div style={{height:'100%',display:'flex',flexDirection:'column'}}>
  <div style={{padding:8,display:'flex',gap:8,flexWrap:'wrap',background:'var(--surface)'}}>
   {['fleet','modal','map','denied','missing'].map(id=><button key={id} onClick={()=>setMode(id)}>{id}</button>)}
  </div>
  <div className="preview-content" style={{flex:1,minHeight:0,display:'flex',flexDirection:'column'}}>
   <style>{'.preview-content > div {height:100%!important;}'}</style>
   {mode==='fleet'&&<FleetDashboard/>}
   {mode==='modal'&&<div style={{padding:24}}><h1>모달 포커스 검증</h1><button onClick={()=>setOpen(true)}>예약 입력 열기</button><a href="#background">배경 링크</a>
     <Modal open={open} onClose={()=>setOpen(false)} title="새 예약" footer={<><button onClick={()=>setOpen(false)}>취소</button><button onClick={()=>setNested(true)}>중첩 확인 열기</button></>}>
      <button onClick={()=>confirmDialog({title:"저장 확인",body:"모의 확인창"})}>공통 확인 열기</button><label>차량 이름<input aria-label="차량 이름" /></label><label>메모<textarea aria-label="메모"/></label><button disabled>비활성</button>
     </Modal>
     <Modal open={nested} onClose={()=>setNested(false)} title="확인"><button onClick={()=>setNested(false)}>확인 닫기</button></Modal>
   </div>}
   {mode==='map'&&<><button onClick={()=>{broken=false;setNetwork(true);}}>지도 연결 복구</button><p role="status">{network?'모의 연결 복구됨':'모의 연결 실패 중'}</p><div style={{flex:1,minHeight:0}}><KakaoMap/></div></>}
   {['denied','missing'].includes(mode)&&<RouteNotice kind={mode}/>}
  </div><DialogHost/>
 </div>;
}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><Preview/></MemoryRouter></QueryClientProvider>);
