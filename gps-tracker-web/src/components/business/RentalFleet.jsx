import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { classifyDevice } from '../../colors';
import { deviceBattery } from '../../lib/battery';
import { businessDate, businessPeriod, rentalSummary } from '../../lib/business';
import { addBusinessDays } from '../../lib/businessWorkspace';
import { kstDateTime } from '../../lib/businessExport';
import { terminalName } from '../../lib/corporateOverview';
import { rentalFleetLabel, sameId, vehicleReadiness } from '../../lib/rentalFleet';
import CarImage from '../CarImage';
import sedan from '../entry/login-vehicle.png';
import Icon from '../Icon';
import { SkeletonList } from '../ui';
import BusinessMap from './BusinessMap';
import { BusinessButton, BusinessEmpty, BusinessError, useBusinessVehicle } from './BusinessWorkspace';
import { useBusinessClock, useRentalOperations } from './useBusinessData';
import RentalDashboard from './RentalDashboard';
import RentalVehicleRecord from './RentalVehicleRecord';
import RentalRecordDrawer from './RentalRecordDrawer';
import RentalFleetWork, { fleetWorkKey } from './RentalFleetWork';
import RentalAssetEditor, { RentalDeviceLink, useRentalAssets } from './RentalAssets';
import ExportButtons from './ExportButtons';
import './rental-fleet.css';
import useCorporatePhone from '../../useCorporatePhone';
import { hideOutsideMockup } from '../../lib/mockupHidden';

const receptionLabel = code => ({received:'정상 수신',stale:'수신 확인',unknown:'수신 확인',unlinked:'미연결'})[code] || '수신 확인';

function terminalSignal(device, now) {
  const state = classifyDevice(device, undefined, now);
  const code = !device.last_seen_at ? 'unknown' : ['offline','lost','signal_loss'].includes(state.id) ? 'stale' : 'received';
  return { code, label: state.label };
}

function directoryRow(device, terminals, work, summary, now) {
  const hasTerminal = terminals || device.device_id != null;
  const terminal = terminals ? device : device.terminal;
  return {
    device, label:rentalFleetLabel(device), terminal:terminal ? terminalName(terminal) : hasTerminal ? '단말기 정보 없음' : '단말기 미연결',
    state:vehicleReadiness(device,work,summary,now), branch:device.rental_profile?.branch || '',
    className:device.rental_profile?.class_name || device.car_model || '',
    signal:hasTerminal ? terminalSignal(device,now) : {code:'unlinked',label:'단말기 미연결'},
  };
}

export function ContractVehicleRecord({ vehicle, contract, vehicles, trackers, now, branches, onClose, onWork, onContracts }) {
  const work = useQuery({queryKey:fleetWorkKey(),queryFn:api.rentalFleetWork,staleTime:15000});
  const rentals = useRentalOperations(now);
  const failed = [work,rentals].filter(q=>q.isError);
  if (failed.length || work.isLoading || rentals.isLoading) return <RentalRecordDrawer title="렌트카 차량 상세" subtitle={rentalFleetLabel(vehicle)} onClose={onClose}>
    {failed.length ? <BusinessError onRetry={() => failed.forEach(q=>q.refetch())}>차량 운영 정보를 불러오지 못했습니다.</BusinessError> : <SkeletonList count={3} itemHeight={54}/>}
  </RentalRecordDrawer>;
  const contracts = rentals.data.some(c=>sameId(c.id,contract.id)) ? rentals.data : [...rentals.data,contract];
  const row = directoryRow(vehicle,false,work.data,rentalSummary(contracts,vehicles,now),now);
  return <RentalVehicleRecord row={row} contracts={contracts} work={work.data} now={now} vehicles={vehicles} trackers={trackers} branches={branches}
    onClose={onClose} onWorkDetail={id=>onWork('service',id)} onWorkSaved={work.refetch} onContracts={onContracts}/>;
}

function Directory({ view, devices, vehicles, trackers, initialVehicleId, work, contracts, now, onMap, onTab, onNavigate, onDevicesChange, onContracts, branches, refresh }) {
  const [query, setQuery] = useState(''), [branch, setBranch] = useState(''), [vehicleClass, setClass] = useState('');
  const [filter, setFilter] = useState(''), [connection, setConnection] = useState(''), [chosen, setChosen] = useState(null);
  const [registering,setRegistering] = useState(false),[linking,setLinking]=useState(null);
  const [detailId,setDetailId] = useState(initialVehicleId ?? null);
  const openVehicle = useBusinessVehicle(), live = view === 'live', terminals = view === 'devices';
  // Desktop design for live monitoring: map first, one list with state badges, pins open the vehicle.
  const mockupDesk = !useCorporatePhone() && hideOutsideMockup, mockupLive = live && mockupDesk;
  const summary = rentalSummary(contracts, devices, now), needle = query.trim().toLowerCase();
  const allRows = devices.map(device => directoryRow(device,terminals,work,summary,now));
  const rows = allRows.filter(r => (!branch || r.branch === branch) && (!vehicleClass || r.className === vehicleClass)
    && (!filter || r.state.code === filter) && (!connection || r.signal.code === connection)
    && (!needle || [r.label, r.device.device_uid, r.terminal, r.className, r.device.car_model, r.device.car_plate].some(v => String(v || '').toLowerCase().includes(needle))));
  const branchOptions = [...new Set(allRows.map(r => r.branch).filter(Boolean))].sort(), classes = [...new Set(allRows.map(r => r.className).filter(Boolean))].sort();
  const selected = rows.find(r => sameId(r.device.id, chosen)) || rows[0];
  const detail = allRows.find(row => sameId(row.device.id,detailId));
  const report = { filename: '렌트카_차량목록_' + businessDate(now), columns: [['label','차량'],['className','차종 등급'],['branch','지점'],['state','준비 상태'],['terminal','연결 단말기'],['signal','단말 수신'],['km','누적 거리(km)'],['fuel','잔량(%)']].map(([key,label])=>({key,label})),
    rows: rows.map(r => ({ ...r, state:r.state.label, signal:r.signal.label, km:r.device.rental_profile?.odometer_km, fuel:r.device.rental_profile?.fuel_level })) };
  const title = live ? '관제 차량' : terminals ? '등록 단말기' : '차량 목록';
  const empty = devices.length ? '조건에 맞는 ' + (terminals ? '단말기가' : '차량이') + ' 없습니다.' : (view==='vehicles'?'등록된 렌트 차량이 없습니다.':'등록된 단말기가 없습니다.');
  return <div className="rfl-page">
    <div className="rfl-toolbar"><label className="rfl-search"><Icon name="search" size={17} /><input aria-label={title + ' 검색'} placeholder={terminals ? '단말기명, 차량번호 검색' : '차량번호, 모델 검색'} value={query} onChange={e => setQuery(e.target.value)} /></label>
      <div className="rfl-buttons">{live && <BusinessButton icon="refresh" onClick={refresh}>화면 갱신</BusinessButton>}{!live && !terminals && <ExportButtons csvOnly csvLabel="목록 다운로드" report={report} disabled={!rows.length}/>}
        {terminals && onNavigate && <BusinessButton icon="plus" primary onClick={() => onNavigate('devices')}>단말기 등록</BusinessButton>}{!live && !terminals && <BusinessButton icon="plus" primary onClick={()=>setRegistering(true)}>차량 등록</BusinessButton>}</div></div>
    <div className="rfl-filters">
      <label>{mockupDesk&&terminals?'차량 소속 지점':'소속 지점'}<select value={branch} onChange={e => setBranch(e.target.value)}><option value="">전체 지점</option>{branchOptions.map(v=><option key={v}>{v}</option>)}</select></label>
      {!terminals && <label>{mockupDesk?'차종':'차종 등급'}<select value={vehicleClass} onChange={e => setClass(e.target.value)}><option value="">전체 차종</option>{classes.map(v=><option key={v}>{v}</option>)}</select></label>}
      {!terminals && <label>{mockupLive?'대여·준비 상태':'차량 상태'}<select value={filter} onChange={e => setFilter(e.target.value)}><option value="">전체 상태</option>{[['ready','대여 가능'],['active','대여 중'],['service','세차·점검'],['hold','배차 보류']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>}
      {(terminals || live) && <label>{mockupLive?'단말 수신 상태':mockupDesk&&terminals?'연결·수신 상태':'단말 수신'}<select value={connection} onChange={e => setConnection(e.target.value)}><option value="">전체 수신 상태</option>{(mockupLive?[['received','정상 수신'],['stale','수신 확인'],['unlinked','미연결']]:[['received','수신'],['stale','지연·오프라인'],['unknown','수신 이력 없음'],...(!terminals?[['unlinked','단말기 미연결']]:[])]).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>}
      <div className="rfl-filter-summary"><span>전체 {allRows.length}대 중 {rows.length}대 조회</span><BusinessButton className="fleet-filter-reset-link" icon="refresh" onClick={() => {setBranch(''); setClass(''); setFilter(''); setConnection(''); setQuery('');}}>필터 초기화</BusinessButton></div>
    </div>
    {mockupLive ? <div className="rfl-live" data-mockup="true">
      <section className="rfl-card rfl-map"><header><div><h2>차량 위치</h2><p>대여 상태와 실제 이동 상태는 다를 수 있습니다.</p></div></header>
        <BusinessMap devices={rows.flatMap(row=>row.device.terminal?[row.device.terminal]:[])} selectedId={selected?.device.device_id} onSelect={d=>{const row=rows.find(r=>r.device.device_id===d.id);if(row){setChosen(row.device.id);setDetailId(row.device.id);}}}/></section>
      <section className="rfl-card"><header><h2>차량 {rows.length}대</h2></header>
        <div className="rfl-live-list">{rows.map(row=><button key={row.device.id} type="button" className="rfl-live-item" aria-pressed={selected === row} onClick={() => {setChosen(row.device.id);setDetailId(row.device.id);}}><span><strong>{row.label}</strong><small>{[row.device.car_model||row.className,receptionLabel(row.signal.code)].filter(Boolean).join(' · ')}</small></span><span className="rfl-badge" data-tone={row.state.code}>{row.state.label}</span></button>)}
          {!rows.length && <BusinessEmpty title={empty} compact />}</div></section></div>
    : live ? <div className="rfl-live"><section className="rfl-card"><header><h2>관제 차량</h2><span>{rows.length}대</span></header>
      <div className="rfl-live-list">{rows.map(row=><button key={row.device.id} type="button" className="rfl-live-item" aria-pressed={selected === row} onClick={() => setChosen(row.device.id)}><strong>{row.label}</strong><small>{row.terminal} · {row.signal.label}</small></button>)}
        {!rows.length && <BusinessEmpty title={empty} compact />}</div></section>
      <section className="rfl-card rfl-map"><BusinessMap devices={rows.flatMap(row=>row.device.terminal?[row.device.terminal]:[])} selectedId={selected?.device.device_id} onSelect={d=>setChosen(rows.find(r=>r.device.device_id===d.id)?.device.id)}/>
        {selected && <footer><div><strong>{selected.label}</strong><small>{selected.device.last_fix_at ? '마지막 위치 ' + kstDateTime(selected.device.last_fix_at) : '수신된 위치 없음'}</small></div>
          <div className="rfl-buttons"><BusinessButton onClick={() => setDetailId(selected.device.id)}>차량 상세</BusinessButton>{onMap && selected.device.device_id!=null && <BusinessButton icon="mapPin" onClick={() => onMap(selected.device.device_id)}>전체 지도</BusinessButton>}</div></footer>}</section></div>
      : <section className="rfl-card rfl-list-card" aria-label={title}>
        {!rows.length ? <BusinessEmpty title={empty} /> : terminals ? <div className="rfl-table-scroll" tabIndex={0} role="region" aria-label="등록 단말기 목록"><table className="rfl-table"><thead><tr>{(mockupDesk?["단말기","연결 차량","지점","상태","마지막 수신","배터리","연결 관리"]:["단말기","연결 차량","지점","마지막 통신","수신 상태","연결 관리"]).map(label=><th key={label}>{label}</th>)}</tr></thead>
          <tbody>{rows.map(row=><tr key={row.device.id}><td><button className="rfl-link" onClick={()=>openVehicle?.(row.device)}>{row.terminal}</button></td><td>{row.device.boundVehicle ? rentalFleetLabel(row.device.boundVehicle) : "미연결"}</td><td>{row.branch || "미지정"}</td>{mockupDesk?<><td><span className="rfl-badge" data-tone={row.signal.code==="received"?"ready":"service"}>{receptionLabel(row.signal.code)}</span></td><td>{row.device.last_seen_at?kstDateTime(row.device.last_seen_at):"수신 이력 없음"}</td><td>{deviceBattery(row.device).percent!=null?deviceBattery(row.device).percent+"%":"—"}</td></>:<><td>{row.device.last_seen_at?kstDateTime(row.device.last_seen_at):"수신 이력 없음"}</td><td><span className="rfl-badge" data-tone={row.signal.code==="received"?"ready":"service"}>{row.signal.label}</span></td></>}<td><BusinessButton onClick={()=>setLinking(row.device)}>차량 연결</BusinessButton></td></tr>)}</tbody></table></div> : <div className="rfl-table-scroll" tabIndex={0} role="region" aria-label="렌트카 차량 목록"><table className="rfl-table"><thead><tr><th>차량</th><th>지점</th><th>운영 상태</th><th>누적 거리</th><th>잔량</th><th>단말 수신</th></tr></thead>
          <tbody>{rows.map(row=><tr className="rfl-record-row" key={row.device.id} onClick={() => setDetailId(row.device.id)}><td data-label="차량"><button type="button" className="rfl-car" aria-label={row.label+" 상세"} onClick={e => {e.stopPropagation();setDetailId(row.device.id);}}>
            <span className="rfl-car-art"><CarImage deviceId={row.device.device_id} version={row.device.terminal?.car_image_url} fallback={<img src={sedan} alt=""/>}/></span>
            <span><strong>{row.label}</strong><small>{[...new Set([row.device.car_model,row.className].filter(Boolean))].join(' · ')}</small></span>
          </button></td><td data-label="지점">{row.branch || '미지정'}</td><td data-label="상태"><span className="rfl-badge" data-tone={row.state.code}>{row.state.label}</span></td>
          <td data-label="거리">{row.device.rental_profile?.odometer_km == null ? '—' : row.device.rental_profile.odometer_km.toLocaleString() + ' km'}</td>
          <td data-label="잔량">{row.device.rental_profile?.fuel_level == null ? '—' : row.device.rental_profile.fuel_level + '%'}</td>
          <td data-label="단말기">{row.signal.label}{row.device.device_id!=null && <small>{row.terminal}</small>}</td>
          </tr>)}</tbody></table></div>}
      </section>}
    {detail && <RentalVehicleRecord row={detail} contracts={contracts} work={work} now={now} vehicles={vehicles} trackers={trackers} branches={branches}
      onClose={() => setDetailId(null)} onWorkDetail={id => onTab('service',id)} onWorkSaved={refresh} onContracts={onContracts}/>}
    {registering && <RentalAssetEditor terminals={trackers} vehicles={vehicles} branches={branches} onClose={()=>setRegistering(false)}/>}
    {linking && <RentalDeviceLink terminal={linking} vehicles={vehicles} onClose={()=>setLinking(null)}/>}
  </div>;
}

export default function RentalFleet({ view = 'fleet', devices = [], vehicles = [], initialVehicleId, onMap, onNavigate, onDevicesChange, onTab, onContracts, initialWorkId, branches = [] }) {
  const now = useBusinessClock(), period = businessPeriod(now), from = addBusinessDays(businessDate(now), -6) + 'T00:00:00+09:00';
  const rentals = useRentalOperations(now, { from: Date.parse(from) < Date.parse(period.from) ? from : period.from });
  const work = useQuery({ queryKey:fleetWorkKey(), queryFn:api.rentalFleetWork, staleTime:15000 }), assets = useRentalAssets();
  const tracked=useMemo(()=>devices.map(d=>{
    const v=vehicles.find(v=>sameId(v.device_id,d.id));
    return {...d,boundVehicle:v,rental_profile:v,car_plate:v?.plate || d.car_plate,car_model:v?.model || d.car_model};
  }),[devices,vehicles]);
  const failed=[work,rentals,assets].filter(q=>q.isError);
  if (failed.length) return <BusinessError onRetry={()=>failed.forEach(q=>q.refetch())}>렌트카 운영 정보를 불러오지 못했습니다.</BusinessError>;
  if ([work,rentals,assets].some(q=>q.isLoading)) return <SkeletonList count={3} itemHeight={70}/>;
  const data={devices:vehicles,work:work.data || [],contracts:rentals.data || [],now};
  if (view === 'fleet') return <RentalDashboard {...data} branches={branches} onTab={onTab} onContracts={onContracts} onNew={() => onContracts({new:true})} onWork={onTab} />;
  if (view === 'service' || view === 'incidents') return <RentalFleetWork key={view} {...data} branches={branches} incident={view === 'incidents'} initialId={initialWorkId} onVehicles={()=>onTab('vehicles')}/>;
  return <Directory key={view} view={view} {...data} devices={view==='devices'?tracked:vehicles} vehicles={vehicles} trackers={devices} initialVehicleId={initialVehicleId} onMap={onMap} onTab={onTab} onContracts={onContracts} onNavigate={onNavigate} onDevicesChange={onDevicesChange} branches={branches} refresh={()=>Promise.all([work.refetch(),rentals.refetch(),assets.refetch(),onDevicesChange?.()])}/>;
}
