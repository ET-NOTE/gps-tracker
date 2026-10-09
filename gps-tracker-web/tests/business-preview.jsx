import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/index.css';
import { initTheme, applyTheme } from '../src/theme';
import { api } from '../src/api';
import CorporatePanel from '../src/components/CorporatePanel';
import RentcarPanel from '../src/components/RentcarPanel';
import { businessDate } from '../src/lib/business';

// Isolated visual fixture: all network methods are stubbed and all mutations fail.
const params = new URLSearchParams(location.search);
const failed = params.has('error'), empty = params.has('empty');
const now = Date.now(), day = businessDate(now), at = h => `${day}T${h}:00:00+09:00`;
const devices = empty ? [] : [
  { id: 1, display_name: '서울 영업 1호', car_plate: '123가 4567', car_model: '쏘나타', department: '영업팀', enabled: true, last_seen_at: new Date(now).toISOString(), last_fix_at: new Date(now).toISOString(), next_service_date: day },
  { id: 2, display_name: '업무용 차량 2호', license_plate: '234나 8901', car_model: '아반떼', department: '관리팀', enabled: true, last_seen_at: new Date(now - 700_000).toISOString(), insurance_expiry: day },
  { id: 3, display_name: '장기렌트 고객 차량', license_plate: '345다 6789', car_model: '카니발', enabled: true, last_seen_at: new Date(now).toISOString(), last_fix_at: new Date(now).toISOString() },
  { id: 4, display_name: '정비 대기', license_plate: '456라 0123', car_model: '그랜저', enabled: false },
];
const rental = (id, device, status, start, end) => ({ id, device_id: device.id, device_name: device.display_name, license_plate: device.car_plate || device.license_plate, renter_name: `미리보기 고객 ${id}`, starts_at: start, ends_at: end, status, rate_type: 'daily', rate_amount_krw: 70000, deposit_krw: 100000 });
const rentals = empty ? [] : [rental(1, devices[0], 'active', at('08'), at('23')), rental(2, devices[1], 'overdue', new Date(now-200*86400000).toISOString(), new Date(now-190*86400000).toISOString()), rental(3, devices[2], 'draft', at('22'), at('23')),
  {...rental(4, devices[0], 'returned', at('00'), at('01')), settled_at: at('02'), settled_amount_krw: 140000 }];
const reservations = empty ? [] : [{ id: 1, device_id: 1, driver_name: '미리보기 운전자', driver_staff_id: 1, device_name: '서울 영업 1호', license_plate: '123가 4567', status: 'planned', starts_at: at('09'), ends_at: at('18'), purpose: '고객사 방문' }];
for (const key of Object.keys(api)) api[key] = async () => { throw Error('미리보기에서는 서버 작업을 수행하지 않습니다.'); };
const read = value => async () => { if (failed) throw Error('의도한 조회 오류'); return value; };
Object.assign(api, {
  listRentals: read(rentals), listReservations: read(reservations), listStaff: read(empty ? [] : [{id:1,name:'미리보기 운전자',role:'영업',active:true}]),
  getCorporateInfo: read({company_name:'미리보기 회사',business_number:'000-00-00000',representative:'미리보기'}),
  getCorporateSubscription: read({active:true,price_krw:30000,expires_at:new Date(now+86400000*20).toISOString()}),
  getRentcarSubscription: read({active:true,price_krw:30000,expires_at:new Date(now+86400000*20).toISOString()}),
  fleetTripStats: read({per_device: devices.map(d => ({device_id:d.id,total_distance_m:123000,today_distance_m:32000}))}),
  listTrips: read([]), listRenters: read([]), getFuelPrices: read({gasoline:1700,diesel:1600,lpg:1000}), listDocuments: read([]),
});
initTheme(); applyTheme(params.has('dark') ? 'dark' : 'light', {syncServer:false,persist:false});
function Preview() {
  const [kind,setKind] = useState(params.get('kind') || 'rental');
  const [action,setAction] = useState('');
  return <div style={{height:'100%',display:'flex',flexDirection:'column'}}>
    <div style={{padding:8,display:'flex',gap:12,flexWrap:'wrap',flexShrink:0,fontSize:12}}><button onClick={()=>setKind('rental')}>렌트카 미리보기</button><button onClick={()=>setKind('corporate')}>법인차 미리보기</button><a href="?error=1">오류 상태</a><a href="?empty=1">빈 상태</a><span>{action}</span></div>
    <div style={{flex:1,minHeight:0,width:params.has('mobile')?390:'100%',maxWidth:'100%',margin:'0 auto'}}>
      {kind==='rental'?<RentcarPanel devices={devices} onMap={id=>setAction(`지도 이동: ${id}`)}/>:<CorporatePanel devices={devices} onMap={id=>setAction(`지도 이동: ${id}`)} onDevice={id=>setAction(`차량 상세: ${id}`)}/>}
    </div>
  </div>;
}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Preview/></QueryClientProvider>);
