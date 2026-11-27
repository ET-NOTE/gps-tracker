import { availabilityLabels, readinessLabels, regions, serviceStates } from '../../lib/freightCatalog';
import truckArt from './freight-truck.svg';
import { costLabel, nameOf, stamp, timeLabel, vehicleName } from '../../lib/freightWorkflow';
import { choices, choicesFrom } from './FreightOfficeFields';

const text=(key,label,maxLength=80,required=false)=>({key,label,maxLength,required});
const option=(key,label,options,defaultValue)=>({key,label,options,defaultValue,required:!Object.hasOwn(options,'')});
const num=(key,label,min=0,max=1e9,defaultValue,required=true)=>({key,label,min,max,type:'number',defaultValue,required});
const typed=(key,label,type,required=true,defaultValue)=>({key,label,type,required,defaultValue});
const check=(key,label,defaultValue=false)=>({key,label,type:'checkbox',defaultValue});
const memo={key:'note',label:'메모',type:'textarea'};
export function catalogFields(key,d) {
  const branch=option('branchId','운영 지점',choicesFrom(d.branches));
  const carrier=option('carrierId','소속 운송사',{'':'자사 운영',...choicesFrom(d.carriers)});
  const contact=text('contact','담당자',40,true), phone=typed('phone','연락처','tel');
  const name=text('name','이름',80,true),active=check('active','사용 중',true);
  const regionList=choices(regions);
  if(key==='vehicles')return [
    text('plate','차량번호',30,true),text('model','차량명',60,true),option('type','차량 형태',choices(d.codes.vehicleTypes)),
    num('capacityKg','적재능력 (kg)',1,100000),branch,carrier,
    option('driverId','기본 기사',{'':'미지정',...Object.fromEntries(d.drivers.map(x=>[x.id,x.name+' · '+(x.carrierId?nameOf(d,'carriers',x.carrierId):'자사 운영')]))}),
    option('readiness','준비 상태',readinessLabels,'ready'),num('odometer','주행거리 (km)',0,1e7,0),
    typed('insuranceUntil','보험 만료일','date'),typed('inspectionAt','검사 예정일','date'),memo];
  if(key==='drivers')return [name,phone,branch,carrier,option('availability','배차 가능 여부',availabilityLabels,'available'),check('licenseChecked','면허 확인 완료'),active,memo];
  if(key==='services')return [option('vehicleId','차량',choicesFrom(d.vehicles,'plate')),option('type','일정 구분',choices(['정비','검사','보험'])),
    typed('start','시작 일시','datetime-local',true,stamp()),typed('end','종료 예정','datetime-local',true,stamp(Date.now()+3600000)),num('cost','비용 (원)',0,1e9,0),memo];
  if(key==='locations')return [text('name','장소 이름',80,true),option('region','지역',regionList),{...text('address','주소',180,true),wide:true},
    contact,phone,typed('openTime','작업 가능 시작','time',true,'08:00'),typed('closeTime','작업 가능 종료','time',true,'18:00'),{...memo,key:'instructions',label:'진입·작업 안내'}];
  if(key==='rates')return [text('name','요율 이름',80,true),option('vehicleType','차량 형태',choices(d.codes.vehicleTypes)),
    option('pickupRegion','상차 지역',regionList),option('dropoffRegion','하차 지역',regionList),num('capacityKg','기준 적재능력 (kg)',1,100000),
    num('sellAmount','화주 계약 운임 (원)',0,1e9,undefined,false),num('buyAmount','운송비 (원)',0,1e9,undefined,false),active,memo];
  const shipper=key==='shippers';
  return [{...name,label:shipper?'화주 이름':'운송사 이름'},contact,phone,text('businessNumber','사업자등록번호',12),
    ...(shipper?[typed('email','이메일','email',false)]:[]),option(shipper?'billing':'settlement',shipper?'청구 방식':'정산 방식',choices(['건별','월합산'])),active,memo];
}
export function catalogTable(key,d,terminalLabel,mockup=false) {
  const branch=r=>nameOf(d,'branches',r.branchId),carrier=r=>r.carrierId?nameOf(d,'carriers',r.carrierId):'자사 운영';
  const plate=r=>vehicleName(d,r.vehicleId),amount=x=>Number(x||0).toLocaleString('ko-KR'),active=r=>r.active!==false?'사용 중':'사용 중지';
  switch(key){
    case 'vehicles': return [['차량번호',r=>mockup?<span className="cell-car"><img className="cargo-truck small" src={truckArt} alt="" aria-hidden="true"/>{r.plate}</span>:r.plate],['차량명',r=>r.model],['형태 · 적재능력',r=>r.type+' · '+amount(r.capacityKg)+'kg'],['기사 · 소속',r=>(r.driverId?nameOf(d,'drivers',r.driverId):'미지정')+' · '+carrier(r)],['운영 지점',branch],['준비 상태',r=>readinessLabels[r.readiness]],['단말 수신',terminalLabel]];
    case 'drivers': return [['기사',r=>r.name],['연락처',r=>r.phone],['지점 · 소속',r=>branch(r)+' · '+carrier(r)],['면허',r=>r.licenseChecked?'확인 완료':'미확인'],['운영 상태',r=>r.active===false?'사용 중지':availabilityLabels[r.availability]]];
    case 'services': return [['차량',plate],['구분',r=>r.type],['시작 일시',r=>timeLabel(r.start)],['종료',r=>r.status==='done'?timeLabel(r.completedAt||r.end)+' 종료':timeLabel(r.end)+' 종료 예정'],['비용',r=>costLabel(r.cost)],['상태',r=>serviceStates[r.status]]];
    case 'locations': return mockup
      ? [['장소 / 주소',r=><>{r.name}<small>{r.address}</small></>],['지역',r=>r.region||'—'],['현장 담당자',r=>r.contact],['연락처',r=>r.phone],['작업 가능 시간',r=>r.openTime+' – '+r.closeTime+(r.closeTime<=r.openTime?' (다음 날)':'')],['작업 안내',r=>r.instructions||'—']]
      : [['장소 / 주소',r=><>{r.name}<small>{r.region+' · '+r.address}</small></>],['담당자',r=>r.contact],['연락처',r=>r.phone],['작업 가능 시간',r=>r.openTime+' – '+r.closeTime+(r.closeTime<=r.openTime?' (다음 날)':'')],['작업 안내',r=>r.instructions||'—']];
    case 'rates': return [['요율 이름',r=>r.name],['구간',r=>r.pickupRegion+' → '+r.dropoffRegion],['차량 조건',r=>r.vehicleType+' · '+amount(r.capacityKg)+'kg'],['화주 운임',r=>costLabel(r.sellAmount)],['운송비',r=>costLabel(r.buyAmount)],['상태',active]];
    default: {
      const shipper=key==='shippers';
      const countBy=(rows,field)=>{
        const counts=new Map();
        for(const row of rows)counts.set(row[field],(counts.get(row[field])||0)+1);
        return counts;
      };
      const orders=shipper&&countBy(d.orders,'shipperId');
      const vehicles=!shipper&&countBy(d.vehicles,'carrierId'),drivers=!shipper&&countBy(d.drivers,'carrierId');
      const linked=r=>shipper?(orders.get(r.id)||0)+'건 주문':(vehicles.get(r.id)||0)+'대 · '+(drivers.get(r.id)||0)+'명';
      return [[shipper?'화주':'협력 운송사',r=>r.name],['담당자',r=>r.contact],['연락처',r=>r.phone],['정산 방식',r=>r.billing||r.settlement],['연결 현황',linked],['상태',active]];
    }
  }
}
export function catalogFilters(key,d,mockup=false) {
  const opt=(field,label,options,value=r=>r[field])=>({field,label,options,value});
  const branch=opt('branchId',mockup&&key!=='vehicles'?'지점':'운영 지점',choicesFrom(d.branches),r=>key==='services'?d.vehicles.find(v=>v.id===r.vehicleId)?.branchId:r.branchId);
  const carrier=opt('carrierId','소속', {own:'자사 운영',...choicesFrom(d.carriers)},r=>r.carrierId||'own');
  const state=opt('active','사용 상태',{yes:'사용 중',no:'사용 중지'},r=>r.active!==false?'yes':'no');
  switch(key){
    case 'vehicles':return [branch,opt('type','차량 형태',choices(d.codes.vehicleTypes)),carrier,opt('readiness',mockup?'운영 상태':'준비 상태',readinessLabels)];
    case 'drivers':return [branch,carrier,opt('availability',mockup?'상태':'배차 가능 여부',availabilityLabels),...(mockup?[]:[state])];
    case 'services':return [branch,opt('type',mockup?'구분':'일정 구분',choices(['정비','검사','보험'])),opt('status',mockup?'상태':'작업 상태',serviceStates)];
    case 'locations':return [opt('region','지역',choices(regions))];
    case 'rates':return [opt('vehicleType','차량 형태',choices(d.codes.vehicleTypes)),state];
    default:return [state,opt(key==='shippers'?'billing':'settlement','정산 방식',choices(['건별','월합산']))];
  }
}
