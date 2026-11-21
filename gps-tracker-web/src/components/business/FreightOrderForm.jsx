import {useState} from 'react';
import {FreightButton,FreightField,FreightForm,FreightOptions} from './FreightKit';
import useFreightStaff from './useFreightStaff';
import {addDays,getRow,inputTime,makeOrder,matchRate,moneyValue,newId,record,stamp,validateOrder,weekdays} from '../../lib/freightWorkflow';

export default function FreightOrderForm({data,row,recurring=false,onClose,commit,onPage}){
  const today=stamp().slice(0,10);
  const [values,setValues]=useState(()=>({
    name:'',externalRef:'',userId:'',shipperId:'',branchId:data.branches[0]?.id||'',pickupLocationId:'',dropoffLocationId:'',
    start:addDays(today,1)+'T09:00',end:addDays(today,1)+'T15:00',startTime:'09:00',endTime:'15:00',weekdays:[1,2,3,4,5],
    cargoName:'',quantity:1,unit:data.codes.units[0]||'',weightKg:'',capacityKg:'',vehicleType:data.codes.vehicleTypes[0]||'',
    temperature:'상온',tripType:'편도',mixedAllowed:false,sellAmount:'',buyAmount:'',note:'',active:true,...row,
    ...(row&&!recurring?{start:inputTime(row.start),end:inputTime(row.end)}:{}),
  }));
  const [rateInfo,setRateInfo]=useState('');
  const staff=useFreightStaff(!recurring);
  const choices=staff.rows.filter(person=>person.active&&String(person.branch_id)===values.branchId);
  const set=(key,value)=>setValues(v=>({...v,[key]:value}));
  const bind=key=>({value:values[key]??'',onChange:e=>set(key,e.target.value)});
  const sites=data.locations.filter(l=>l.active!==false);
  const prerequisites=[
    [data.shippers.some(s=>s.active!==false),'화주','cargo-shippers'],[data.branches.length,'지점','organization'],[sites.length>=2,'상·하차지','cargo-locations']
  ].filter(([ready])=>!ready);
  const simpleOptions=(key,label,options)=><FreightField label={label}><select required {...bind(key)}>{options.map(v=><option key={v}>{v}</option>)}</select></FreightField>;
  function useRate(){
    const rate=matchRate(data,values);
    if(rate)setValues(v=>({...v,sellAmount:rate.sellAmount??'',buyAmount:rate.buyAmount??''}));
    setRateInfo(rate?'현재 요율을 입력했습니다.':'구간과 차량 조건에 맞는 요율이 없습니다.');
  }
  async function submit(){
    const v=values;
    const common={shipperId:v.shipperId,branchId:v.branchId,pickupLocationId:v.pickupLocationId,dropoffLocationId:v.dropoffLocationId,
      cargoName:v.cargoName.trim(),quantity:Number(v.quantity),unit:v.unit,weightKg:Number(v.weightKg),capacityKg:Number(v.capacityKg),vehicleType:v.vehicleType,
      temperature:v.temperature,tripType:v.tripType,mixedAllowed:v.mixedAllowed,sellAmount:moneyValue(v.sellAmount),buyAmount:moneyValue(v.buyAmount),note:v.note.trim()};
    await commit(next=>{
      if(recurring){
        const changes={...common,name:v.name.trim(),startTime:v.startTime,endTime:v.endTime,weekdays:[...v.weekdays].sort(),active:v.active};
        if(!changes.name||!changes.weekdays.length)throw Error('정기 주문명과 반복 요일을 확인해 주세요.');
        validateOrder(next,changes,true);
        const r=row?getRow(next,'recurring',row.id):{id:newId(),lastGenerated:'',history:[]};
        if(!r)throw Error('정기 주문을 다시 조회해 주세요.');
        Object.assign(r,changes);
        if(!row)next.recurring.unshift(r);
        record(next,r,row?'정기 주문 수정':'정기 주문 등록');
      }else{
        const changes={...common,userId:v.userId||'',externalRef:v.externalRef.trim(),start:v.start,end:v.end};
        if(!row){makeOrder(next,changes);return;}
        const o=getRow(next,'orders',row.id);
        if(o?.status!=='open')throw Error('미배차 주문만 수정할 수 있습니다.');
        validateOrder(next,changes);
        if(changes.externalRef&&next.orders.some(other=>other.id!==o.id&&other.shipperId===changes.shipperId&&other.externalRef?.toLowerCase()===changes.externalRef.toLowerCase()))throw Error('같은 화주 주문번호가 이미 등록되어 있습니다.');
        Object.assign(o,changes);record(next,o,'운송 주문 수정');
      }
    });
  }
  return <FreightForm title={(recurring?'정기 주문':'운송 주문')+(row?' 수정':' 등록')} size={720}
    subtitle="상하차 일정, 화물 조건과 합의 운임을 입력합니다." onClose={onClose} onSubmit={submit}>
    {!!prerequisites.length&&<div className="fr-note">주문에 필요한 항목을 먼저 등록해 주세요. <div className="fr-actions">{prerequisites.map(([,label,page])=><FreightButton key={page} onClick={()=>onPage(page)}>{label} 관리</FreightButton>)}</div></div>}
    {recurring?<FreightField label="정기 주문명" wide><input required maxLength={100} {...bind('name')}/></FreightField>:<FreightField label="화주 주문번호" wide><input maxLength={80} placeholder="선택 입력" {...bind('externalRef')}/></FreightField>}
    <FreightField label="화주"><select required {...bind('shipperId')}><FreightOptions rows={data.shippers.filter(s=>s.active!==false)} blank="화주 선택"/></select></FreightField>
    <FreightField label="담당 지점"><select required value={values.branchId} onChange={e=>setValues(v=>({...v,branchId:e.target.value,userId:''}))}><FreightOptions rows={data.branches} blank="지점 선택"/></select></FreightField>
    {!recurring&&<FreightField label="배차 담당자" wide><select {...bind('userId')}><option value="">운영 관리자</option>
      {values.userId&&!choices.some(p=>String(p.id)===String(values.userId))&&<option value={values.userId}>{staff.rows.find(p=>String(p.id)===String(values.userId))?.name||'기존 담당자'}</option>}
      {choices.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>{staff.error&&<small role="status">{staff.error}</small>}</FreightField>}
    <FreightField label="상차지"><select required {...bind('pickupLocationId')}><FreightOptions rows={sites} blank="상차지 선택"/></select></FreightField>
    <FreightField label="하차지"><select required {...bind('dropoffLocationId')}><FreightOptions rows={sites} blank="하차지 선택"/></select></FreightField>
    <FreightField label="상차 예정"><input type={recurring?'time':'datetime-local'} required {...bind(recurring?'startTime':'start')}/></FreightField>
    <FreightField label="하차 예정"><input type={recurring?'time':'datetime-local'} required {...bind(recurring?'endTime':'end')}/></FreightField>
    {recurring&&<fieldset className="fr-checks"><legend>반복 요일</legend>{weekdays.map((day,i)=><label key={day}><input type="checkbox" checked={values.weekdays.includes(i)} onChange={e=>set('weekdays',e.target.checked?[...values.weekdays,i]:values.weekdays.filter(x=>x!==i))}/>{day}</label>)}</fieldset>}
    <FreightField label="화물명" wide><input required maxLength={100} {...bind('cargoName')}/></FreightField>
    <FreightField label="수량"><input required type="number" min=".01" max="1000000" step=".01" {...bind('quantity')}/></FreightField>
    {simpleOptions('unit','수량 단위',data.codes.units)}
    <FreightField label="화물 중량 (kg)"><input required type="number" min="1" max="100000" {...bind('weightKg')}/></FreightField>
    <FreightField label="필요 적재능력 (kg)"><input required type="number" min="1" max="100000" {...bind('capacityKg')}/></FreightField>
    {simpleOptions('vehicleType','필요 차량',data.codes.vehicleTypes)}{simpleOptions('temperature','온도 조건',['상온','냉장','냉동'])}
    {simpleOptions('tripType','운송 형태',['편도','왕복'])}
    <fieldset className="fr-checks"><label><input type="checkbox" checked={values.mixedAllowed} onChange={e=>set('mixedAllowed',e.target.checked)}/>혼적 허용</label>
      {recurring&&<label><input type="checkbox" checked={values.active} onChange={e=>set('active',e.target.checked)}/>정기 주문 사용</label>}</fieldset>
    <FreightField label="화주 합의 운임 (원)"><input type="number" min="0" max="1000000000" placeholder="미정" {...bind('sellAmount')}/></FreightField>
    <FreightField label="운송 합의 원가 (원)"><input type="number" min="0" max="1000000000" placeholder="미정" {...bind('buyAmount')}/></FreightField>
    <div className="fr-note"><FreightButton onClick={useRate}>현재 요율 불러오기</FreightButton> <span role="status">{rateInfo}</span></div>
    <FreightField label="요청사항·작업 메모" wide><textarea maxLength={1500} {...bind('note')}/></FreightField>
  </FreightForm>;
}
