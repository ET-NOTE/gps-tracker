import React,{useId,useRef,useState} from 'react';
import {useInfiniteQuery} from '@tanstack/react-query';
import {api} from '../../api';
import {fleetAssetLabel} from '../../lib/fleetAssets';
import {FormField,Input,Modal,Select,Textarea} from '../ui';
import Icon from '../Icon';
import './fleet-maintenance-history.css';

export const maintenanceKinds={service:'정기 점검',oil:'엔진오일 교체',tires:'타이어 교체',insurance:'보험 갱신',inspection:'차량 검사',other:'기타'};
const scheduleKinds={
  next_service_date:['service','oil','tires','other'],
  insurance_expiry:['insurance'],
  inspection_expiry:['inspection'],
};

export function CompletionEditor({assets,initialVehicle,schedule,today,onClose,onSaved,onConflict}) {
  const [vehicleId,setVehicleId]=useState(String(schedule?.asset.id||initialVehicle||''));
  const choices=schedule?scheduleKinds[schedule.key]:Object.keys(maintenanceKinds);
  const [kind,setKind]=useState(choices[0]);
  const [completedOn,setCompletedOn]=useState(today);
  const [note,setNote]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [requestId]=useState(()=>crypto.randomUUID());
  const lock=useRef(false),formId=useId();
  const close=()=>{if(!lock.current)onClose();};
  async function save(event){
    event.preventDefault();
    if(lock.current||!vehicleId||!completedOn)return;
    lock.current=true;setBusy(true);setError('');
    try {
      await api.completeFleetMaintenance(vehicleId,{
        request_id:requestId,kind,completed_on:completedOn,note:note.trim(),
        ...(schedule?{schedule_key:schedule.key,scheduled_on:schedule.date}:{}),
      });
    } catch(e) {
      setError(e.message||'이력을 저장하지 못했습니다.');
      if(e.status===409)onConflict();
      return;
    } finally {
      lock.current=false;setBusy(false);
    }
    onSaved(vehicleId);
  }
  return <Modal open title={schedule?'정비 일정 완료 처리':'정비 완료 이력 등록'} onClose={close}
    footer={<div className="fleet-assets-filter-footer">
      <button type="button" className="business-button" onClick={close} disabled={busy}>취소</button>
      <button type="submit" form={formId} className="business-button is-primary" disabled={busy||!vehicleId||!completedOn}>{busy?'저장 중…':'완료 이력 저장'}</button>
    </div>}>
    <form id={formId} onSubmit={save} className="fleet-maintenance-form">
      <FormField label="차량"><Select required disabled={busy||!!schedule} value={vehicleId} onChange={e=>setVehicleId(e.target.value)}>
        <option value="" disabled>차량 선택</option>{assets.map(a=><option key={a.id} value={a.id}>{fleetAssetLabel(a)}</option>)}
      </Select></FormField>
      {schedule&&<p className="fleet-maintenance-original"><Icon name="clock" size={16}/>{schedule.label} <time dateTime={schedule.date}>{schedule.date}</time></p>}
      <div className="fleet-maintenance-form-row">
        <FormField label="정비 종류"><Select disabled={busy} value={kind} onChange={e=>setKind(e.target.value)}>{choices.map(k=><option key={k} value={k}>{maintenanceKinds[k]}</option>)}</Select></FormField>
        <FormField label="완료일"><Input required disabled={busy} type="date" max={today} value={completedOn} onChange={e=>setCompletedOn(e.target.value)}/></FormField>
      </div>
      <FormField label="메모"><Textarea disabled={busy} rows={3} maxLength={400} value={note} onChange={e=>setNote(e.target.value)}/></FormField>
      {error&&<p role="alert" className="fleet-maintenance-error">{error}</p>}
    </form>
  </Modal>;
}

export function MaintenanceHistory({assets,vehicle,setVehicle,onDetail}) {
  const [kind,setKind]=useState('');
  const history=useInfiniteQuery({
    queryKey:['fleet-maintenance-history',vehicle,kind],
    initialPageParam:null,
    queryFn:({pageParam,signal})=>api.fleetMaintenanceHistory({
      ...(vehicle?{vehicle_id:vehicle}:{}),...(kind?{kind}:{}),
      ...(pageParam?{before_date:pageParam.completed_on,before_id:pageParam.id}:{}),
    },{signal}),
    getNextPageParam:last=>last.has_more?last.rows.at(-1):undefined,
  });
  const rows=history.data?.pages.flatMap(page=>page.rows)||[];
  const labels=new Map(assets.map(asset=>[asset.id,fleetAssetLabel(asset)]));
  return <>
    <div className="fleet-operations-filters">
      <select aria-label="완료 이력 차량" value={vehicle} onChange={e=>setVehicle(e.target.value)}><option value="">전체 차량</option>{assets.map(a=><option key={a.id} value={a.id}>{fleetAssetLabel(a)}</option>)}</select>
      <select aria-label="완료 이력 정비 종류" value={kind} onChange={e=>setKind(e.target.value)}><option value="">전체 종류</option>{Object.entries(maintenanceKinds).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select>
      {(vehicle||kind)&&<button type="button" className="business-button" onClick={()=>{setVehicle('');setKind('');}}>초기화</button>}
    </div>
    {history.isPending&&<p role="status">완료 이력을 불러오는 중…</p>}
    {history.isError&&<div role="alert" className="business-empty"><strong>완료 이력을 불러오지 못했습니다.</strong><button type="button" className="business-button" onClick={()=>history.isFetchNextPageError?history.fetchNextPage():history.refetch()}>다시 시도</button></div>}
    {history.isSuccess&&!rows.length&&<div className="business-empty"><strong>{vehicle||kind?'조건에 맞는 완료 이력이 없습니다.':'등록된 정비 완료 이력이 없습니다.'}</strong></div>}
    {!!rows.length&&<ul aria-label="정비 완료 이력" className="fleet-maintenance-history">{rows.map(row=><li key={row.id}>
      <button type="button" className="fleet-care-card-open" aria-label={(labels.get(row.vehicle_id)||'차량 정보 미등록')+' '+(maintenanceKinds[row.kind]||row.kind)+' 완료 이력 상세'} onClick={()=>onDetail(row)}/>
      <header><time dateTime={row.completed_on}>{row.completed_on}</time><span className="business-badge good">완료</span></header>
      <h3>{maintenanceKinds[row.kind]||row.kind}</h3>
      <strong>{labels.get(row.vehicle_id)||'차량 정보 미등록'}</strong>
      {row.scheduled_on&&<small>예정일 {row.scheduled_on}</small>}
      {row.note&&<p>{row.note}</p>}
    </li>)}</ul>}
    {history.hasNextPage&&!history.isFetchNextPageError&&<button type="button" className="business-button" disabled={history.isFetchingNextPage} onClick={()=>history.fetchNextPage()}>{history.isFetchingNextPage?'불러오는 중…':'이전 이력 더 보기'}</button>}
  </>;
}
