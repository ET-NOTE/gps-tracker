import { useMemo, useState } from 'react';
import Icon from '../Icon';
import BusinessMap from './BusinessMap';
import { BusinessButton, BusinessEmpty, useBusinessVehicle } from './BusinessWorkspace';
import { corporateVehicleName, locationState, terminalName } from '../../lib/corporateOverview';
import { kstDateTime } from '../../lib/businessExport';
import { useBusinessClock } from './useBusinessData';
import { useVehicleGroups } from './FleetVehicleGroups';
import CarImage from '../CarImage';
import { classifyDevice } from '../../colors';
import { useStaff } from '../../state';
import useCorporatePhone from '../../useCorporatePhone';
import { hideOutsideMockup } from '../../lib/mockupHidden';

const labels = {all:'전체 차량',current:'현재 수신',old:'마지막 수신',none:'위치 없음'};
// Desktop design: tabs follow the vehicle's operating state; reception moves to a filter.
const runLabels = {all:'전체 차량',running:'운행 중',idle:'대기',service:'점검 중'};
const receptionOptions = [['all','전체 수신 상태'],['current','현재 수신'],['old','마지막 수신'],['none','위치 없음'],['unlinked','단말 미연결']];

// 점검 중: the vehicle is taken out of service (사용 정지). 운행 중: its linked terminal is
// awake and reporting now. Everything else waits.
export function runState(device, now = Date.now()) {
  if (device.asset?.enabled === false || device.enabled === false) return 'service';
  if (!device.has_primary_terminal) return 'idle';
  const status = classifyDevice(device, undefined, now).id;
  return ['active', 'gps_loss', 'low_batt', 'critical_batt', 'overcharge'].includes(status) ? 'running' : 'idle';
}
function reception(device, now) {
  if (!device.has_primary_terminal) return '단말 미연결';
  return ['active', 'sleeping'].includes(classifyDevice(device, undefined, now).id) ? '정상 수신' : '수신 확인';
}

export default function FleetLive({devices, initialId, onRefresh}) {
  const now=useBusinessClock(), openVehicle=useBusinessVehicle();
  const mockup=!useCorporatePhone()&&hideOutsideMockup;
  const staff=useStaff().data||[];
  const [query,setQuery]=useState(''), [status,setStatus]=useState('all');
  const [department,setDepartment]=useState(''), [binding,setBinding]=useState('all');
  const [group,setGroup]=useState('');
  const groups=useVehicleGroups();
  const [refreshing,setRefreshing]=useState(false);
  const [id,setId]=useState(initialId);
  const departments=useMemo(()=>[...new Set(devices.map(d=>d.department).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ko')),[devices]);
  const rows=useMemo(()=>devices.filter(d=>{
    const name=[corporateVehicleName(d),d.car_model,d.car_plate,d.department,terminalName(d)].join(' ').toLowerCase();
    const terminalFilter=mockup
      ? binding==='all' || (binding==='unlinked' ? !d.has_primary_terminal : d.has_primary_terminal && locationState(d,now)===binding)
      : binding==='all' || d.has_primary_terminal===(binding==='linked');
    const statusFilter=mockup ? status==='all'||status===runState(d,now) : status==='all'||status===locationState(d,now);
    return name.includes(query.trim().toLowerCase()) && (!department || d.department===department)
      && (!group || (group==='unassigned' ? d.asset?.group_id==null : String(d.asset?.group_id)===group))
      && terminalFilter && statusFilter;
  }),[devices,now,query,status,department,group,binding,mockup]);
  const selected=rows.find(d=>String(d.id)===String(id)) || rows[0];
  const select=d=>setId(d.id);
  async function refresh(){
    setRefreshing(true);
    try { await onRefresh(); } finally {setRefreshing(false);}
  }
  const manager=d=>staff.find(s=>s.id===(d.asset?.manager_staff_id??d.manager_staff_id))?.name||'담당자 미지정';
  const lastSeen=rows.map(d=>Date.parse(d.last_seen_at)).filter(Number.isFinite).sort((a,b)=>b-a)[0];
  const tabs=mockup?runLabels:labels;
  return <div className="fleet-live fleet-member-live" data-mockup={mockup||undefined}>
    <div className="fleet-member-live-tools">
      <div className="fleet-live-statuses" role="group" aria-label={mockup?'차량 운행 상태':'위치 수신 상태'}>{Object.entries(tabs).map(([key,label])=><button type="button" key={key} aria-pressed={status===key} onClick={()=>setStatus(key)}>{label}</button>)}</div>
      <label className="fleet-member-search"><Icon name="search" size={16}/><input type="search" aria-label="관제 차량 검색" placeholder={mockup?'차량번호 검색':'차량번호·단말기 검색'} value={query} onChange={e=>setQuery(e.target.value)}/></label>
      <BusinessButton icon="refresh" disabled={refreshing} onClick={refresh}>{refreshing?'갱신 중…':'화면 갱신'}</BusinessButton>
    </div>
    <div className="fleet-live-filters fleet-record-filterbox">
      <div className="fleet-record-fields"><label>차량 소속 부서<select value={department} onChange={e=>setDepartment(e.target.value)}><option value="">전체 부서</option>{departments.map(name=><option key={name}>{name}</option>)}</select></label>
      <label>차량 그룹<select value={group} onChange={e=>setGroup(e.target.value)}><option value="">전체 그룹</option>{(groups.data||[]).map(g=><option key={g.id} value={g.id}>{g.name}</option>)}<option value="unassigned">그룹 미지정</option></select></label>
      {mockup
        ? <label>단말 수신 상태<select value={binding} onChange={e=>setBinding(e.target.value)}>{receptionOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        : <label>단말기 연결<select value={binding} onChange={e=>setBinding(e.target.value)}><option value="all">전체 상태</option><option value="linked">연결</option><option value="unlinked">미연결</option></select></label>}
      </div>
      <div className="fleet-record-filterfoot"><span aria-live="polite">전체 {devices.length}대 중 <b>{rows.length}대</b> 조회</span>
        {mockup
          ? <button type="button" className="fleet-filter-reset-link" onClick={()=>{setStatus('all');setQuery('');setDepartment('');setGroup('');setBinding('all');}}><Icon name="refresh" size={13}/>필터 초기화</button>
          : <BusinessButton onClick={()=>{setStatus('all');setQuery('');setDepartment('');setGroup('');setBinding('all');}}>필터 초기화</BusinessButton>}
      </div>
      {groups.error&&<button type="button" className="business-link" onClick={()=>groups.refetch()}>차량 그룹 다시 불러오기</button>}
    </div>
    <section className="fleet-live-map" aria-label="차량 위치 지도">
      <header className="fleet-live-panel-head"><div><h2>차량 위치 <small>{rows.length}대</small></h2><p className="fleet-live-map-hint">{mockup?'핀을 선택하면 차량 상세가 열립니다.':'차량을 선택하면 아래에서 상세를 열 수 있습니다.'}</p></div></header>
      <BusinessMap devices={rows} selectedId={selected?.id} onSelect={d=>{select(d);if(mockup)openVehicle(d);}} controls="full"/>
      {!mockup&&selected&&<div className="business-map-selection"><div><strong>{corporateVehicleName(selected)}</strong><p>{selected.last_fix_at ? '마지막 위치 '+kstDateTime(selected.last_fix_at) : '수신된 위치 없음'}</p></div><BusinessButton onClick={()=>openVehicle(selected)}>차량 상세</BusinessButton></div>}
    </section>
    <section className="fleet-live-list" aria-label="관제 차량">
      <header className="fleet-live-panel-head"><h2>차량 상태</h2><span>{rows.length}대</span></header>
      <ul>{rows.map(d=>{
        const state=mockup?runState(d,now):locationState(d,now);
        const detail=mockup?[manager(d),reception(d,now)]:[d.department,d.has_primary_terminal ? terminalName(d) : '연결 단말기 없음'];
        return <li key={d.id}><button type="button" aria-pressed={d===selected} onClick={()=>select(d)}><span className="fleet-live-thumb" aria-hidden="true"><CarImage vehicleId={d.fleet_vehicle_id} deviceId={d.source_device_id||d.id} version={d.car_image_url} fallback={<Icon name="car" size={18}/>}/></span><strong>{corporateVehicleName(d)}</strong><small>{detail.filter(Boolean).join(' · ')}</small><span data-state={state}>{(mockup?runLabels:labels)[state]}</span></button></li>;
      })}</ul>
      {!rows.length&&<BusinessEmpty compact title="조회된 차량이 없습니다."/>}
      {mockup&&lastSeen&&<p className="fleet-live-last-seen">마지막 수신 {kstDateTime(new Date(lastSeen).toISOString()).slice(11)}</p>}
    </section>
  </div>;
}
