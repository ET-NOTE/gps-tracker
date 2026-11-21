import { useState } from 'react';
import { FreightDrawer } from './FreightKit';
import { FreightButton, FreightFacts, FreightFilters, FreightForm, FreightStats, FreightTable } from './FreightKit';
import { FormField, formValues, OfficeFilter, downloadRows } from './FreightOfficeFields';
import { catalogFields, catalogFilters, catalogTable } from './FreightCatalogFields';
import { catalogNames, catalogInUse, saveCatalog, removeCatalog, finishService } from '../../lib/freightCatalog';
import { getRow, timeLabel, shipStates } from '../../lib/freightWorkflow';
import { terminalState } from './FreightDevices';

function relatedRows(data,kind,id) {
  if (kind==='vehicles'||kind==='drivers'||kind==='carriers') {
    const field={vehicles:'vehicleId',drivers:'driverId',carriers:'carrierId'}[kind];
    return data.shipments.filter(r=>r[field]===id).map(r=>[r.number,timeLabel(r.start)+' · '+shipStates[r.status]]);
  }
  if(kind==='locations'||kind==='shippers')return data.orders.filter(o=>kind==='shippers'?o.shipperId===id:o.pickupLocationId===id||o.dropoffLocationId===id).map(o=>[o.number,o.cargoName]);
  return [];
}
function facts(fields,row) {
  return fields.map(f=>{
    const v=row[f.key];
    const value=f.options ? f.options[v] : f.type==='checkbox' ? (v?'예':'아니요') : f.type==='number'&&v!=null ? v.toLocaleString('ko-KR') : f.type==='datetime-local' ? timeLabel(v) : v;
    return [f.label,value==null||value===''?'—':value];
  });
}
export default function FreightCatalog({kind,data,save,devices=[],onPage}) {
  const [query,setQuery]=useState(''),[filter,setFilter]=useState({}),[view,setView]=useState(null);
  const fields=catalogFields(kind,data),filters=catalogFilters(kind,data),title=catalogNames[kind];
  const columns=catalogTable(kind,data,v=>{
    if(!v.deviceId)return '미연결';
    const dev=devices.find(x=>String(x.id)===String(v.deviceId));
    return dev?terminalState(dev,data.policies).label:'단말 정보 확인 필요';
  });
  const rows=data[kind].filter(row=>filters.every(f=>!filter[f.field]||f.value(row)===filter[f.field]) &&
    [...columns.map(([,cell])=>cell(row)),row.note,row.phone,row.email,row.instructions].join(' ').toLowerCase().includes(query.trim().toLowerCase()));
  const headings=columns.map(([h])=>h);
  const row=view?.id?getRow(data,kind,view.id):null;
  const readyBranch=!['drivers','vehicles'].includes(kind)||data.branches.length>0;
  const readyVehicle=kind!=='services'||data.vehicles.length>0;
  const missing=!readyBranch?'운영 지점을 먼저 등록해 주세요.':!readyVehicle?'화물차량을 먼저 등록해 주세요.':'';
  const toDetail=id=>setView({action:'detail',id});
  const close=()=>setView(null);
  const closeForm=()=>row?toDetail(row.id):close();
  async function submit(form) {
    const next=structuredClone(data);
    const id=saveCatalog(next,kind,row?.id,formValues(form,fields));
    await save(next);toDetail(id);
  }
  async function confirm() {
    const next=structuredClone(data);
    if(view.action==='delete')removeCatalog(next,kind,row.id);
    else finishService(next,row.id);
    await save(next);
    if(view.action==='delete')close();else toDetail(row.id);
  }
  const related=row?relatedRows(data,kind,row.id):[];
  return <section className="fr-section">
    {['shippers','carriers'].includes(kind)&&<FreightStats items={[[kind==='shippers'?'조회 화주':'조회 협력 운송사',rows.length+'곳'],['사용 중',rows.filter(r=>r.active!==false).length+'곳'],['월합산 정산',rows.filter(r=>(r.billing||r.settlement)==='월합산').length+'곳']]}/>}
    <div className="fr-toolbar"><strong>{title} {rows.length.toLocaleString('ko-KR')}건</strong><div className="fr-actions">
      <FreightButton onClick={()=>downloadRows(title,headings,rows.map(row=>columns.map(([,cell])=>cell(row))))} disabled={!rows.length}>CSV 다운로드</FreightButton>
      <FreightButton primary onClick={()=>setView({action:'form'})} disabled={!!missing}>{title} 등록</FreightButton></div></div>
    {missing&&<div className="fr-card fr-toolbar"><span>{missing}</span><FreightButton onClick={()=>onPage(!readyBranch?'organization':'cargo-vehicles')}>{!readyBranch?'지점 관리':'차량 목록'}</FreightButton></div>}
    <FreightFilters query={query} onQuery={setQuery} placeholder={title+' 검색'}>{filters.map(f=><OfficeFilter key={f.field} {...f} value={filter[f.field]} onChange={v=>setFilter({...filter,[f.field]:v})}/>)}
      <FreightButton onClick={()=>{setFilter({});setQuery('');}}>조건 초기화</FreightButton></FreightFilters>
    <FreightTable columns={headings} rows={rows.map(row=>({id:row.id,onOpen:()=>toDetail(row.id),cells:columns.map(([,cell],i)=>i===0?<button type="button" className="fr-link" onClick={()=>toDetail(row.id)}>{cell(row)}</button>:cell(row))}))} empty={data[kind].length?'조회 조건에 맞는 항목이 없습니다.':'등록된 '+title+' 정보가 없습니다.'}/>
    {view?.action==='detail'&&row&&<FreightDrawer title={title+' 상세'} subtitle={row.plate||row.name||row.type} onClose={close}
      footer={<div className="fr-actions"><FreightButton onClick={close}>닫기</FreightButton>
        {kind!=='services'&&!catalogInUse(data,kind,row.id)&&<FreightButton onClick={()=>setView({action:'delete',id:row.id})}>삭제</FreightButton>}
        {kind==='services'&&row.status!=='done'&&<FreightButton onClick={()=>setView({action:'done',id:row.id})}>작업 완료</FreightButton>}
        {(kind!=='services'||row.status!=='done')&&<FreightButton primary onClick={()=>setView({action:'form',id:row.id})}>정보 수정</FreightButton>}</div>}>
      <FreightFacts items={[...facts(fields,row),...(row.completedAt?[['완료 일시',timeLabel(row.completedAt)]]:[])]}/>
      {related.length>0&&<section className="fr-card"><h3>연결 내역 {related.length}건</h3><FreightFacts items={related}/></section>}
    </FreightDrawer>}
    {view?.action==='form'&&<FreightForm title={title+(row?' 수정':' 등록')} onClose={closeForm} onSubmit={submit}>
      {fields.map(f=><FormField key={f.key} field={f} initial={row||{}}/>)}
    </FreightForm>}
    {['delete','done'].includes(view?.action)&&row&&<FreightForm title={view.action==='delete'?title+' 삭제':'작업 완료 기록'} onClose={closeForm} onSubmit={confirm} submitLabel={view.action==='delete'?'삭제':'완료 기록'}>
      <p className="fr-note">{view.action==='delete'?(row.name||row.plate)+' 정보를 삭제할까요?':row.type+' 작업을 완료 처리할까요?'}</p>
    </FreightForm>}
  </section>;
}
