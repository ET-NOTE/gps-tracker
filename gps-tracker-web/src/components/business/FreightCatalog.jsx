import { useState } from 'react';
import { FreightDrawer } from './FreightKit';
import { FreightBadge, FreightButton, FreightFacts, FreightFilters, FreightForm, FreightStats, FreightTable, Status } from './FreightKit';
import { FormField, formValues, OfficeFilter, downloadRows } from './FreightOfficeFields';
import { catalogFields, catalogFilters, catalogTable } from './FreightCatalogFields';
import { availabilityLabels, catalogNames, catalogInUse, saveCatalog, removeCatalog, finishService, readinessLabels } from '../../lib/freightCatalog';
import { epoch, getRow, nameOf, orderStates, timeLabel, shipStates, vehicleName } from '../../lib/freightWorkflow';
import { terminalState } from './FreightDevices';

function CatalogLinks({data,kind,id,onOpen}) {
  const orders=data.orders.filter(o=>(kind==='shippers'&&o.shipperId===id)||(kind==='locations'&&(o.pickupLocationId===id||o.dropoffLocationId===id)));
  const orderIds=new Set(orders.map(o=>o.id));
  const shipments=data.shipments.filter(s=>(kind==='vehicles'&&s.vehicleId===id)||(kind==='carriers'&&s.carrierId===id)||
    (kind==='shippers'&&s.orderIds?.some(orderId=>orderIds.has(orderId))));
  const lists=[];
  if(kind==='vehicles')lists.push(['관리 일정','services',data.services.filter(s=>s.vehicleId===id)]);
  if(kind==='locations'||kind==='shippers')lists.push(['연결 주문','orders',orders]);
  if(['shippers','carriers','vehicles'].includes(kind))lists.push(['연결된 운송','shipments',shipments]);
  return lists.map(([title,type,rows])=><section key={type} className="fr-record-block"><h3>{title} · {rows.length}건</h3>
    {rows.length?rows.map(r=><button type="button" className="fr-record-link" key={r.id} onClick={()=>onOpen(type,r.id)}>
      <span>{r.number||r.type}<small>{timeLabel(r.start)}{r.cargoName?' · '+r.cargoName:''}</small></span>
      {type==='services'?<FreightBadge tone={r.status==='done'?'green':'neutral'}>{r.status==='done'?'완료':'예정'}</FreightBadge>:<Status value={r.status} labels={type==='shipments'?shipStates:orderStates}/>}
    </button>):<p className="fr-record-note">등록된 내역이 없습니다.</p>}
  </section>);
}
function facts(fields,row) {
  return fields.map(f=>{
    const v=row[f.key];
    const value=f.options ? f.options[v] : f.type==='checkbox' ? (v?'예':'아니요') : f.type==='number'&&v!=null ? v.toLocaleString('ko-KR') : f.type==='datetime-local' ? timeLabel(v) : v;
    return [f.label,value==null||value===''?'—':value];
  });
}
export default function FreightCatalog({kind,data,save,devices=[],onPage,onOpenRecord}) {
  const [query,setQuery]=useState(''),[filter,setFilter]=useState({}),[view,setView]=useState(null);
  const filters=catalogFilters(kind,data),title=catalogNames[kind];
  const columns=catalogTable(kind,data,v=>{
    if(!v.deviceId)return '미연결';
    const dev=devices.find(x=>String(x.id)===String(v.deviceId));
    return dev?terminalState(dev,data.policies).label:'단말 정보 확인 필요';
  });
  const rows=data[kind].filter(row=>filters.every(f=>!filter[f.field]||f.value(row)===filter[f.field]) &&
    [...columns.map(([,cell])=>cell(row)),row.note,row.phone,row.email,row.instructions].join(' ').toLowerCase().includes(query.trim().toLowerCase()));
  const headings=columns.map(([h])=>h);
  const readyBranch=!['drivers','vehicles'].includes(kind)||data.branches.length>0;
  const readyVehicle=kind!=='services'||data.vehicles.length>0;
  const missing=!readyBranch?'운영 지점을 먼저 등록해 주세요.':!readyVehicle?'화물차량을 먼저 등록해 주세요.':'';
  const toDetail=id=>setView({action:'detail',id});
  return <section className="fr-section fr-catalog">
    {['shippers','carriers'].includes(kind)&&<FreightStats items={[[kind==='shippers'?'조회 화주':'조회 협력 운송사',rows.length+'곳'],['사용 중',rows.filter(r=>r.active!==false).length+'곳'],['월합산 정산',rows.filter(r=>(r.billing||r.settlement)==='월합산').length+'곳']]}/>}
    <div className="fr-toolbar"><strong>{title} {rows.length.toLocaleString('ko-KR')}건</strong><div className="fr-actions">
      <FreightButton onClick={()=>downloadRows(title,headings,rows.map(row=>columns.map(([,cell])=>cell(row))))} disabled={!rows.length}>CSV 다운로드</FreightButton>
      <FreightButton primary onClick={()=>setView({action:'form'})} disabled={!!missing}>{title} 등록</FreightButton></div></div>
    <FreightFilters query={query} onQuery={setQuery} placeholder={title+' 검색'} onReset={()=>{setFilter({});setQuery('');}}>{filters.map(f=><OfficeFilter key={f.field} {...f} value={filter[f.field]} onChange={v=>setFilter({...filter,[f.field]:v})}/>)}
      {missing&&<div className="fr-setup-hint"><span>{missing}</span><FreightButton onClick={()=>onPage(!readyBranch?'organization':'cargo-vehicles')}>{!readyBranch?'지점 관리':'차량 목록'}</FreightButton></div>}</FreightFilters>
    <FreightTable columns={headings} rows={rows.map(row=>({id:row.id,onOpen:()=>toDetail(row.id),cells:columns.map(([,cell],i)=>i===0?<button type="button" className="fr-link" onClick={()=>toDetail(row.id)}>{cell(row)}</button>:cell(row))}))} empty={data[kind].length?'조회 조건에 맞는 항목이 없습니다.':'등록된 '+title+' 정보가 없습니다.'}/>
    {view&&<FreightCatalogDialogs {...{kind,data,save,view,setView,onOpenRecord}}/>}
  </section>;
}

function DriverDetail({data,row,onVehicle,onShipment}) {
  const vehicles=data.vehicles.filter(vehicle=>vehicle.driverId===row.id);
  const shipments=data.shipments.filter(s=>s.driverId===row.id).sort((a,b)=>epoch(b.start)-epoch(a.start));
  return <div className="fr-driver-detail">
    <section className="fr-record-block"><h3>기사 정보</h3><FreightFacts items={[
      ['이름',row.name],['연락처',row.phone],['소속',row.carrierId?nameOf(data,'carriers',row.carrierId):'자사 운영'],
      ['운영 지점',nameOf(data,'branches',row.branchId)],['상태',row.active===false?'사용 중지':availabilityLabels[row.availability]||'—'],
      ['면허 확인',row.licenseChecked?'확인 완료':'확인 필요'],
    ]}/></section>
    <section className="fr-record-block"><h3>기본 연결 차량</h3>{vehicles.length?vehicles.map(v=>
      <button type="button" className="fr-record-link" key={v.id} onClick={()=>onVehicle(v.id)}>
        <span>{v.plate} · {v.type}</span><FreightBadge tone={v.readiness==='ready'?'green':'neutral'}>{readinessLabels[v.readiness]||'상태 미등록'}</FreightBadge>
      </button>):<p className="fr-record-note">기본 연결 차량이 없습니다.</p>}</section>
    <section className="fr-record-block"><h3>배차·운송 이력</h3>{shipments.length?shipments.map(s=>
      <button type="button" className="fr-record-link" key={s.id} onClick={()=>onShipment(s.id)}>
        <span>{s.number}<small>{timeLabel(s.start)} · {vehicleName(data,s.vehicleId)}</small></span><FreightBadge tone={s.status==='delivered'?'green':s.status==='cancelled'?'red':'blue'}>{shipStates[s.status]||'—'}</FreightBadge>
      </button>):<p className="fr-record-note">운송 이력이 없습니다.</p>}</section>
    <section className="fr-record-block"><h3>메모</h3><p className="fr-record-note">{row.note||'등록된 메모가 없습니다.'}</p></section>
  </div>;
}

export function FreightCatalogDialogs({kind,data,save,view,setView,onOpenRecord}) {
  const [vehicleView,setVehicleView]=useState(null);
  const fields=catalogFields(kind,data),title=catalogNames[kind];
  const row=view.id?getRow(data,kind,view.id):null;
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

  return <>
    {row&&<FreightDrawer title={title+' 상세'} subtitle={row.plate||row.name||row.type} onClose={close}
      footer={<div className="fr-actions"><FreightButton onClick={close}>닫기</FreightButton>
        {kind!=='services'&&!catalogInUse(data,kind,row.id)&&<FreightButton onClick={()=>setView({action:'delete',id:row.id})}>삭제</FreightButton>}
        {kind==='services'&&row.status!=='done'&&<FreightButton onClick={()=>setView({action:'done',id:row.id})}>작업 완료</FreightButton>}
        {(kind!=='services'||row.status!=='done')&&<FreightButton primary onClick={()=>setView({action:'form',id:row.id})}>정보 수정</FreightButton>}</div>}>
      {kind==='drivers'?<DriverDetail data={data} row={row} onVehicle={id=>setVehicleView({id,action:'detail'})} onShipment={id=>onOpenRecord('shipments',id)}/>:<>
        <FreightFacts items={[...facts(fields.filter(f=>f.key!=='note'&&f.key!=='instructions'),row),...(row.completedAt?[['완료 일시',timeLabel(row.completedAt)]]:[])]}/>
        {fields.filter(f=>f.key==='note'||f.key==='instructions').map(f=><section className="fr-record-block" key={f.key}><h3>{f.label}</h3><p className="fr-record-note">{row[f.key]||'등록된 내용이 없습니다.'}</p></section>)}
        <CatalogLinks data={data} kind={kind} id={row.id} onOpen={onOpenRecord}/>
      </>}
    </FreightDrawer>}
    {vehicleView&&<FreightCatalogDialogs kind="vehicles" data={data} save={save} view={vehicleView} setView={setVehicleView} onOpenRecord={onOpenRecord}/>}
    {view?.action==='form'&&<FreightForm size={kind==='services'||kind==='drivers'?530:720} title={title+(row?' 수정':' 등록')} onClose={closeForm} onSubmit={submit}>
      {fields.map(f=><FormField key={f.key} field={f} initial={row||{}}/>)}
    </FreightForm>}
    {['delete','done'].includes(view?.action)&&row&&<FreightForm title={view.action==='delete'?title+' 삭제':'작업 완료 기록'} onClose={closeForm} onSubmit={confirm} submitLabel={view.action==='delete'?'삭제':'완료 기록'}>
      <p className="fr-note">{view.action==='delete'?(row.name||row.plate)+' 정보를 삭제할까요?':row.type+' 작업을 완료 처리할까요?'}</p>
    </FreightForm>}
  </>;
}
