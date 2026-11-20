import React,{useMemo,useState} from 'react';
import Icon from '../Icon';
import {Modal} from '../ui';
import {ageString,classifyDevice} from '../../colors';
import {businessDate} from '../../lib/business';
import {deviceBattery} from '../../lib/battery';
import {fleetAssetLabel} from '../../lib/fleetAssets';
import {maintenanceScheduleFields} from '../../lib/fleetAssetFilters';
import {useBusinessClock} from './useBusinessData';

export default function FleetOperations({mode,assets,devices,canManage,openDetail,editSchedule}){
  const now=useBusinessClock(),today=businessDate(now),terminals=mode==='devices';
  const [query,setQuery]=useState(''),[status,setStatus]=useState('all'),[vehicle,setVehicle]=useState('');
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
    &&(status==='all'||(status==='linked'&&r.asset)||(status==='unlinked'&&!r.asset)||(status==='check'&&r.offline)));
  const schedules=assets.flatMap(asset=>maintenanceScheduleFields.map(([key,label])=>({asset,key,label,date:asset.profile?.[key]||''})))
    .filter(r=>matchingAsset(r.asset)&&contains(r.asset.name,r.asset.license_plate,r.asset.car_model,r.asset.department,r.label)
      &&(status==='all'&&r.date||status==='overdue'&&r.date&&r.date<today||status==='missing'&&!r.date))
    .sort((a,b)=>a.date.localeCompare(b.date)||fleetAssetLabel(a.asset).localeCompare(fleetAssetLabel(b.asset),'ko',{numeric:true}));
  const options=terminals?[['all','전체'],['linked','연결'],['check','수신 확인'],['unlinked','미연결']]:[['all','등록 일정'],['overdue','기한 경과'],['missing','미등록']];
  function chooseVehicle(action){setPicker(action);setChosen(vehicle||String(assets[0]?.id||''));}
  function confirm(){
    const asset=assets.find(a=>String(a.id)===chosen);
    if(!asset)return;
    if(picker==='schedule')editSchedule(asset);
    else openDetail(asset.id,'connections',picker.device.id);
    setPicker(null);
  }
  return <div className="fleet-operations">
    <div className="fleet-operations-toolbar"><div className="fleet-operations-status" aria-label={terminals?'단말 상태':'일정 상태'}>{options.map(([id,label])=><button type="button" key={id} aria-pressed={status===id} onClick={()=>setStatus(id)}>{label}</button>)}</div>
    {!terminals&&canManage&&assets.length>0&&<button type="button" className="business-button is-primary" onClick={()=>chooseVehicle('schedule')}><Icon name="plus" size={16}/>일정 등록</button>}</div>
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
    })}</div>:<div className="fleet-operations-schedules">{schedules.map(({asset,key,label,date})=><article key={asset.id+'-'+key}>
      <i><Icon name="clock" size={20}/></i><div><strong>{label}</strong><small>{asset.license_plate||asset.name||'차량 정보 미등록'}{asset.department?' · '+asset.department:''}</small></div>
      <time dateTime={date||undefined}>{date||'일정 미등록'}</time>{date&&<span className={'business-badge '+(date<today?'urgent':'info')}>{date<today?'기한 경과':'예정'}</span>}
      <button type="button" className="business-button" onClick={()=>canManage?editSchedule(asset):openDetail(asset.id)}>{canManage?'일정 수정':'차량 상세'}</button>
    </article>)}</div>}
    {!(terminals?visibleTerminals:schedules).length&&<div className="business-empty"><strong>{terminals?'표시할 단말기가 없습니다.':'해당하는 일정이 없습니다.'}</strong></div>}
    {picker&&<Modal open title={picker==='schedule'?'일정을 등록할 차량':'단말기를 연결할 차량'} onClose={()=>setPicker(null)} footer={<div className="fleet-assets-filter-footer"><button type="button" className="business-button" onClick={()=>setPicker(null)}>취소</button><button type="button" className="business-button is-primary" disabled={!chosen} onClick={confirm}>다음</button></div>}>
      <label className="fleet-operations-vehicle-picker">차량<select value={chosen} onChange={e=>setChosen(e.target.value)}>{assets.map(a=><option key={a.id} value={a.id}>{fleetAssetLabel(a)}</option>)}</select></label>
    </Modal>}
  </div>;
}
