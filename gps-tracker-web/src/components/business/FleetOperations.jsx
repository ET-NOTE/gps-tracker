import React,{useMemo,useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import Icon from '../Icon';
import {Modal} from '../ui';
import {ageString,classifyDevice} from '../../colors';
import {businessDate} from '../../lib/business';
import {deviceBattery} from '../../lib/battery';
import {fleetAssetLabel} from '../../lib/fleetAssets';
import {maintenanceScheduleFields} from '../../lib/fleetAssetFilters';
import {useBusinessClock} from './useBusinessData';
import BusinessDrawer from './BusinessDrawer';
import CarImage from '../CarImage';
import sedan from '../entry/login-vehicle.png';
import {CompletionEditor,MaintenanceHistory,maintenanceKinds} from './FleetMaintenanceHistory';

export default function FleetOperations({mode,assets,devices,canManage,canRegisterTerminal,openDetail,editSchedule,refreshAssets}){
  const now=useBusinessClock(),today=businessDate(now),terminals=mode==='devices';
  const client=useQueryClient();
  const [completion,setCompletion]=useState(null),[historyRevision,setHistoryRevision]=useState(0);
  const [query,setQuery]=useState(''),[status,setStatus]=useState('all'),[vehicle,setVehicle]=useState('');
  const [detail,setDetail]=useState(null);
  const [picker,setPicker]=useState(null),[chosen,setChosen]=useState('');
  const current=useMemo(()=>{
    const map=new Map();
    for(const asset of assets)for(const b of asset.bindings||[]){
      if(b.device_id!=null&&!b.ended_at)map.set(b.device_id,{asset,binding:b});
    }
    return map;
  },[assets]);
  const terminalRows=useMemo(()=>{
    const byId=new Map(devices.map(d=>[d.id,d]));
    for(const [id,{binding}] of current)if(!byId.has(id))byId.set(id,{id,display_name:binding.terminal_name,unavailable:true});
    return Array.from(byId.values(),d=>{
      const linked=current.get(d.id),reading=classifyDevice(d,undefined,now);
      const offline=d.unavailable||['offline','lost','unknown','signal_loss'].includes(reading.id);
      return {id:d.id,name:d.display_name||d.device_uid||('단말 '+d.id),device:d,asset:linked?.asset,primary:linked?.binding.is_primary,reading,offline};
    });
  },[devices,current,now]);
  const matchingAsset=asset=>(!vehicle||String(asset?.id)===vehicle);
  const contains=(...values)=>values.some(v=>String(v||'').toLocaleLowerCase('ko').includes(query.trim().toLocaleLowerCase('ko')));
  const visibleTerminals=terminalRows.filter(r=>matchingAsset(r.asset)&&contains(r.name,r.asset?.name,r.asset?.license_plate,r.asset?.department)
    &&(status==='all'||(status==='linked'&&r.asset)||(status==='receiving'&&r.device.last_seen_at && !r.device.unavailable && now-Date.parse(r.device.last_seen_at)<=300000)||(status==='unlinked'&&!r.asset)||(status==='check'&&r.offline)));
  const allSchedules=assets.flatMap(asset=>maintenanceScheduleFields.map(([key,label])=>({asset,key,label,date:asset.profile?.[key]||''})));
  const schedules=allSchedules.filter(r=>matchingAsset(r.asset)&&contains(r.asset.name,r.asset.license_plate,r.asset.car_model,r.asset.department,r.label)
      &&(status==='all'&&r.date||status==='overdue'&&r.date&&r.date<today||status==='missing'&&!r.date))
    .sort((a,b)=>a.date.localeCompare(b.date)||fleetAssetLabel(a.asset).localeCompare(fleetAssetLabel(b.asset),'ko',{numeric:true}));
  const options=terminals?[['all','전체'],['receiving','정상 수신'],['check','수신 확인'],['unlinked','미연결'],['linked','차량 연결']]:[['all','등록 일정'],['overdue','기한 경과'],['missing','미등록'],['completed','완료 이력']];
  const schedule=detail?.key && allSchedules.find(r=>r.asset.id===detail.assetId&&r.key===detail.key);
  const completed=detail?.history;
  const inspectedAsset=schedule?.asset || (completed && assets.find(a=>a.id===completed.vehicle_id));
  const careLabel=schedule?.label || (completed && (maintenanceKinds[completed.kind]||completed.kind));
  const showHistory=!terminals&&status==='completed';
  function savedCompletion(id){
    setCompletion(null);
    setDetail(null);
    setVehicle(String(id));
    setHistoryRevision(value=>value+1);
    setStatus('completed');
    client.invalidateQueries({queryKey:['fleet-maintenance-history']});
    refreshAssets();
  }
  function chooseVehicle(action){setPicker(action);setChosen(vehicle||String(assets[0]?.id||''));}
  function confirm(){
    const asset=assets.find(a=>String(a.id)===chosen);
    if(!asset)return;
    if(picker==='schedule')editSchedule(asset,'all');
    else if (picker==='history')openDetail(asset.id,'history');
    else openDetail(asset.id,'connections',picker.device.id);
    setPicker(null);
  }
  return <div className="fleet-operations">
    <div className="fleet-operations-toolbar"><div className="fleet-operations-status" aria-label={terminals?'단말 상태':'일정 상태'}>{options.map(([id,label])=><button type="button" key={id} aria-pressed={status===id} onClick={()=>setStatus(id)}>{label}</button>)}</div>
    {terminals&&<div className="fleet-maintenance-actions">{canManage&&assets.length>0&&<button className="business-button" type="button" onClick={()=>chooseVehicle('history')}><Icon name="clock" size={16}/>연결 이력</button>}
      {canRegisterTerminal&&<a className="business-button is-primary" href={(import.meta.env.BASE_URL||'/')+'devices/pair'}><Icon name="plus" size={16}/>단말기 등록</a>}</div>}
    {!terminals&&canManage&&assets.length>0&&<div className="fleet-maintenance-actions">
      <button type="button" className={showHistory?'business-button':'business-button is-primary'} onClick={()=>chooseVehicle('schedule')}><Icon name="plus" size={16}/>일정 등록</button>
      <button type="button" className={showHistory?'business-button is-primary':'business-button'} onClick={()=>setCompletion({})}>완료 이력 등록</button>
    </div>}</div>
    {showHistory?<MaintenanceHistory key={historyRevision} assets={assets} vehicle={vehicle} setVehicle={setVehicle} onDetail={history=>setDetail({history})}/>:<>
    <div className="fleet-operations-filters"><label><Icon name="search" size={16}/><input type="search" aria-label={terminals?'단말기 검색':'정비·보험 일정 검색'} placeholder={terminals?'단말기·차량 검색':'차량·일정 검색'} value={query} onChange={e=>setQuery(e.target.value)}/></label>
    <select aria-label="차량 선택" value={vehicle} onChange={e=>setVehicle(e.target.value)}><option value="">전체 차량</option>{assets.map(a=><option key={a.id} value={a.id}>{fleetAssetLabel(a)}</option>)}</select>
    {(vehicle||query||status!=='all')&&<button type="button" className="business-button" onClick={()=>{setVehicle('');setQuery('');setStatus('all');}}>초기화</button>}</div>
    {terminals?<div className="fleet-operations-cards">{visibleTerminals.map(r=>{
      const battery=deviceBattery(r.device);
      return <article className="fleet-operations-card" key={r.id}>
        <header><i><Icon name="antenna" size={21}/></i><span className={'business-badge '+(r.offline?'':'good')}>{r.device.unavailable?'통신 정보 확인 불가':r.reading.label}</span></header>
        <h3>{r.name}</h3><p>{r.asset?(r.asset.license_plate||r.asset.name||'차량 정보 미등록')+(r.primary?' · 대표':' · 보조'):'연결된 차량 없음'}</p>
        <dl><div><dt>마지막 통신</dt><dd>{r.device.last_seen_at?ageString(r.device.last_seen_at):'—'}</dd></div><div><dt>배터리</dt><dd>{battery.percent!=null?battery.percent+'%':'—'}</dd></div></dl>
        <footer>{r.asset&&<button type="button" className="business-button" onClick={()=>openDetail(r.asset.id)}>차량 상세</button>}{canManage&&(r.asset?<button type="button" className="business-button" onClick={()=>openDetail(r.asset.id,'connections')}>연결 관리</button>:assets.length>0&&<button type="button" className="business-button" onClick={()=>chooseVehicle(r)}>차량 연결</button>)}{canManage&&r.asset&&<button type="button" className="fleet-dashboard-link" onClick={()=>openDetail(r.asset.id,'history')}>연결 이력</button>}</footer>
      </article>;
    })}</div>:<div className="fleet-care-grid">{schedules.map(({asset,key,label,date})=><article className="fleet-care-card" key={asset.id+'-'+key}>
      <button type="button" className="fleet-care-card-open" aria-label={fleetAssetLabel(asset)+' '+label+' 일정 상세'} onClick={()=>setDetail({assetId:asset.id,key})}/>
      <header><time dateTime={date||undefined}><Icon name="calendar" size={15}/>{date||'일정 미등록'}</time>{date&&<span className={'business-badge '+(date<today?'urgent':'info')}>{date<today?'기한 경과':'예정'}</span>}</header>
      <div className="fleet-care-vehicle"><CarImage vehicleId={asset.id} version={asset.profile?.car_image_url} fallback={<Icon name="car" size={24}/>}/>
        <div><strong>{fleetAssetLabel(asset)}</strong>{(asset.car_model||asset.department)&&<small>{[asset.car_model,asset.department].filter(Boolean).join(' · ')}</small>}</div></div>
      <h3>{label}</h3>
      <footer><button type="button" className="business-button" onClick={()=>canManage?editSchedule(asset,key):openDetail(asset.id)}>{canManage?(date?'일정 수정':'일정 등록'):'차량 상세'}</button>
        {date&&canManage&&<button type="button" className="business-button is-primary" onClick={()=>setCompletion({schedule:{asset,key,label,date}})}>완료 처리</button>}</footer>
    </article>)}</div>}
    {!(terminals?visibleTerminals:schedules).length&&<div className="business-empty"><strong>{terminals?'표시할 단말기가 없습니다.':'해당하는 일정이 없습니다.'}</strong></div>}
    </>}
    {(schedule||completed)&&<CareDetail asset={inspectedAsset} label={careLabel} schedule={schedule} completed={completed} today={today}
      onClose={()=>setDetail(null)} onEdit={canManage&&schedule ? ()=>editSchedule(schedule.asset,schedule.key) : undefined}
      onComplete={canManage&&schedule?.date ? ()=>setCompletion({schedule}) : undefined}/>}
    {completion&&<CompletionEditor assets={assets} initialVehicle={vehicle} schedule={completion.schedule} today={today} onClose={()=>setCompletion(null)} onSaved={savedCompletion} onConflict={refreshAssets}/>}
    {picker&&<Modal open title={picker==='schedule'?'일정을 등록할 차량':picker==='history'?'연결 이력을 확인할 차량':'단말기를 연결할 차량'} onClose={()=>setPicker(null)} footer={<div className="fleet-assets-filter-footer"><button type="button" className="business-button" onClick={()=>setPicker(null)}>취소</button><button type="button" className="business-button is-primary" disabled={!chosen} onClick={confirm}>다음</button></div>}>
      <label className="fleet-operations-vehicle-picker">차량<select value={chosen} onChange={e=>setChosen(e.target.value)}>{assets.map(a=><option key={a.id} value={a.id}>{fleetAssetLabel(a)}</option>)}</select></label>
    </Modal>}
  </div>;
}

function CareDetail({asset,label,schedule,completed,today,onClose,onEdit,onComplete}) {
  const date=completed?.completed_on || schedule?.date;
  const overdue=!completed && date && date<today;
  const state=completed?'완료':overdue?'기한 경과':date?'예정':'미등록';
  const facts=[['차량번호',asset?.license_plate],['차종',asset?.car_model],['정비·보험 종류',label],['예정일',completed?completed.scheduled_on:schedule.date]];
  if(completed) facts.push(['완료일',completed.completed_on]);
  return <BusinessDrawer title="정비·보험 일정 상세" subtitle={[asset&&fleetAssetLabel(asset),label].filter(Boolean).join(' · ')} onClose={onClose}>
    <div className="fleet-care-detail">
      <div className="fleet-care-body"><div className="fleet-care-summary"><time dateTime={date||undefined}>{date||'일정 미등록'}</time><span className={'business-badge '+(completed?'good':overdue?'urgent':'info')}>{state}</span></div>
        <div className="fleet-care-hero"><CarImage vehicleId={asset?.id} version={asset?.profile?.car_image_url} fallback={<img src={sedan} alt=""/>}/></div>
        <section><h3>일정 정보</h3><dl>{facts.map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value||'—'}</dd></div>)}</dl></section>
        {completed?.note&&<section><h3>메모</h3><p>{completed.note}</p></section>}
      </div>
      {onEdit&&<footer><button type="button" className="business-button" onClick={onEdit}>{schedule.date?'일정 수정':'일정 등록'}</button>
        {onComplete&&<button type="button" className="business-button is-primary" onClick={onComplete}>완료 처리</button>}</footer>}
    </div>
  </BusinessDrawer>;
}
