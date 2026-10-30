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
// Independent vehicle IDs deliberately differ from SIM IDs in this fixture.
let assets=devices.map((d,i)=>({id:100+i,owner_id:1,name:`업무 차량 ${i+1}`,license_plate:d.license_plate||d.car_plate,car_model:d.car_model,department:d.department,enabled:d.enabled,profile:{next_service_date:d.next_service_date,insurance_expiry:d.insurance_expiry},created_at:new Date(now-86400000).toISOString(),updated_at:new Date(now).toISOString(),bindings:[{id:i+1,device_id:d.id,terminal_name:d.display_name,is_primary:true,started_at:'2020-01-01T00:00:00Z'}]}));
let fleetBookings=reservations.map(r=>({...r,vehicle_id:99+r.device_id,vehicle_name:`업무 차량 ${r.device_id}`}));
Object.assign(api,{
 listFleetVehicles:()=>read(assets.map(v=>({...v})))(),
 createFleetVehicle:async body=>{const v={...body,id:200+assets.length,owner_id:1,bindings:[],created_at:new Date().toISOString(),updated_at:new Date().toISOString()};assets=[...assets,v];return v;},
 updateFleetVehicle:async(id,body)=>{assets=assets.map(v=>v.id===id?{...v,...body,updated_at:new Date().toISOString()}:v);return assets.find(v=>v.id===id);},
 fleetVehicleBindings:async id=>assets.find(v=>v.id===id).bindings,
 connectFleetVehicle:async(id,body)=>{const v=assets.find(v=>v.id===id);v.bindings=body.device_ids.map((d,i)=>({id:i+10,device_id:d,terminal_name:devices.find(x=>x.id===d).display_name,is_primary:d===body.primary_device_id,started_at:new Date().toISOString()}));return {...v};},
 listFleetVehicleTrips:async(id,p)=>(await api.listTrips(devices[id-100]?.id,p)).map(t=>({...t,source_device_id:devices[id-100]?.id,binding_id:id,vehicle_id:id,source_started_at:t.started_at,allocation_status:'assigned',annotation:assignmentAnnotations.get(`${id}:${t.started_at}`)||t.annotation})),
 fleetVehicleStats:async()=>{const rows=await api.fleetTripStats();return {per_device:rows.per_device.map(r=>({...r,device_id:99+r.device_id,vehicle_id:99+r.device_id}))};},
 listFleetDocuments:read([]),
 listFleetReservations:async p=>fleetBookings.filter(r=>(!p.from||new Date(r.ends_at)>=new Date(p.from))&&(!p.to||new Date(r.starts_at)<new Date(p.to))),
 createFleetReservation:async body=>{const v=assets.find(v=>v.id===body.vehicle_id);const r={...body,id:100+fleetBookings.length,vehicle_name:v.name,license_plate:v.license_plate};fleetBookings.push(r);return r;},
 updateFleetReservation:async(id,body)=>{fleetBookings=fleetBookings.map(r=>r.id===id?{...r,...body}:r);return fleetBookings.find(r=>r.id===id);},cancelFleetReservation:async id=>{fleetBookings=fleetBookings.map(r=>r.id===id?{...r,status:'cancelled'}:r);return {ok:true};},
});
const assignmentAnnotations=new Map(),tripRules=[],tripAudit=[];
const teamOrg=[{id:1,kind:'department',name:'영업팀',active:true,updated_at:new Date().toISOString()},{id:2,kind:'position',name:'팀장',active:true,updated_at:new Date().toISOString()}];
const teamStaff=[{id:1,name:'김영업',role:'영업',department_id:1,department:'영업팀',position_id:2,position:'팀장',phone:'010-0000-0000',active:true,access_role:'member',all_vehicles:false,vehicle_ids:[100],created_at:new Date().toISOString(),updated_at:new Date().toISOString()}];
const teamRole=params.get('role')||'owner';let teamInvites=[];
Object.assign(api,{
 fleetWorkspaces:read({own_id:1,memberships:[{owner_id:2,company_name:'검증용 회사',role:'member'}]}),
 fleetAccess:read({role:teamRole,owner_id:1,actor_id:1,staff_id:1,manage_team:['owner','admin'].includes(teamRole),manage_vehicles:['owner','admin'].includes(teamRole),manage_reports:teamRole!=='member',billing:teamRole==='owner'}),
 fleetOrganization:async()=>teamOrg.map(i=>({...i})),fleetTerminals:async()=>devices,
 createFleetOrgItem:async body=>{const i={...body,id:teamOrg.length+1,updated_at:new Date().toISOString()};teamOrg.push(i);return i;},updateFleetOrgItem:async(id,body)=>{Object.assign(teamOrg.find(i=>i.id===id),body);return body;},
 fleetInvites:async()=>teamInvites.map(i=>({...i})),fleetTeamAudit:read([]),
 inviteFleetStaff:async staff_id=>{const i={id:teamInvites.length+1,staff_id,name:teamStaff.find(s=>s.id===staff_id).name,expires_at:new Date(Date.now()+7*86400000).toISOString()};teamInvites.push(i);return {...i,code:'A'.repeat(43)};},
 revokeFleetInvite:async id=>{teamInvites=teamInvites.filter(i=>i.id!==id);},
 joinFleet:async()=>({owner_id:2,company_name:'검증용 회사',staff_name:'검증 직원',role:'member'}),
});
if(params.has('team'))Object.assign(api,{
 listStaff:async()=>teamStaff.map(s=>({...s})),
 createStaff:async body=>{const s={...body,id:teamStaff.length+1,department:teamOrg.find(i=>i.id===body.department_id)?.name,position:teamOrg.find(i=>i.id===body.position_id)?.name,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};teamStaff.push(s);return s;},
 updateStaff:async(id,body)=>{Object.assign(teamStaff.find(s=>s.id===id),body);return {...teamStaff.find(s=>s.id===id)};},
});
Object.assign(api,{
 listTripRules:async id=>tripRules.filter(r=>r.vehicle_id===id).map(r=>({...r})),
 createTripRule:async(id,p)=>{const r={...p,id:tripRules.length+1,vehicle_id:id,driver_name:teamStaff.find(s=>s.id===p.driver_staff_id)?.name,updated_at:new Date().toISOString()};tripRules.push(r);return r;},
 updateTripRule:async(id,rid,p)=>{const r=tripRules.find(r=>r.id===rid);Object.assign(r,p,{updated_at:new Date().toISOString()});return {...r};},
 tripAssignmentHistory:async()=>tripAudit,
 assignFleetTrips:async(id,p)=>{
  const trips=await api.listFleetVehicleTrips(id,{});
  const rows=p.trips.map(k=>{const t=trips.find(t=>t.started_at===k.trip_started_at),before=t?.annotation;
   const source=p.mode==='suggest'?{kind:'reservation',id:1}:{kind:'manual'};
   const driver=(p.mode==='suggest'||p.change_driver)&&(!before?.driver_staff_id||p.overwrite)?p.mode==='suggest'?1:p.driver_staff_id:before?.driver_staff_id;
   const purpose=(p.mode==='suggest'||p.change_purpose)&&(!before?.purpose||before.purpose==='unspecified'||p.overwrite)?p.mode==='suggest'?'business':p.purpose:before?.purpose||'unspecified';
   const after={driver_staff_id:driver,driver_name:teamStaff.find(s=>s.id===driver)?.name,purpose};
   return {key:k,started_at:t.started_at,before,after,source,status:driver!==before?.driver_staff_id||purpose!==(before?.purpose||'unspecified')?'ready':'skipped',reason:'이미 입력됨 · 변경 없음'};
  });
  if(p.preview_token){for(const r of rows.filter(r=>r.status==='ready')){const a={...r.before,...r.after,updated_at:new Date().toISOString()};assignmentAnnotations.set(`${id}:${r.started_at}`,a);tripAudit.unshift({id:tripAudit.length+1,action:'annotation',actor_name:'검증 관리자',created_at:a.updated_at,before_value:r.before,after_value:{...a,trip_started_at:r.started_at}});}return {applied:rows.filter(r=>r.status==='ready').length,skipped:rows.filter(r=>r.status!=='ready').length};}
  return {rows,preview_token:'fixture-only',ready:rows.filter(r=>r.status==='ready').length,skipped:rows.filter(r=>r.status!=='ready').length};
 },
});
const siteGroups=[{id:1,name:'본사',active:true,updated_at:new Date().toISOString()}];
const siteRows=params.has('empty')?[]:[{id:1,name:'서울 본사',address:'서울특별시 중구 세종대로 110',group_id:1,group_name:'본사',active:true,geometry:{type:'circle',lat:37.5665,lng:126.978,radius_m:200},created_at:new Date().toISOString(),updated_at:new Date().toISOString()}];
const siteVisits=[{id:1,site_id:1,site_name:'서울 본사',group_name:'본사',vehicle_id:100,vehicle_name:'서울 영업 1호',first_inside_at:at('09'),last_inside_at:at('10'),previous_outside_at:at('08'),outside_at:at('11'),start_kind:'transition',status:'exit',observed_seconds:3600},{id:2,site_id:1,site_name:'서울 본사',vehicle_id:101,vehicle_name:'업무용 차량 2호',first_inside_at:at('12'),last_inside_at:at('12'),start_kind:'observed',status:'stale',observed_seconds:0}];
Object.assign(api,{
 listFleetSites:async()=>{if(failed)throw Error('지점 조회 실패');return siteRows.map(s=>({...s}));},listFleetSiteGroups:async()=>siteGroups.map(g=>({...g})),
 createFleetSite:async body=>{const s={...body,id:siteRows.length+1,group_name:siteGroups.find(g=>g.id===body.group_id)?.name,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};siteRows.push(s);return s;},
 updateFleetSite:async(id,body)=>{Object.assign(siteRows.find(s=>s.id===id),body,{updated_at:new Date().toISOString()});return {...siteRows.find(s=>s.id===id)};},
 createFleetSiteGroup:async body=>{const g={...body,id:siteGroups.length+1,updated_at:new Date().toISOString()};siteGroups.push(g);return g;},
 updateFleetSiteGroup:async(id,body)=>{Object.assign(siteGroups.find(g=>g.id===id),body);return body;},
 listFleetSiteVisits:async p=>({items:siteVisits.filter(v=>(!p.vehicle_id||String(v.vehicle_id)===p.vehicle_id)&&(!p.site_id||String(v.site_id)===p.site_id)),next_before:null}),
});

// Expense writes below stay in memory and never reach the server.
const expenseCats=[{id:1,name:'차량유지비',kind:'group',parent_id:null,active:true},{id:2,name:'유류비',kind:'fuel',parent_id:1,active:true},{id:3,name:'정비비',kind:'expense',parent_id:1,active:true},{id:4,name:'여비교통비',kind:'group',parent_id:null,active:true},{id:5,name:'숙박비',kind:'expense',parent_id:4,active:true}].map(c=>({...c,updated_at:new Date().toISOString()}));
let expenseRows=params.has('empty')?[]:[{id:1,spent_on:at('12').slice(0,10),status:'approved',staff_id:1,staff_name:'김영업',department_id:1,department_name:'영업팀',vehicle_id:100,vehicle_name:'업무 차량 1 · 123가 4567',category_id:2,category_name:'유류비',group_name:'차량유지비',category_kind:'fuel',amount_krw:50000,payment_method:'company_card',note:'모의 데이터 · 고객사 방문',created_at:at('10'),updated_at:at('10')},{id:2,spent_on:at('12').slice(0,10),status:'pending',staff_id:1,staff_name:'김영업',department_id:1,department_name:'영업팀',vehicle_id:null,vehicle_name:'일반 지출',category_id:5,category_name:'숙박비',group_name:'여비교통비',category_kind:'expense',amount_krw:80000,payment_method:'personal_card',note:'모의 데이터 · 출장',created_at:at('11'),updated_at:at('11')}];
const expenseReceipts=new Map(),expenseHistory=new Map();
const expenseView=r=>({...r,can_edit:['pending','rejected'].includes(r.status),can_review:teamRole!=='member',can_cancel:r.status!=='cancelled',receipt_count:(expenseReceipts.get(r.id)||[]).length});
function mockExpense(p,id){const c=expenseCats.find(c=>c.id===p.category_id),v=assets.find(v=>v.id===p.vehicle_id),s=teamStaff.find(s=>s.id===p.staff_id);return {...p,id,status:'pending',staff_name:s?.name||'미지정',department_id:s?.department_id,department_name:s?.department||'',vehicle_name:v?.name||'일반 지출',category_name:c.name,category_kind:c.kind,group_name:expenseCats.find(g=>g.id===c.parent_id).name,updated_at:new Date().toISOString()};}
Object.assign(api,{
 expenseCategories:async()=>expenseCats.map(c=>({...c})),
 createExpenseCategory:async p=>{const c={...p,id:expenseCats.length+1,updated_at:new Date().toISOString()};expenseCats.push(c);return c;},
 updateExpenseCategory:async(id,p)=>{Object.assign(expenseCats.find(c=>c.id===id),p,{updated_at:new Date().toISOString()});return {...expenseCats.find(c=>c.id===id)};},
 listExpenses:async p=>{if(failed)throw Error('지출 조회 실패');return {items:expenseRows.filter(r=>(!p.status||r.status===p.status)&&(!p.category_id||r.category_id===Number(p.category_id))&&(!p.vehicle_id||r.vehicle_id===Number(p.vehicle_id))&&(!p.staff_id||r.staff_id===Number(p.staff_id))&&r.spent_on>=p.from&&r.spent_on<=p.to).map(expenseView)};},
 createExpense:async p=>{const r=mockExpense(p,Math.max(0,...expenseRows.map(r=>r.id))+1);expenseRows.unshift(r);return expenseView(r);},
 updateExpense:async(id,p)=>{const r=mockExpense(p,id);expenseRows=expenseRows.map(x=>x.id===id?r:x);return expenseView(r);},
 expenseDetail:async id=>({expense:expenseView(expenseRows.find(r=>r.id===id)),receipts:(expenseReceipts.get(id)||[]).map(({file,...r})=>r),history:expenseHistory.get(id)||[]}),
 reviewExpense:async(id,p)=>{const r=expenseRows.find(r=>r.id===id);Object.assign(r,{status:p.status,review_note:p.note,updated_at:new Date().toISOString()});expenseHistory.set(id,[{id:Date.now(),actor_id:1,action:p.status,after_value:{...r},created_at:new Date().toISOString()},...(expenseHistory.get(id)||[])]);return expenseView(r);},
 uploadExpenseReceipt:async(id,file)=>{const r={id:Date.now(),filename:file.name,mime:file.type,size_bytes:file.size,file};expenseReceipts.set(id,[...(expenseReceipts.get(id)||[]),r]);return r;},
 downloadExpenseReceipt:async(id,fid)=>expenseReceipts.get(id).find(f=>f.id===fid).file,
 removeExpenseReceipt:async(id,fid)=>expenseReceipts.set(id,expenseReceipts.get(id).filter(f=>f.id!==fid)),
});

// Round 7: isolated mutable report projection; no requests leave this fixture.
if(params.has('quality')){
 let rows=[{started_at:at('09'),ended_at:at('10'),distance_m:12000,duration_min:60,annotation:{purpose:'business',driver_staff_id:1,driver_name:'김영업',fuel_cost:50000},quality:{status:'confirmed',report_included:true,end_basis:'sleep_signal',fix_count:30,gap_count:0}},
 {started_at:at('11'),ended_at:at('12'),distance_m:0,duration_min:60,annotation:null,quality:{status:'review',report_included:false,end_basis:'sleep_signal',zero_reason:'excluded_segments',fix_count:2,gap_count:1}},
 {started_at:at('13'),ended_at:null,distance_m:14000,annotation:null,quality:{status:'end_missing',report_included:false,end_basis:'missing',last_fix_at:at('14'),fix_count:10,gap_count:0}}].map(t=>({...t,source_device_id:1,binding_id:100,vehicle_id:100,source_started_at:t.started_at,allocation_status:'assigned'}));
 let changes=[];
 api.listFleetVehicleTrips=async()=>rows.map(r=>({...r}));
 api.tripEvidence=async(id,p)=>{const t=rows.find(t=>t.source_started_at===p.key.trip_started_at);return {trip:t,points:[[t.started_at,37,127],[t.ended_at||at('14'),37.01,127.01]],point_count:2,sampled:false,events:[['wake',t.started_at,null]],gaps:t.quality.gap_count?[{from:t.started_at,to:t.ended_at,seconds:3600}]:[],calculated_distance_m:t.distance_m,method:'GPS 유효 좌표 간 거리. 10분 초과 수신 공백·비정상 이동은 제외합니다.'};};
 api.correctTrips=async(id,p)=>{const before=rows.filter(t=>p.trips.some(k=>k.trip_started_at===t.source_started_at));let after=before.map(t=>({...t,ended_at:p.ended_at||t.ended_at,distance_m:p.distance_m??t.distance_m,quality:{status:'confirmed',report_included:true,reviewed:true,end_basis:'reviewed'}}));if(p.action==='split')after=[{...after[0],ended_at:p.split_at,distance_m:4000},{...after[0],started_at:p.split_at,source_started_at:p.split_at,distance_m:8000,annotation:null}];if(!p.preview_token)return {before,after,preview_token:'fixture-only',note:'원본 보존 · 변경 이력에서 복원 가능'};const c={id:changes.length+1,action:p.action,reason:p.reason,sources:before,outputs:after,created_at:new Date().toISOString(),actor_name:'검증 관리자'};changes.unshift(c);rows=[...rows.filter(t=>!before.includes(t)),...after.map(t=>({...t,correction_id:c.id}))].sort((a,b)=>a.started_at.localeCompare(b.started_at));return {id:c.id,applied:true};};
 api.tripCorrectionHistory=async()=>({rows:changes});
 api.restoreTripCorrection=async(id,cid,p)=>{const c=changes.find(c=>c.id===cid);rows=[...rows.filter(t=>t.correction_id!==cid),...c.sources].sort((a,b)=>a.started_at.localeCompare(b.started_at));Object.assign(c,{reverted_at:new Date().toISOString(),reverted_by_name:'검증 관리자',revert_reason:p.reason});return {restored:true};};
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
