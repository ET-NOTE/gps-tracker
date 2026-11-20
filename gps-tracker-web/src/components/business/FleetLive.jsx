import { useMemo, useState } from 'react';
import Icon from '../Icon';
import BusinessMap from './BusinessMap';
import { BusinessButton, BusinessEmpty, useBusinessVehicle } from './BusinessWorkspace';
import { corporateVehicleName, locationState, terminalName } from '../../lib/corporateOverview';
import { kstDateTime } from '../../lib/businessExport';
import { useBusinessClock } from './useBusinessData';

const labels = {current:'현재 수신', old:'마지막 수신', none:'위치 없음'};

export default function FleetLive({devices, initialId}) {
  const now=useBusinessClock(), openVehicle=useBusinessVehicle();
  const [query,setQuery]=useState(''), [status,setStatus]=useState('all');
  const [id,setId]=useState(initialId);
  const rows=useMemo(()=>devices.filter(d=>{
    const name=[corporateVehicleName(d),d.license_plate,d.car_plate,d.department,terminalName(d)].join(' ').toLowerCase();
    return name.includes(query.trim().toLowerCase()) && (status==='all'||status===locationState(d,now));
  }),[devices,now,query,status]);
  const selected=rows.find(d=>String(d.id)===String(id));
  const select=d=>setId(d.id);
  return <div className="fleet-live">
    <section className="fleet-live-list" aria-label="관제 차량">
      <div className="fleet-live-tools"><label><Icon name="search" size={17}/><input aria-label="관제 차량 검색" placeholder="차량·단말기 검색" value={query} onChange={e=>setQuery(e.target.value)}/></label>
        <select aria-label="위치 수신 상태" value={status} onChange={e=>setStatus(e.target.value)}><option value="all">전체 수신 상태</option>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></div>
      <header><h2>관제 차량</h2><span>{rows.length}대</span></header>
      <ul>{rows.map(d=><li key={d.id}><button type="button" aria-pressed={d===selected} onClick={()=>select(d)}><strong>{corporateVehicleName(d)}</strong><small>{d.has_primary_terminal ? terminalName(d) : '연결 단말기 없음'}</small><span data-state={locationState(d,now)}>{labels[locationState(d,now)]}</span></button></li>)}</ul>
      {!rows.length&&<BusinessEmpty compact title="조회된 차량이 없습니다."/>}
    </section>
    <section className="fleet-live-map" aria-label="차량 위치 지도"><BusinessMap devices={rows} selectedId={selected?.id} onSelect={select}/>
      {selected&&<div className="business-map-selection"><div><strong>{corporateVehicleName(selected)}</strong><p>{selected.last_fix_at ? `마지막 수신 ${kstDateTime(selected.last_fix_at)}` : '수신된 위치 없음'}</p></div><BusinessButton onClick={()=>openVehicle(selected)}>차량 상세</BusinessButton></div>}
    </section>
  </div>;
}
