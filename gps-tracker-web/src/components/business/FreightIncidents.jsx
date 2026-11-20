import {useState} from 'react';
import {newId,getRow,stamp,timeLabel,record,vehicleName} from '../../lib/freightWorkflow';
import {restoreVehicle} from '../../lib/freightCatalog';
import {FreightButton,FreightFilters,FreightField,FreightTable,FreightForm,FreightOptions,FreightBadge} from './FreightKit';

export default function FreightIncidents({data,save,onPage}) {
  const [editor,setEditor]=useState(null),[vehicle,setVehicle]=useState(''),[q,search]=useState(''),[status,filter]=useState('');
  async function submit(form){
    const v=Object.fromEntries(form),next=structuredClone(data);let incident;
    if(editor.id){
      incident=getRow(next,'incidents',editor.id);
      const resolution=v.resolution.trim();
      if(!resolution || (incident.vehicleBlocked&&!form.has('checked')))throw Error('조치 내용과 차량 상태를 확인해 주세요.');
      Object.assign(incident,{resolution,status:'resolved',resolvedAt:stamp()});
      if(incident.vehicleBlocked) restoreVehicle(next,incident.vehicleId);
    }else{
      if(!v.note.trim())throw Error('발생 내용을 입력해 주세요.');
      incident={id:newId(),shipmentId:v.shipmentId,vehicleId:vehicle,type:v.type,severity:v.severity,at:v.at,note:v.note.trim(),resolution:'',status:'open',vehicleBlocked:v.type==='사고'||form.has('vehicleBlocked')};
      next.incidents.unshift(incident);
      if(incident.vehicleBlocked)getRow(next,'vehicles',vehicle).readiness='hold';
    }
    record(next,getRow(next,'shipments',incident.shipmentId),vehicleName(next,incident.vehicleId)+' '+incident.type+(editor.id?' 처리 완료':' 등록'));
    await save(next);setEditor(null);
  }
  const list=data.incidents.filter(i=>(!status||i.status===status)&&[vehicleName(data,i.vehicleId),getRow(data,'shipments',i.shipmentId)?.number,i.type,i.note,i.resolution].join(' ').includes(q));
  return <div className="fr-page">
    <div className="fr-toolbar"><strong>처리 중 {data.incidents.filter(i=>i.status==='open').length}건</strong>
      {data.vehicles.length?<FreightButton primary onClick={()=>{setVehicle(data.vehicles[0].id);setEditor({});}}>발생 내역 등록</FreightButton>:<FreightButton onClick={()=>onPage('cargo-vehicles')}>차량 등록하기</FreightButton>}</div>
    <FreightFilters query={q} onQuery={search} placeholder="차량번호, 운송번호, 내용"><FreightField label="처리 상태"><select value={status} onChange={e=>filter(e.target.value)}><option value="">전체</option><option value="open">처리 중</option><option value="resolved">처리 완료</option></select></FreightField></FreightFilters>
    <FreightTable columns={['차량·운송','구분','발생 일시','발생 내용','처리 결과','상태']} rows={list.map(i=>({id:i.id,cells:[<>{vehicleName(data,i.vehicleId)}<small>{getRow(data,'shipments',i.shipmentId)?.number}</small></>,<>{i.type}{i.severity==='urgent'&&<small>우선 확인</small>}</>,timeLabel(i.at),i.note,i.resolution||'—',i.status==='open'?<FreightButton onClick={()=>setEditor(i)}>처리 결과 등록</FreightButton>:<FreightBadge tone="green">처리 완료</FreightBadge>]}))}/>
    {editor&&<FreightForm title={editor.id?'처리 결과 등록':'지연·사고 등록'} onClose={()=>setEditor(null)} onSubmit={submit}>
      {editor.id?<><FreightField label="조치 내용" wide><textarea required name="resolution" maxLength={1500}/></FreightField>{editor.vehicleBlocked&&<label className="fr-checks"><input type="checkbox" required name="checked"/>차량 상태와 남은 제한 사유를 확인했습니다.</label>}</>:<>
        <FreightField label="차량"><select required value={vehicle} onChange={e=>setVehicle(e.target.value)}><FreightOptions rows={data.vehicles} label="plate"/></select></FreightField>
        <FreightField label="연결 운송"><select name="shipmentId" key={vehicle}><FreightOptions rows={data.shipments.filter(s=>s.vehicleId===vehicle&&s.status!=='cancelled')} label="number" blank="미연결"/></select></FreightField>
        <FreightField label="발생 구분"><select name="type">{['지연','사고','화물 손상','기타'].map(x=><option key={x}>{x}</option>)}</select></FreightField>
        <FreightField label="중요도"><select name="severity"><option value="normal">일반</option><option value="urgent">우선 확인</option></select></FreightField>
        <FreightField label="발생 일시"><input type="datetime-local" name="at" required defaultValue={stamp()}/></FreightField>
        <label className="fr-checks"><input type="checkbox" name="vehicleBlocked"/>차량 배차 일시 제한 (사고는 자동 적용)</label>
        <FreightField label="발생 내용" wide><textarea name="note" required maxLength={1500}/></FreightField>
      </>}
    </FreightForm>}
  </div>;
}
