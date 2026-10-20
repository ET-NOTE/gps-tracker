// Synthetic data, no backend access or real device actions.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import FleetDashboard from '../src/pages/FleetDashboard';
import {api} from '../src/api';
import {TrackerWS} from '../src/ws';
import '../src/index.css';
import {initTheme} from '../src/theme';
initTheme();
let failed=true,ws;
const at=new Date().toISOString();
for(const key of Object.keys(api))api[key]=async()=>{throw Error('No backend in preview');};
Object.assign(api,{
 listDevices:async()=>[{id:1,car_plate:'12가 3456',display_name:'검증 차량',last_seen_at:at,last_event_kind:'wake'}],
 getDeviceEvents:async()=>{if(failed)throw Error('simulated offline');return[{id:1,kind:'sleep_enter',occurred_at:at}];},
 listTrips:async()=>[{started_at:'2026-10-20T00:00:00Z',ended_at:'2026-10-20T00:20:00Z',distance_m:1800}],
 listLocationsGrouped:async()=>{if(failed)throw Error('simulated offline');return[{lat:37,lng:127,recorded_at:'2026-10-20T00:00:00Z'},{lat:37.001,lng:127.001,recorded_at:'2026-10-20T00:20:00Z'}];},
 flattenGroupedAsc:points=>points,
});
TrackerWS.prototype.connect=function(){ws=this;this.onStatus?.('connected');};
TrackerWS.prototype.subscribe=()=>{};TrackerWS.prototype.disconnect=()=>{};
function Preview(){const[recovered,setRecovered]=useState(false);return <div style={{height:'100dvh',display:'flex',flexDirection:'column'}}>
 <div style={{padding:8,display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',background:'var(--surface)',fontSize:12}}><strong>격리된 모의 데이터 검증</strong>
  <button onClick={()=>{failed=false;setRecovered(true);}}>조회 복구</button><button onClick={()=>ws?.onStatus('disconnected')}>연결 끊김</button><button onClick={()=>{ws?.onStatus('connected');ws?.onEvent({type:'resync'});}}>재연결</button><span>{recovered?'조회 가능':'조회 실패 중'}</span>
 </div><div style={{flex:1,minHeight:0,display:'flex',flexDirection:'column'}}><style>{'.preview-fleet > div{height:100%!important}'}</style><div className="preview-fleet" style={{height:'100%'}}><FleetDashboard/></div></div>
 </div>;}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter initialEntries={['/fleet?device=1']}><Preview/></MemoryRouter></QueryClientProvider>);
