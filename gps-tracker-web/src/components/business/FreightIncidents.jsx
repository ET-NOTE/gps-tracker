import {useState} from 'react';
import {newId,getRow,stamp,timeLabel,record,vehicleName} from '../../lib/freightWorkflow';
import {restoreVehicle} from '../../lib/freightCatalog';
import {FreightButton,FreightField,FreightTable,FreightForm,FreightOptions,FreightBadge} from './FreightKit';
import {choices, choicesFrom, OfficeFilter} from './FreightOfficeFields';
import Icon from '../Icon';

const incidentTypes=['지연','사고','화물 손상','기타'];

export default function FreightIncidents({data,save,onPage}) {
  const [editor,setEditor]=useState(null),[vehicle,setVehicle]=useState(''),[q,search]=useState(''),[status,filter]=useState('');
  const [branch,setBranch]=useState(''),[type,setType]=useState('');
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
  const query=q.trim().toLowerCase();
  const list=data.incidents.filter(i=>(!branch||getRow(data,'vehicles',i.vehicleId)?.branchId===branch)&&
    (!type||i.type===type)&&(!status||i.status===status)&&[vehicleName(data,i.vehicleId),getRow(data,'shipments',i.shipmentId)?.number,i.type,i.note,i.resolution].join(' ').toLowerCase().includes(query));
  return <div className="fr-page fr-incidents">
    <div className="fr-toolbar"><span className="fr-toolbar-caption">차량 제한과 운송·정산 상태를 별도로 관리합니다.</span>
      {data.vehicles.length?<FreightButton primary icon="plus" onClick={()=>{setVehicle(data.vehicles[0].id);setEditor({});}}>발생 내역 등록</FreightButton>:<FreightButton onClick={()=>onPage('cargo-vehicles')}>차량 등록하기</FreightButton>}</div>
    <div className="fr-filters fr-incident-filters">
      <div className="fr-incident-fields">
        <label className="fr-incident-search"><Icon name="search" size={15}/><input type="search" aria-label="차량번호, 운송번호, 내용 검색" placeholder="차량번호, 운송번호, 내용 검색" value={q} onChange={e=>search(e.target.value)}/></label>
        <OfficeFilter label="지점" options={choicesFrom(data.branches)} value={branch} onChange={setBranch}/>
        <OfficeFilter label="구분" options={choices(incidentTypes)} value={type} onChange={setType}/>
        <OfficeFilter label="상태" options={{open:'처리 중',resolved:'처리 완료'}} value={status} onChange={filter}/>
      </div>
      <div className="fr-incident-filter-meta">
        <span>전체 {data.incidents.length}건 중 {list.length}건 조회</span>
        <button type="button" onClick={()=>{setBranch('');setType('');filter('');search('');}}>조건 초기화</button>
      </div>
    </div>
    <FreightTable columns={['차량·운송','구분','발생 일시','발생 내용','처리 결과','상태']} rows={list.map(i=>({id:i.id,cells:[<>{vehicleName(data,i.vehicleId)}<small>{getRow(data,'shipments',i.shipmentId)?.number}</small></>,<>{i.type}{i.severity==='urgent'&&<small>우선 확인</small>}</>,timeLabel(i.at),i.note,i.resolution||'—',i.status==='open'?<FreightButton onClick={()=>setEditor(i)}>처리 결과 등록</FreightButton>:<FreightBadge tone="green">처리 완료</FreightBadge>]}))}/>
    {editor&&<FreightForm size={editor.id?530:720} title={editor.id?'처리 결과 등록':'지연·사고 등록'} onClose={()=>setEditor(null)} onSubmit={submit}>
      {editor.id?<><FreightField label="조치 내용" wide><textarea required name="resolution" maxLength={1500}/></FreightField>{editor.vehicleBlocked&&<label className="fr-checks"><input type="checkbox" required name="checked"/>차량 상태와 남은 제한 사유를 확인했습니다.</label>}</>:<>
        <FreightField label="차량"><select required value={vehicle} onChange={e=>setVehicle(e.target.value)}><FreightOptions rows={data.vehicles} label="plate"/></select></FreightField>
        <FreightField label="연결 운송"><select name="shipmentId" key={vehicle}><FreightOptions rows={data.shipments.filter(s=>s.vehicleId===vehicle&&s.status!=='cancelled')} label="number" blank="미연결"/></select></FreightField>
        <FreightField label="발생 구분"><select name="type">{incidentTypes.map(x=><option key={x}>{x}</option>)}</select></FreightField>
        <FreightField label="중요도"><select name="severity"><option value="normal">일반</option><option value="urgent">우선 확인</option></select></FreightField>
        <FreightField label="발생 일시"><input type="datetime-local" name="at" required defaultValue={stamp()}/></FreightField>
        <label className="fr-checks"><input type="checkbox" name="vehicleBlocked"/>차량 배차 일시 제한 (사고는 자동 적용)</label>
        <FreightField label="발생 내용" wide><textarea name="note" required maxLength={1500}/></FreightField>
      </>}
    </FreightForm>}
  </div>;
}
