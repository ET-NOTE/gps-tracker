import { useState } from 'react';
import BusinessMap from './BusinessMap';
import FreightTelemetry from './FreightTelemetry';
import { validPosition } from '../../lib/businessWorkspace';
import { terminalName } from '../../lib/corporateOverview';
import { terminalState } from './FreightDevices';
import { firstOrder, nameOf, routeName, shipStates, timeLabel, vehicleName } from '../../lib/freightWorkflow';
import { FreightBadge, FreightButton, FreightField, FreightFilters, FreightOptions, FreightTable } from './FreightKit';

const initial = {branch:'',type:'',state:'',connection:'',query:''};

export default function FreightOverview({data,devices,onPage,onMap,onRefresh,refreshing}) {
  const [filter,setFilter] = useState(initial), [selected,setSelected] = useState('');
  const change=(key,value)=>setFilter(prev=>({...prev,[key]:value}));
  const byDevice = new Map(devices.map(device=>[String(device.id),device]));
  const linked = new Set(data.vehicles.filter(v=>v.deviceId).map(v=>String(v.deviceId)));
  const active=data.shipments.filter(s=>!['cancelled','delivered'].includes(s.status));
  const units = data.vehicles.map(v=>({id:'v-'+v.id,v,device:byDevice.get(String(v.deviceId))}));
  for(const device of devices) if(!linked.has(String(device.id))) units.push({id:'d-'+device.id,v:null,device});
  const list=units.map(({id,v,device})=>{
    const connection=device ? terminalState(device,data.policies) : v?.deviceId ? {state:'unknown',label:'단말 정보 확인 필요'} : {state:'unassigned',label:'단말 미연결'};
    const assigned=!!v && active.some(s=>s.vehicleId===v.id);
    const freshFix=validPosition(device||{}) && Date.now()-Date.parse(device.last_fix_at)<5*60000;
    const motion=freshFix && typeof device.last_stationary==='boolean' ? device.last_stationary ? 'idle':'driving' : 'unknown';
    return {id,v,device,connection,assigned,motion,label:v?.plate || terminalName(device)};
  }).filter(({v,device,connection,assigned,motion,label})=>{
    return (!filter.branch||v?.branchId===filter.branch) && (!filter.type||v?.type===filter.type)
      && (!filter.connection||(filter.connection==='issue'?['offline','unknown'].includes(connection.state):connection.state===filter.connection))
      && (!filter.state||(filter.state==='assigned'?assigned:filter.state==='hold'?v&&v.readiness!=='ready':motion===filter.state))
      && [label,device?.display_name,device?.device_uid,nameOf(data,'drivers',v?.driverId),nameOf(data,'carriers',v?.carrierId)].join(' ').toLowerCase().includes(filter.query.trim().toLowerCase());
  });
  const current=list.find(item=>item.id===selected)||list[0];
  const terminals=list.map(item=>item.device).filter(Boolean);
  const selectedVehicleIds = new Set(list.map(row=>row.v?.id).filter(Boolean));
  const runs=active.filter(s=>selectedVehicleIds.has(s.vehicleId)).sort((a,b)=>a.start.localeCompare(b.start));
  return <div className="fr-page">
    <div className="fr-toolbar"><span>{list.length}대 조회</span><div className="fr-actions">
      <FreightButton disabled={refreshing} onClick={onRefresh} icon="refresh">{refreshing?'조회 중…':'화면 새로고침'}</FreightButton>
      <FreightButton onClick={()=>onMap(current?.device?.id)}>전체 지도 보기</FreightButton></div></div>
    <FreightFilters query={filter.query} onQuery={q=>change('query',q)} placeholder="차량번호, 기사, 소속 검색">
      <FreightField label="운영 지점"><select value={filter.branch} onChange={e=>change('branch',e.target.value)}><FreightOptions rows={data.branches} blank="전체 지점"/></select></FreightField>
      <FreightField label="차량 형태"><select value={filter.type} onChange={e=>change('type',e.target.value)}><option value="">전체</option>{data.codes.vehicleTypes.map(t=><option key={t}>{t}</option>)}</select></FreightField>
      <FreightField label="차량 상태"><select value={filter.state} onChange={e=>change('state',e.target.value)}><option value="">전체</option><option value="assigned">배차 있음</option><option value="driving">이동 중</option><option value="idle">정차</option><option value="hold">정비·운영 제외</option></select></FreightField>
      <FreightField label="수신 상태"><select value={filter.connection} onChange={e=>change('connection',e.target.value)}><option value="">전체</option><option value="online">정상 수신</option><option value="issue">수신 확인</option><option value="unassigned">미연결</option></select></FreightField>
      <FreightButton onClick={()=>setFilter(initial)}>조건 초기화</FreightButton>
    </FreightFilters>
    <div className="fr-overview-grid fr-live-grid">
      <section className="fr-dashboard-card"><header><h2>차량 위치</h2><span>{terminals.filter(validPosition).length}대 표시</span></header>
        <div className="fr-live-map"><BusinessMap devices={terminals} selectedId={current?.device?.id} onSelect={d=>setSelected(list.find(row=>row.device?.id===d.id)?.id||'')}/></div>
        {current&&<div className="fr-live-detail"><div><strong>{current.label}</strong><small>{current.connection.label} · 마지막 수신 {timeLabel(current.device?.last_seen_at)}</small></div>
          {current.device&&validPosition(current.device)&&<FreightButton onClick={()=>onMap(current.device.id)}>지도에서 보기</FreightButton>}</div>}</section>
      <section className="fr-dashboard-card"><header><h2>조회 차량</h2><span>{list.length}대</span></header><div className="fr-unit-list">
        {list.map(item=><button type="button" className="fr-unit" key={item.id} aria-pressed={current?.id===item.id} onClick={()=>setSelected(item.id)}>
          <span>{item.label}<small>{item.v ? [item.v.model,nameOf(data,'drivers',item.v.driverId)].filter(Boolean).join(' · ') : '차량 연결 대기 단말'}</small></span>
          <FreightBadge tone={item.connection.state==='online'?'green':item.connection.state==='offline'?'amber':'neutral'}>{item.connection.label}</FreightBadge>
        </button>)}{!list.length&&<p className="fr-empty">조건에 해당하는 차량이 없습니다.</p>}
      </div></section>
    </div>
    <section className="fr-dashboard-card"><header><h2>진행 운송</h2><FreightButton onClick={()=>onPage('cargo-schedule')}>전체 일정 보기</FreightButton></header>
      <FreightTable columns={['운송번호','상·하차지','차량','기사','상차 예정','운송 상태']} rows={runs.map(s=>({id:s.id,cells:[s.number,routeName(data,firstOrder(data,s)),vehicleName(data,s.vehicleId),nameOf(data,'drivers',s.driverId),timeLabel(s.start),shipStates[s.status]]}))}/></section>
    <details className="fr-dashboard-card fr-telemetry"><summary>단말기 운행 통계</summary><FreightTelemetry devices={terminals}/></details>
  </div>;
}
