import React, { useState } from 'react';
import { installCorporateMapFixture } from './corporate-map-fixture';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/index.css';
import { initTheme, applyTheme } from '../src/theme';
import { api } from '../src/api';
import CorporatePanel from '../src/components/CorporatePanel';
import RentcarPanel from '../src/components/RentcarPanel';
import { businessDate } from '../src/lib/business';

// Isolated visual fixture: all network methods are stubbed; return tests never write to a server.
const params = new URLSearchParams(location.search);
const failed = params.has('error'), empty = params.has('empty');
if(params.has('mock-map')) installCorporateMapFixture();
const now = Date.now(), day = businessDate(now), at = h => `${day}T${h}:00:00+09:00`;
let devices = empty ? [] : [
  { id: 1, display_name: '서울 영업 1호', car_plate: '123가 4567', car_model: '쏘나타', department: '영업팀', enabled: true, last_seen_at: new Date(now).toISOString(), last_fix_at: new Date(now).toISOString(), next_service_date: day },
  { id: 2, display_name: '업무용 차량 2호', license_plate: '234나 8901', car_model: '아반떼', department: '관리팀', enabled: true, last_seen_at: new Date(now - 700_000).toISOString(), insurance_expiry: day },
  { id: 3, display_name: '장기렌트 고객 차량', license_plate: '345다 6789', car_model: '카니발', enabled: true, last_seen_at: new Date(now).toISOString(), last_fix_at: new Date(now).toISOString() },
  { id: 4, display_name: '정비 대기', license_plate: '456라 0123', car_model: '그랜저', enabled: false },
];
const rental = (id, device, status, start, end) => ({ id, device_id: device.id, device_name: device.display_name, license_plate: device.car_plate || device.license_plate, renter_name: `미리보기 고객 ${id}`, starts_at: start, ends_at: end, status, rate_type: 'daily', rate_amount_krw: 70000, deposit_krw: 100000 });
const rentals = empty ? [] : [rental(1, devices[0], 'active', at('08'), at('23')), rental(2, devices[1], 'overdue', new Date(now-200*86400000).toISOString(), new Date(now-190*86400000).toISOString()), rental(3, devices[2], 'draft', at('22'), at('23')),
  {...rental(4, devices[0], 'returned', at('00'), at('01')), settled_at: at('02'), settled_amount_krw: 140000 }];
const reservations = empty ? [] : [{ id: 1, device_id: 1, driver_name: '미리보기 운전자', driver_staff_id: 1, device_name: '서울 영업 1호', license_plate: '123가 4567', status: 'planned', starts_at: at('09'), ends_at: at('18'), purpose: '고객사 방문' }];
if (params.has('attention')) devices[1].last_seen_at = new Date(now - 8 * 3600000).toISOString();
if (params.has('next-reservation')) reservations[0] = { ...reservations[0], starts_at: new Date(now + 2 * 86400000).toISOString(), ends_at: new Date(now + 2 * 86400000 + 3600000).toISOString() };
window.__returnCalls = [];
window.__photoCalls = []; window.__photoFailure = params.has('upload-error'); window.__photoReadError = params.has('photo-error'); window.__photoListError = params.has('photo-list-error');
const photos = new Map(rentals.map(c => [c.id, [{ id:c.id*10+1,contract_id:c.id,kind:'pickup_damage',uploaded_at:new Date(now-7200000).toISOString() },{ id:c.id*10+2,contract_id:c.id,kind:'return_damage',uploaded_at:new Date(now-3600000).toISOString() }]]));
const photoBytes = new Map();
let nextPhotoId = 1000;
for (const key of Object.keys(api)) api[key] = async () => { throw Error('미리보기에서는 서버 작업을 수행하지 않습니다.'); };
const read = value => async () => { if (failed) throw Error('의도한 조회 오류'); return value; };
Object.assign(api, {
  listRentals: read(rentals), listReservations: async (p = {}) => { if (failed) throw Error('의도한 조회 오류'); return reservations.filter(r => (!p.from || new Date(r.ends_at) >= new Date(p.from)) && (!p.to || new Date(r.starts_at) < new Date(p.to))); }, listStaff: read(empty ? [] : [{id:1,name:'미리보기 운전자',role:'영업',active:true}]),
  returnRental: async (id, body) => { window.__returnCalls.push({ id, body }); if (!params.has('return-success')) throw Error('미리보기 반납 저장 실패'); const c = rentals.find(r => r.id === id); c.status = 'returned'; return c; },
  getCorporateInfo: read({company_name:'미리보기 회사',business_number:'000-00-00000',representative:'미리보기'}),
  getCorporateSubscription: read({active:true,price_krw:30000,expires_at:new Date(now+86400000*20).toISOString()}),
  getRentcarSubscription: read({active:true,price_krw:30000,expires_at:new Date(now+86400000*20).toISOString()}),
  fleetTripStats: read({per_device: devices.map(d => ({device_id:d.id,total_distance_m:123000,today_distance_m:32000,today_fix_count:30,today_last_fix_at:new Date(now).toISOString()}))}),
  listTrips: read(empty ? [] : [{ started_at: at('09'), ended_at: at('10'), duration_min:60, distance_m:12000, annotation:{purpose:'business',driver_staff_id:1,driver_name:'미리보기 운전자',fuel_cost:50000} }, {started_at:at('11'),ended_at:at('12'),duration_min:60,distance_m:6000,annotation:null}]),
  listRentalPhotos: async id => { if (window.__photoListError) throw Error('사진 목록 조회 오류'); return [...(photos.get(Number(id)) || [])]; },
  uploadRentalPhoto: async (id, body) => { window.__photoCalls.push({ action:'upload', id, body }); if (!params.has('photo-write') || window.__photoFailure) throw Error('미리보기 사진 저장 실패'); await new Promise(resolve=>setTimeout(resolve,100)); const photo={id:nextPhotoId++,contract_id:id,kind:body.kind,uploaded_at:new Date().toISOString()}; photos.set(Number(id),[...(photos.get(Number(id))||[]),photo]); photoBytes.set(photo.id,body.data_url); return photo; },
  deleteRentalPhoto: async id => { window.__photoCalls.push({ action:'delete', id }); if (!params.has('photo-write') || window.__photoFailure) throw Error('미리보기 사진 삭제 실패'); for(const [key,list] of photos)photos.set(key,list.filter(p=>p.id!==id)); photoBytes.delete(id); },
  fetchRentalPhoto: async id => { if (window.__photoReadError) throw Error('의도한 사진 오류'); if (photoBytes.has(id)) return URL.createObjectURL(new Blob([Uint8Array.from(atob(photoBytes.get(id).split(',')[1]),c=>c.charCodeAt(0))],{type:'image/jpeg'})); return URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#dae6f7"/><text x="35" y="100" fill="#2157a6">Test photo (fixture)</text></svg>'],{type:'image/svg+xml'})); },
  listRenters: read([]), getFuelPrices: read({gasoline:1700,diesel:1600,lpg:1000}), listDocuments: read([]),
});
// Optional, ignored local API snapshot. Never bundled into the production app.
if (params.has('people')) {
  const staff = empty ? [] : [{id:1,name:'미리보기 운전자',role:'영업',phone:'010-0000-0001',active:true},{id:2,name:'긴 이름 운전자·광역권 차량 운행 지원 담당',role:'장거리 운행 지원 및 배차 관리',phone:'010-0000-0002',active:true},{id:3,name:'비활성 운전자',role:null,phone:null,active:false}];
  const renters = empty ? [] : [
    {renter_phone:'010-1111-0001',renter_name:'미리보기 고객',contracts_count:3,returned_count:2,overdue_count:1,late_count:1,total_revenue:140000,last_at:at('09'),first_at:at('01'),blacklisted:false},
    {renter_phone:'010-1111-0002',renter_name:'장기 임대 이용 고객·이름이 긴 경우',contracts_count:2,returned_count:1,overdue_count:0,late_count:1,total_revenue:70000,last_at:at('09'),first_at:at('01'),blacklisted:true,blacklist_reason:'이전 계약 정산 확인',blacklist_severity:'warn'},
    {renter_phone:'010-1111-0003',renter_name:'차단된 고객',contracts_count:1,returned_count:1,overdue_count:0,late_count:0,total_revenue:70000,last_at:at('09'),first_at:at('01'),blacklisted:true,blacklist_reason:'기존 계약 확인 필요',blacklist_severity:'block'},
  ];
  let company={company_name:'미리보기 회사',business_number:'000-00-00000',representative:'대표자',address:'서울특별시 테스트 주소'};
  window.__supportCalls=[]; window.__supportFailure=params.has('support-write-error'); window.__supportReadError=params.has('support-error');
  const supportRead = value => { if (window.__supportReadError) throw Error('미리보기 조회 실패'); return typeof value==='function'?value():value; };
  const supportWrite = async (action, body) => { window.__supportCalls.push({action,body}); await new Promise(resolve=>setTimeout(resolve,100)); if (!params.has('support-write') || window.__supportFailure) throw Error('미리보기 저장 실패'); };
  Object.assign(api, {
    listStaff:async()=>supportRead(()=>staff.map(s=>({...s}))), listRenters:async()=>supportRead(()=>renters.map(r=>({...r}))),
    createStaff:async body=>{await supportWrite('staff-create',body);const next={...body,id:staff.length+1,active:true};staff.push(next);return next;},
    updateStaff:async(id,body)=>{await supportWrite('staff-update',{id,...body});Object.assign(staff.find(s=>s.id===id),body);return {...staff.find(s=>s.id===id)};},
    removeStaff:async id=>{await supportWrite('staff-disable',{id});staff.find(s=>s.id===id).active=false;return {ok:true};},
    renterDetail:async phone=>supportRead(()=>({summary:{...renters.find(r=>r.renter_phone===phone)},contracts:rentals.map(c=>({...c}))})),
    listBlacklist:async()=>supportRead(()=>renters.filter(r=>r.blacklisted).map(r=>({id:renters.indexOf(r)+1,renter_phone:r.renter_phone}))),
    addBlacklist:async body=>{await supportWrite('notice-save',body);Object.assign(renters.find(r=>r.renter_phone===body.renter_phone),{blacklisted:true,blacklist_reason:body.reason,blacklist_severity:body.severity});return {ok:true};},
    removeBlacklist:async id=>{await supportWrite('notice-remove',{id});renters[id-1].blacklisted=false;return {ok:true};},
    getCorporateInfo:async()=>supportRead(()=>({...company})),putCorporateInfo:async body=>{await supportWrite('company-save',body);company={...body};return company;},
    getCorporateSubscription:async()=>supportRead({active:true,price_krw:30000,expires_at:new Date(now+20*86400000).toISOString()}),
    getRentcarSubscription:async()=>supportRead({active:false,price_krw:30000,expires_at:null}),
    buyCorporateSubscription:async()=>{await supportWrite('corporate-buy',{});return {active:true,price_krw:30000,expires_at:new Date(now+50*86400000).toISOString()};},
    buyRentcarSubscription:async()=>{await supportWrite('rentcar-buy',{});return {active:true,price_krw:30000,expires_at:new Date(now+30*86400000).toISOString()};},
  });
}
if (params.has('account')) {
  const response = await fetch('/tests/.local-business-data.json');
  if (!response.ok) throw Error('로컬 계정 검증 자료가 없습니다.');
  const snapshot = await response.json();
  devices = snapshot.devices;
  Object.assign(api, {
    listRentals:read(snapshot.rentals),listReservations:async (p={})=>snapshot.reservations.filter(r=>(!p.from || new Date(r.ends_at)>=new Date(p.from)) && (!p.to || new Date(r.starts_at)<=new Date(p.to))),listStaff:read(snapshot.staff),
    getCorporateInfo:read(snapshot.info),getCorporateSubscription:read(snapshot.corporateSubscription),getRentcarSubscription:read(snapshot.rentalSubscription),
    listTrips:async id=>snapshot.tripsByDevice[String(id)] || [],
    fleetTripStats:read(snapshot.fleetStats),
  });
}
if (params.has('subscription')) {
  const mode = params.get('subscription');
  api.getCorporateSubscription = async () => {
    if (mode === 'error') throw Error('미리보기 이용권 조회 실패');
    if (mode === 'loading') return new Promise(() => {});
    return {active:mode === 'active',price_krw:mode === 'invalid' ? null : 30000,expires_at:null};
  };
  api.buyCorporateSubscription = async () => {
    if (!params.has('subscription-success')) throw Error('미리보기 결제 실패: 포인트를 확인해 주세요.');
    return {active:true,price_krw:30000,expires_at:new Date(now + 30 * 86400000).toISOString()};
  };
}
if(params.has('feedback')) {
  devices.forEach((d,i)=>Object.assign(d,{last_lat:37.5665+i*0.00001,last_lng:126.978,last_fix_at:new Date(now-7*86400000).toISOString(),last_seen_at:new Date(now-7*86400000).toISOString(),last_vbat_mv:2400}));
  api.fleetTripStats=read({per_device:devices.map(d=>({device_id:d.id,total_distance_m:32000,today_distance_m:0,today_fix_count:params.get('feedback')==='zero'?2:0,today_last_fix_at:params.get('feedback')==='zero'?new Date(now).toISOString():null}))});
  api.updateDevice=async(id,body)=>{const d=devices.find(d=>d.id===id);Object.assign(d,body);return {...d};};
}
initTheme(); applyTheme(params.has('dark') ? 'dark' : 'light', {syncServer:false,persist:false});
function Preview() {
  const [kind,setKind] = useState(params.get('kind') || 'rental');
  const [action,setAction] = useState('');
  return <div style={{height:'100%',display:'flex',flexDirection:'column'}}>
    <div style={{padding:8,display:'flex',gap:12,flexWrap:'wrap',flexShrink:0,fontSize:12}}><button onClick={()=>setKind('rental')}>렌트카 미리보기</button><button onClick={()=>setKind('corporate')}>법인차 미리보기</button><a href="?error=1">오류 상태</a><a href="?empty=1">빈 상태</a><span>{action}</span></div>
    <div style={{flex:1,minHeight:0,width:params.has('mobile')?390:'100%',maxWidth:'100%',margin:'0 auto'}}>
      {kind==='rental'?<RentcarPanel devices={devices} onNavigate={view=>setAction(`메뉴 이동: ${view}`)} onMap={id=>setAction(`지도 이동: ${id}`)}/>:<CorporatePanel devices={devices} onNavigate={view=>setAction(`메뉴 이동: ${view}`)} onMap={id=>setAction(`지도 이동: ${id}`)} onDevice={id=>setAction(`차량 상세: ${id}`)}/>}
    </div>
  </div>;
}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Preview/></QueryClientProvider>);
