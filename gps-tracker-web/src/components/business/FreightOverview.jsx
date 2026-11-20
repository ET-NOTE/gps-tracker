import { useState } from 'react';
import BusinessMap from './BusinessMap';
import {freightTasks} from './FreightAlerts';
import {validPosition} from '../../lib/businessWorkspace';
import FreightTelemetry from './FreightTelemetry';
import {epoch,stamp,getRow,routeName,firstOrder,shipStates,timeLabel,vehicleName} from '../../lib/freightWorkflow';
import {FreightButton,FreightOptions,FreightField,FreightStats,FreightTable} from './FreightKit';

export default function FreightOverview({page,data,devices,onPage,onMap}){
  const [branch,setBranch]=useState(''),[selected,setSelected]=useState(null);
  const live=page==='cargo-live', now=Date.now(), today=stamp(now).slice(0,10);
  const scoped=rows=>rows.filter(x=>!branch||x.branchId===branch);
  const fleet=scoped(data.vehicles), orders=scoped(data.orders).filter(o=>o.status!=='cancelled');
  const ships=scoped(data.shipments).filter(s=>s.status!=='cancelled'), active=ships.filter(s=>s.status!=='delivered');
  const linked=new Set(fleet.map(v=>String(v.deviceId||''))), terminals=branch?devices.filter(d=>linked.has(String(d.id))):devices;
  const current=terminals.find(d=>d.id===selected), deviceName=d=>fleet.find(v=>String(v.deviceId)===String(d.id))?.plate||d.display_name||d.device_uid;
  const delays=terminals.filter(d=>!d.last_seen_at || now-Date.parse(d.last_seen_at)>data.policies.offlineMinutes*60000);
  const tasks=freightTasks(data,ships,fleet,terminals,now);
  const runs=(live?active:ships.filter(s=>s.start.slice(0,10)===today)).slice().sort((a,b)=>epoch(a.start)-epoch(b.start));
  return <div className="fr-page">
    <div className="fr-toolbar"><FreightField label="운영 지점"><select value={branch} onChange={e=>{setBranch(e.target.value);setSelected(null);}}><FreightOptions rows={data.branches} blank="전체 지점"/></select></FreightField>
      <div className="fr-actions">{live?<FreightButton onClick={()=>onMap(current?.id)}>전체 지도 보기</FreightButton>:<><FreightButton onClick={()=>onPage('cargo-orders')}>주문 목록</FreightButton><FreightButton primary onClick={()=>onPage('cargo-dispatch')}>통합 배차</FreightButton></>}</div></div>
    <FreightStats items={live?[['운영 차량',fleet.length+'대'],['연결 단말기',terminals.length+'대'],['수신 확인 필요',delays.length+'대'],['진행 운송',active.length+'건']]:
      [['오늘 상차 주문',orders.filter(o=>o.start.slice(0,10)===today).length+'건'],['미배차 주문',orders.filter(o=>o.status==='open').length+'건'],['운송 중',active.filter(s=>['loading','in_transit'].includes(s.status)).length+'건'],['오늘 하차 완료',ships.filter(s=>s.status==='delivered'&&s.events?.some(e=>e.type==='delivered'&&e.at.slice(0,10)===today)).length+'건']]}/>
    <div className="fr-split"><section className="fr-card"><div className="fr-toolbar"><h2>차량 위치</h2>{!live&&<FreightButton onClick={()=>onPage('cargo-live')}>실시간 관제</FreightButton>}</div>
      <BusinessMap devices={terminals} selectedId={selected} onSelect={d=>setSelected(d.id)}/>
      {current&&<div className="fr-toolbar"><strong>{deviceName(current)}</strong><FreightButton onClick={()=>onMap(current.id)}>지도에서 보기</FreightButton></div>}</section>
      {live?<section className="fr-card"><h2>단말기 마지막 수신</h2><FreightTable columns={['차량·단말기','마지막 수신','지도']} rows={terminals.map(d=>({id:d.id,cells:[deviceName(d),timeLabel(d.last_seen_at),<FreightButton disabled={!validPosition(d)} onClick={()=>onMap(d.id)}>위치 보기</FreightButton>]}))}/></section>:
      <section className="fr-card"><div className="fr-toolbar"><h2>확인할 업무</h2><FreightButton onClick={()=>onPage('cargo-integrations')}>알림 설정</FreightButton></div>
        {tasks.map(([,label,count,to,hint])=><button type="button" className="fr-pick" key={label} onClick={()=>onPage(to)}><span>{label}</span> <strong>{count}건</strong>{hint&&<small>{hint}</small>}</button>)}
        {!tasks.length&&<p className="fr-note">표시할 알림을 설정해 주세요.</p>}</section>}
    </div>
    <section className="fr-card"><div className="fr-toolbar"><h2>{live?'진행 운송':'오늘 배차 일정'}</h2><FreightButton onClick={()=>onPage('cargo-schedule')}>전체 일정 보기</FreightButton></div>
      <FreightTable columns={['운송번호','상·하차지','차량','기사','상차 예정','운송 상태']} rows={runs.map(s=>({id:s.id,cells:[s.number,routeName(data,firstOrder(data,s)),vehicleName(data,s.vehicleId),getRow(data,'drivers',s.driverId)?.name,timeLabel(s.start),shipStates[s.status]]}))}/></section>
    {live&&<FreightTelemetry devices={terminals}/>}
  </div>;
}
