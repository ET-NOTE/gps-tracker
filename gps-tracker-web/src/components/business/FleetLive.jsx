import { useMemo, useState } from 'react';
import Icon from '../Icon';
import BusinessMap from './BusinessMap';
import { BusinessButton, BusinessEmpty, useBusinessVehicle } from './BusinessWorkspace';
import { corporateVehicleName, locationState, terminalName } from '../../lib/corporateOverview';
import { kstDateTime } from '../../lib/businessExport';
import { useBusinessClock } from './useBusinessData';
import { useVehicleGroups } from './FleetVehicleGroups';

const labels = {all:'전체 차량',current:'현재 수신',old:'마지막 수신',none:'위치 없음'};

export default function FleetLive({devices, initialId, onRefresh}) {
  const now=useBusinessClock(), openVehicle=useBusinessVehicle();
  const [query,setQuery]=useState(''), [status,setStatus]=useState('all');
  const [department,setDepartment]=useState(''), [binding,setBinding]=useState('all');
  const [group,setGroup]=useState('');
  const groups=useVehicleGroups();
  const [refreshing,setRefreshing]=useState(false);
  const [id,setId]=useState(initialId);
  const departments=useMemo(()=>[...new Set(devices.map(d=>d.department).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ko')),[devices]);
  const rows=useMemo(()=>devices.filter(d=>{
    const name=[corporateVehicleName(d),d.car_model,d.car_plate,d.department,terminalName(d)].join(' ').toLowerCase();
    return name.includes(query.trim().toLowerCase()) && (!department || d.department===department)
      && (!group || (group==='unassigned' ? d.asset?.group_id==null : String(d.asset?.group_id)===group))
      && (binding==='all' || d.has_primary_terminal===(binding==='linked'))
      && (status==='all'||status===locationState(d,now));
  }),[devices,now,query,status,department,group,binding]);
  const selected=rows.find(d=>String(d.id)===String(id)) || rows[0];
  const select=d=>setId(d.id);
  async function refresh(){
    setRefreshing(true);
    try { await onRefresh(); } finally {setRefreshing(false);}
  }
  return <div className="fleet-live fleet-member-live">
    <div className="fleet-member-live-tools">
      <div className="fleet-live-statuses" role="group" aria-label="위치 수신 상태">{Object.entries(labels).map(([key,label])=><button type="button" key={key} aria-pressed={status===key} onClick={()=>setStatus(key)}>{label}</button>)}</div>
      <label className="fleet-member-search"><Icon name="search" size={16}/><input type="search" aria-label="관제 차량 검색" placeholder="차량번호·단말기 검색" value={query} onChange={e=>setQuery(e.target.value)}/></label>
      <BusinessButton icon="refresh" disabled={refreshing} onClick={refresh}>{refreshing?'갱신 중…':'화면 갱신'}</BusinessButton>
    </div>
    <div className="fleet-live-filters fleet-record-filterbox">
      <div className="fleet-record-fields"><label>차량 소속 부서<select value={department} onChange={e=>setDepartment(e.target.value)}><option value="">전체 부서</option>{departments.map(name=><option key={name}>{name}</option>)}</select></label>
      <label>차량 그룹<select value={group} onChange={e=>setGroup(e.target.value)}><option value="">전체 그룹</option>{(groups.data||[]).map(g=><option key={g.id} value={g.id}>{g.name}</option>)}<option value="unassigned">그룹 미지정</option></select></label>
      <label>단말기 연결<select value={binding} onChange={e=>setBinding(e.target.value)}><option value="all">전체 상태</option><option value="linked">연결</option><option value="unlinked">미연결</option></select></label>
      </div>
      <div className="fleet-record-filterfoot"><span aria-live="polite">{rows.length} / {devices.length}대</span>
        <BusinessButton onClick={()=>{setStatus('all');setQuery('');setDepartment('');setGroup('');setBinding('all');}}>필터 초기화</BusinessButton>
      </div>
      {groups.error&&<button type="button" className="business-link" onClick={()=>groups.refetch()}>차량 그룹 다시 불러오기</button>}
    </div>
    <section className="fleet-live-map" aria-label="차량 위치 지도">
      <header className="fleet-live-panel-head"><h2>차량 위치 <small>{rows.length}대</small></h2></header>
      <BusinessMap devices={rows} selectedId={selected?.id} onSelect={select} controls="full"/>
      {selected&&<div className="business-map-selection"><div><strong>{corporateVehicleName(selected)}</strong><p>{selected.last_fix_at ? '마지막 위치 '+kstDateTime(selected.last_fix_at) : '수신된 위치 없음'}</p></div><BusinessButton onClick={()=>openVehicle(selected)}>차량 상세</BusinessButton></div>}
    </section>
    <section className="fleet-live-list" aria-label="관제 차량">
      <header className="fleet-live-panel-head"><h2>차량 상태</h2><span>{rows.length}대</span></header>
      <ul>{rows.map(d=><li key={d.id}><button type="button" aria-pressed={d===selected} onClick={()=>select(d)}><strong>{corporateVehicleName(d)}</strong><small>{d.has_primary_terminal ? terminalName(d) : '연결 단말기 없음'}</small><span data-state={locationState(d,now)}>{labels[locationState(d,now)]}</span></button></li>)}</ul>
      {!rows.length&&<BusinessEmpty compact title="조회된 차량이 없습니다."/>}
    </section>
  </div>;
}
