import { epoch, getRow, newId, record, stamp, moneyValue } from './freightWorkflow.js';

export const regions = '서울 경기 인천 강원 충북 충남 대전 세종 전북 전남 광주 경북 경남 대구 울산 부산 제주'.split(' ');
export const readinessLabels={ready:'배차 준비',maintenance:'정비 중',hold:'운영 제외'};
export const availabilityLabels={available:'배차 가능',off:'배차 제외'};
export const serviceStates={scheduled:'작업 예정',done:'작업 완료'};
export const catalogNames={vehicles:'화물차량',drivers:'기사',services:'정비·보험 일정',shippers:'화주',carriers:'협력 운송사',locations:'상·하차지',rates:'계약 요율'};
const activeShipment=s=>!['cancelled','delivered'].includes(s.status);
const normalizePlate=value=>value.replace(/\s/g,'').toUpperCase();
const openIncident=(data,id)=>data.incidents.some(i=>i.vehicleId===id&&i.status==='open'&&(i.type==='사고'||i.vehicleBlocked===true));
const activeService=(data,id)=>data.services.some(s=>s.vehicleId===id&&s.status!=='done'&&epoch(s.start)<=Date.now());
const validPhone=value=>/^[+\d()\s-]+$/.test(value)&&/^\d{7,15}$/.test(value.replace(/\D/g,''));
const assert=(pass,message)=>{if(!pass)throw Error(message);};
export function restoreVehicle(data,id) {
  const vehicle=getRow(data,'vehicles',id);
  if (vehicle) vehicle.readiness=openIncident(data,id)||vehicle.manualHold ? 'hold' : activeService(data,id) ? 'maintenance' : 'ready';
}
function validateVehicle(data,old,v) {
  assert(v.plate&&v.model,'차량번호와 차량명을 입력해 주세요.');
  assert(!data.vehicles.some(x=>x.id!==old?.id&&normalizePlate(x.plate)===normalizePlate(v.plate)),'이미 등록된 차량번호입니다.');
  assert(data.codes.vehicleTypes.includes(v.type)&&getRow(data,'branches',v.branchId)&&Object.hasOwn(readinessLabels,v.readiness),'차량 형태, 지점과 준비 상태를 확인해 주세요.');
  assert(Number.isInteger(v.capacityKg)&&v.capacityKg>=1&&v.capacityKg<=100000,'적재능력을 1~100,000kg로 입력해 주세요.');
  assert(Number.isInteger(v.odometer)&&v.odometer>=(old?.odometer||0)&&v.odometer<=10000000,'주행거리는 기존 값 이상, 1,000만 km 이하로 입력해 주세요.');
  assert(v.insuranceUntil&&v.inspectionAt,'보험 만료일과 검사 예정일을 입력해 주세요.');
  assert(!v.driverId||getRow(data,'drivers',v.driverId)?.carrierId===v.carrierId,'차량과 같은 소속의 기사를 선택해 주세요.');
  if (old && data.shipments.some(s=>s.vehicleId===old.id&&activeShipment(s))) {
    const operational=['type','capacityKg','branchId','carrierId','driverId','readiness'];
    assert(!operational.some(key=>v[key]!==old[key]),'배차된 운송이 있습니다. 해당 배차를 정리한 뒤 차량 조건을 변경해 주세요.');
  }
  assert(!old||v.readiness!=='ready'||(!activeService(data,old.id)&&!openIncident(data,old.id)),'진행 중인 사고 또는 정비를 먼저 완료해 주세요.');
}
function validateDriver(data,old,v) {
  assert(v.name&&validPhone(v.phone),'기사 이름과 연락처를 확인해 주세요.');
  assert(getRow(data,'branches',v.branchId)&&Object.hasOwn(availabilityLabels,v.availability),'지점과 배차 가능 여부를 확인해 주세요.');
  if (!old) return;
  if (data.shipments.some(s=>s.driverId===old.id&&activeShipment(s))) {
    assert(v.carrierId===old.carrierId&&v.branchId===old.branchId&&v.active&&v.availability==='available'&&(!data.policies.requireDriverCheck||v.licenseChecked),'배차된 운송이 있습니다. 담당 기사를 변경하거나 운송을 마친 뒤 수정해 주세요.');
  }
  assert(v.carrierId===old.carrierId||!data.vehicles.some(x=>x.driverId===old.id),'기본 연결 차량의 기사를 먼저 변경한 뒤 소속을 바꿔 주세요.');
}
function validateService(data,old,v) {
  assert(old?.status!=='done'&&getRow(data,'vehicles',v.vehicleId)&&['정비','검사','보험'].includes(v.type),'작업 예정 상태, 차량과 일정 구분을 확인해 주세요.');
  const start=epoch(v.start),end=epoch(v.end);
  assert(start<end,'종료 예정은 시작 일시보다 늦어야 합니다.');
  assert(moneyValue(v.cost)!=null,'비용을 입력해 주세요.');
  const buffer=(data.policies.bufferMinutes||0)*60000;
  const overlaps=(s,gap)=>start<epoch(s.end)+gap&&epoch(s.start)<end+gap;
  assert(!data.shipments.some(s=>s.vehicleId===v.vehicleId&&activeShipment(s)&&overlaps(s,buffer)),'배차된 운송 일정과 겹칩니다.');
  assert(!data.services.some(s=>s.id!==old?.id&&s.vehicleId===v.vehicleId&&s.status!=='done'&&overlaps(s,0)),'다른 정비·보험 일정과 겹칩니다.');
}
export function saveCatalog(data,key,id,values) {
  const old=id?getRow(data,key,id):null, v={...values};
  if(id&&!old)throw Error('대상 정보를 다시 조회해 주세요.');
  for (const key of Object.keys(v)) if (typeof v[key]==='string')v[key]=v[key].trim();
  if (['vehicles','drivers'].includes(key)) assert(!v.carrierId||getRow(data,'carriers',v.carrierId),'운송사를 다시 확인해 주세요.');
  if (key==='vehicles') {
    validateVehicle(data,old,v);
    v.manualHold=v.readiness==='hold' && (old?.readiness==='hold' ? (old.manualHold ?? !openIncident(data,old.id)) : true);
  }
  if (key==='drivers') validateDriver(data,old,v);
  if (key==='services') validateService(data,old,v);
  if (['shippers','carriers','locations'].includes(key)) assert(v.name&&v.contact&&validPhone(v.phone),'이름, 담당자와 연락처(숫자 7~15자리)를 확인해 주세요.');
  if (['shippers','carriers'].includes(key)) {
    assert(!v.businessNumber||/^(\d{10}|\d{3}-\d{2}-\d{5})$/.test(v.businessNumber),'사업자등록번호는 숫자 10자리로 입력해 주세요.');
    assert(!v.businessNumber||!data[key].some(x=>x.id!==id&&(x.businessNumber||'').replace(/\D/g,'')===v.businessNumber.replace(/\D/g,'')),'이미 등록된 사업자등록번호입니다.');
    assert(['건별','월합산'].includes(v.billing||v.settlement),'정산 방식을 선택해 주세요.');
  }
  if (key==='locations')assert(v.address&&regions.includes(v.region)&&v.openTime&&v.closeTime,'주소, 지역과 작업 가능 시간을 확인해 주세요.');
  if (key==='rates') {
    assert(v.name&&regions.includes(v.pickupRegion)&&regions.includes(v.dropoffRegion)&&data.codes.vehicleTypes.includes(v.vehicleType),'요율 이름, 지역과 차량 형태를 확인해 주세요.');
    assert(Number.isInteger(v.capacityKg)&&v.capacityKg>0&&v.capacityKg<=100000,'기준 적재능력을 1~100,000kg로 입력해 주세요.');
    v.sellAmount=moneyValue(v.sellAmount);v.buyAmount=moneyValue(v.buyAmount);
  }
  const previousVehicle=old?.vehicleId;
  const target=old || {id:newId()};
  if (!old && key==='services') target.status='scheduled';
  if (!old && key==='vehicles') target.deviceId='';
  Object.assign(target,v);
  if (!old) data[key].unshift(target);
  if (key==='services') {
    if(previousVehicle) restoreVehicle(data,previousVehicle);
    if(epoch(target.start)<=Date.now()) restoreVehicle(data,target.vehicleId);
  }
  record(data,null,catalogNames[key]+' '+(old?'수정':'등록')+' · '+(target.plate||target.name||target.type));
  return target.id;
}
export function finishService(data,id) {
  const service=getRow(data,'services',id);
  assert(service&&service.status!=='done','이미 완료된 작업입니다.');
  service.status='done';service.completedAt=stamp();
  restoreVehicle(data,service.vehicleId);
  record(data,null,'차량 '+service.type+' 완료 · '+(getRow(data,'vehicles',service.vehicleId)?.plate||''));
}
export function catalogInUse(data,key,id) {
  switch(key) {
    case 'vehicles': return [...data.shipments,...data.incidents,...data.services].some(x=>x.vehicleId===id);
    case 'drivers': return [...data.shipments,...data.vehicles].some(x=>x.driverId===id);
    case 'shippers': return [...data.orders,...data.recurring].some(x=>x.shipperId===id);
    case 'carriers': return [...data.shipments,...data.vehicles,...data.drivers].some(x=>x.carrierId===id);
    case 'locations': return [...data.orders,...data.recurring].some(x=>x.pickupLocationId===id||x.dropoffLocationId===id);
    case 'rates': return [...data.orders,...data.recurring,...data.shipments].some(x=>x.rateId===id);
    default: return true;
  }
}
export function removeCatalog(data,key,id) {
  assert(!catalogInUse(data,key,id),'연결된 기록이 있어 삭제할 수 없습니다.');
  const row=getRow(data,key,id);
  assert(row,'대상을 다시 조회해 주세요.');
  data[key]=data[key].filter(r=>r.id!==id);
  record(data,null,catalogNames[key]+' 삭제 · '+(row.plate||row.name));
}
export function linkTerminal(data,devices,id,vehicleId) {
  assert(devices.some(d=>String(d.id)===String(id)),'등록된 단말기를 확인해 주세요.');
  const vehicle=vehicleId&&getRow(data,'vehicles',vehicleId);
  assert(!vehicleId||vehicle,'차량을 확인해 주세요.');
  assert(!vehicle?.deviceId||String(vehicle.deviceId)===String(id),'차량에 연결된 단말기를 먼저 해제해 주세요.');
  for (const v of data.vehicles) if(String(v.deviceId)===String(id))v.deviceId='';
  if(vehicle)vehicle.deviceId=String(id);
  record(data,null,vehicle?'화물차량 단말기 연결 · '+vehicle.plate:'화물차량 단말기 연결 해제');
}
