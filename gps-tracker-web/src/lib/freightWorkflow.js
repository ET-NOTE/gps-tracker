export const orderStates={open:'미배차',assigned:'배차 완료',completed:'운송 완료',cancelled:'주문 취소'};
export const shipStates={requested:'수락 대기',confirmed:'배차 확정',loading:'상차 대기',in_transit:'운송 중',delivered:'하차 완료',cancelled:'배차 취소'};
export const proofStates={missing:'미제출',submitted:'확인 대기',approved:'확인 완료',rework:'보완 요청'};
export const invoiceLabel=s=>s.invoiceStatus==='issued'?'청구 기록 완료':'청구 전';
export const weekdays=['일','월','화','수','목','금','토'];
export const stepMap={
  confirmed:{type:'arrived',to:'loading',label:'상차지 도착'},
  loading:{type:'loaded',to:'in_transit',label:'상차 완료'},
  in_transit:{type:'delivered',to:'delivered',label:'하차 완료'},
};
export const getRow=(data,kind,id)=>data[kind]?.find(r=>r.id===id);
export const nameOf=(data,kind,id)=>getRow(data,kind,id)?.name||'—';
export const routeName=(data,o)=>[o?.pickupLocationId,o?.dropoffLocationId].map(id=>nameOf(data,'locations',id)).join(' → ');
export const firstOrder=(data,s)=>getRow(data,'orders',s?.orderIds?.[0]);
export const vehicleName=(data,id)=>getRow(data,'vehicles',id)?.plate||'—';
export const costLabel=n=>n==null?'미정':Number(n).toLocaleString('ko-KR')+'원';
export const stamp=(epoch=Date.now())=>new Date(epoch+32400000).toISOString().slice(0,16);
export const epoch=v=>Date.parse(/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(v)?v+'+09:00':v);
export const inputTime=v=>v && Number.isFinite(epoch(v)) ? stamp(epoch(v)) : '';
export const timeLabel=v=>inputTime(v).replace('T',' ')||'—';
export const addDays=(date,n)=>new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
export const weekOf=date=>addDays(date,-((new Date(date+'T12:00:00Z').getUTCDay()+6)%7));
export function newId(){return crypto.randomUUID();}
export function serial(prefix, rows, when=stamp()){
  const base=prefix+'-'+when.slice(2,10).replaceAll('-','')+'-';
  const numbers=rows.filter(r=>r.number?.startsWith(base)).map(r=>Number(r.number.slice(base.length))).filter(Number.isFinite);
  return base+String(numbers.reduce((n,next)=>Math.max(n,next),0)+1).padStart(3,'0');
}
export function record(data,row,text){
  const item={at:stamp(),text};
  if(row)row.history=[item,...(row.history||[])];
  data.activity=[{...item},...(data.activity||[])].slice(0,60);
}
export function moneyValue(value){
  if(value==null||String(value).trim()==='')return null;
  const n=Number(value);
  if(!Number.isInteger(n)||n<0||n>1e9)throw Error('운임은 0~10억 원 범위의 정수로 입력해 주세요.');
  return n;
}
export function validateOrder(data,v,recurring=false){
  if(!getRow(data,'shippers',v.shipperId)||getRow(data,'shippers',v.shipperId).active===false)throw Error('사용 중인 화주를 선택해 주세요.');
  if(!getRow(data,'branches',v.branchId))throw Error('담당 지점을 선택해 주세요.');
  if(!getRow(data,'locations',v.pickupLocationId)||!getRow(data,'locations',v.dropoffLocationId)||v.pickupLocationId===v.dropoffLocationId)throw Error('서로 다른 상차지와 하차지를 선택해 주세요.');
  if (recurring ? !/^\d\d:\d\d$/.test(v.startTime)||!/^\d\d:\d\d$/.test(v.endTime)||v.endTime<=v.startTime : !(epoch(v.start)<epoch(v.end)))throw Error('하차 예정은 상차 예정 이후로 입력해 주세요.');
  if(!String(v.cargoName||'').trim() || String(v.cargoName).length>100)throw Error('화물명은 1~100자로 입력해 주세요.');
  if(!(v.quantity>0&&v.quantity<=1e6))throw Error('수량은 0 초과 100만 이하로 입력해 주세요.');
  for(const k of ['weightKg','capacityKg'])if(!Number.isInteger(v[k])||v[k]<1||v[k]>100000)throw Error('화물 중량과 적재능력은 1~100,000kg 범위로 입력해 주세요.');
  if(!data.codes.units.includes(v.unit)||!data.codes.vehicleTypes.includes(v.vehicleType))throw Error('차량 형태와 화물 단위를 확인해 주세요.');
  if(!['상온','냉장','냉동'].includes(v.temperature)||!['편도','왕복'].includes(v.tripType))throw Error('온도 조건과 운송 형태를 확인해 주세요.');
  if(v.temperature!=='상온'&&v.vehicleType!=='냉장·냉동')throw Error('저온 화물은 냉장·냉동 차량을 선택해 주세요.');
  moneyValue(v.sellAmount);moneyValue(v.buyAmount);
}
export function matchRate(data,order){
  const from=getRow(data,'locations',order.pickupLocationId),to=getRow(data,'locations',order.dropoffLocationId);
  return data.rates.filter(r=>r.active!==false&&from&&to&&r.pickupRegion===from.region&&r.dropoffRegion===to.region&&r.vehicleType===order.vehicleType&&r.capacityKg>=Math.max(order.weightKg,order.capacityKg)).sort((a,b)=>a.capacityKg-b.capacityKg)[0];
}
export function assignProblem(data,o,v,d,excluded='',now=Date.now()){
  if(!v)return '차량을 선택해 주세요.';
  if(v.type!==o.vehicleType)return '요청 차량 형태와 다름';
  if(v.capacityKg<Math.max(o.weightKg,o.capacityKg))return '적재능력 부족';
  if(v.readiness!=='ready'||v.manualHold)return '차량 배차 불가';
  if(!d||!d.active||d.availability!=='available')return '배차 가능한 기사 필요';
  if(data.policies.requireDriverCheck&&!d.licenseChecked)return '기사 면허 확인 필요';
  if((v.carrierId||'')!==(d.carrierId||''))return '차량·기사 소속 불일치';
  if(v.carrierId&&!getRow(data,'carriers',v.carrierId)?.active)return '운송사 사용 중지';
  const buffer=(Number(data.policies.bufferMinutes)||0)*60000;
  const overlaps=(r)=>epoch(o.start)<epoch(r.end)+buffer&&epoch(r.start)<epoch(o.end)+buffer;
  const jobs=data.shipments.filter(s=>s.id!==excluded&&!['delivered','cancelled'].includes(s.status)&&(s.vehicleId===v.id||s.driverId===d.id));
  if(jobs.some(s=>epoch(s.end)<now))return '미완료 운송 확인 필요';
  if(jobs.some(overlaps))return '차량·기사 운송 일정 중복';
  if(data.services.some(s=>s.vehicleId===v.id&&s.status!=='done'&&overlaps(s)))return '차량 관리 일정 중복';
  if(data.incidents.some(s=>s.vehicleId===v.id&&(s.type==='사고'||s.vehicleBlocked)&&s.status==='open'))return '차량 사고·운행 제한 확인 필요';
  return '';
}
export function candidate(data,o,v,excluded){
  const drivers=data.drivers.filter(d=>(v.carrierId||'')===(d.carrierId||'')&&d.active!==false);
  const preferred=drivers.find(d=>d.id===v.driverId);
  const ordered=[preferred,...drivers.filter(d=>d!==preferred)].filter(Boolean);
  const eligible=ordered.filter(d=>d.active&&d.availability==='available'&&(!data.policies.requireDriverCheck||d.licenseChecked));
  const driver=eligible.find(d=>!assignProblem(data,o,v,d,excluded))||eligible[0]||ordered[0];
  return {vehicle:v,driver,reason:assignProblem(data,o,v,driver,excluded)};
}
export function makeOrder(data,values){
  validateOrder(data,values);
  if(values.externalRef&&data.orders.some(o=>o.shipperId===values.shipperId&&o.externalRef?.toLowerCase()===values.externalRef.toLowerCase()))throw Error('같은 화주 주문번호가 이미 등록되어 있습니다.');
  const order={...values,id:newId(),number:serial('C',data.orders),status:'open',shipmentId:'',history:[],createdAt:stamp()};
  data.orders.unshift(order);record(data,order,'운송 주문 접수');return order;
}
export function assign(data,order,values,prev){
  if(!order || (!prev&&order.status!=='open') || (prev&&!['requested','confirmed'].includes(prev.status)))throw Error('미배차 주문 또는 운송 시작 전 배차만 변경할 수 있습니다.');
  if(prev&&(prev.invoiceStatus==='issued'||prev.payableStatus==='confirmed'||data.payments.some(p=>p.shipmentId===prev.id)))throw Error('거래가 기록된 배차입니다. 정산 내역을 확인해 주세요.');
  const vehicle=getRow(data,'vehicles',values.vehicleId),driver=getRow(data,'drivers',values.driverId);
  const reason=assignProblem(data,order,vehicle,driver,prev?.id);if(reason)throw Error(reason);
  const shipment=prev||{id:newId(),number:serial('T',data.shipments),orderIds:[order.id],allocations:[{orderId:order.id,quantity:order.quantity,weightKg:order.weightKg}],invoiceStatus:'draft',payableStatus:'draft',events:[],proof:{status:'missing',files:[],receiver:'',at:'',note:''},history:[]};
  const status=(!vehicle.carrierId&&data.policies.ownAutoConfirm)?'confirmed':'requested';
  Object.assign(shipment,values,{status,branchId:order.branchId,carrierId:vehicle.carrierId||'',start:order.start,end:order.end});
  shipment.events.push({at:stamp(),type:prev?'reassigned':status,note:values.note});
  if(!prev)data.shipments.unshift(shipment);
  order.status='assigned';order.shipmentId=shipment.id;
  record(data,shipment,prev?'차량·기사 재배차':'차량·기사 배차');record(data,order,shipment.number+' '+shipStates[status]);return shipment;
}
export function shipAction(data,s,action,values){
  const o=firstOrder(data,s),note=values.note.trim(),at=values.at||stamp();let text,event;
  if(action==='release'||action==='decline'){
    if(!['requested','confirmed'].includes(s.status)||(action==='decline'&&s.status!=='requested')||!note)throw Error('처리 가능한 배차와 사유를 확인해 주세요.');
    s.status='cancelled'; s.cancelReason=note;event=action==='decline'?'declined':'cancelled';text=action==='decline'?'배차 거절':'배차 해제';
    for(const id of s.orderIds){const order=getRow(data,'orders',id);if(order?.shipmentId===s.id){order.status='open';order.shipmentId='';record(data,order,text);}}
  }else if(action==='accept'){
    if(s.status!=='requested')throw Error('수락 대기 상태에서만 확정할 수 있습니다.');
    const err=assignProblem(data,o,getRow(data,'vehicles',s.vehicleId),getRow(data,'drivers',s.driverId),s.id);if(err)throw Error(err);
    s.status='confirmed';event='confirmed';text='배차 수락·확정';
  }else {
    const next=stepMap[s.status]; if(!next||next.type!==action)throw Error('운송 단계를 다시 확인해 주세요.');
    if(!Number.isFinite(epoch(at))||s.events.some(e=>epoch(e.at)>epoch(at)))throw Error('처리 일시는 이전 기록 이후로 입력해 주세요.');
    if(action==='arrived'){
      const err=assignProblem(data,o,getRow(data,'vehicles',s.vehicleId),getRow(data,'drivers',s.driverId),s.id);
      if(err)throw Error(err);
      if(data.shipments.some(other=>other.id!==s.id&&['loading','in_transit'].includes(other.status)&&(other.vehicleId===s.vehicleId||other.driverId===s.driverId)))throw Error('같은 차량·기사의 진행 중인 운송을 먼저 완료해 주세요.');
    }
    s.status=next.to;event=next.type;text=next.label;
    if(action==='delivered')for(const id of s.orderIds){const order=getRow(data,'orders',id);if(order){order.status='completed';record(data,order,s.number+' 하차 완료');}}
  }
  s.events.push({at,type:event,note});record(data,s,text+(note?' · '+note:''));
}
