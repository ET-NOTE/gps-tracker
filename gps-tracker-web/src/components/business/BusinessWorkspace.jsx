import React, { createContext, useContext, useEffect, useState } from 'react';
import Icon from '../Icon';
import CarImage from '../CarImage';
import { classifyDevice, ageString } from '../../colors';
import { vehicleName } from '../../lib/business';
import { validPosition } from '../../lib/businessWorkspace';
import { corporateVehicleName, terminalName, locationState, locationSummary } from '../../lib/corporateOverview';
import { kstDateTime } from '../../lib/businessExport';
import { useBusinessClock } from './useBusinessData';
import { openPalette } from '../ui/CommandPalette';
import BusinessDrawer from './BusinessDrawer';
import BusinessMap from './BusinessMap';
import BusinessVehicleDetail from './BusinessVehicleDetail';
import './business.css';

const VehicleContext = createContext(null);
const SelectionContext = createContext(null);
export const useBusinessVehicle = () => useContext(VehicleContext);
export function BusinessWorkspace({ renderVehicleDetail, title, description, tabs, groups, tab, onTab, action, mobileAction, children, devices = [], kind, onMap, onVehicleAction, onManageVehicle, onNavigate, onVehiclesChange, meta = {} }) {
  const active = tabs.find(item => item.id === tab) || tabs[0];
  const navigation = groups || tabs;
  const activeGroup = active.group || active.id;
  const subTabs = groups ? tabs.filter(item => item.group === activeGroup) : [];
  const [lastInGroup, setLastInGroup] = useState({});
  useEffect(() => { setLastInGroup(previous => previous[activeGroup] === tab ? previous : { ...previous, [activeGroup]: tab }); }, [activeGroup, tab]);
  const [selectedId, setSelectedId] = useState(null), [more, setMore] = useState(false);
  const [focusedId, setFocusedId] = useState(null);
  useEffect(() => { if (!devices.some(d => String(d.id) === String(focusedId))) setFocusedId(null); }, [devices, focusedId]);
  const selected = devices.find(d => String(d.id) === String(selectedId));
  const openVehicle = device => { setFocusedId(device.id); setSelectedId(device.id); };
  const schedule = tabs.find(t => ['schedule', 'reservations'].includes(t.id));
  const choose = value => { setMore(false); onTab(value); };
  return <SelectionContext.Provider value={{ focusedId, focusVehicle: d => setFocusedId(d.id), kind }}><VehicleContext.Provider value={openVehicle}><section className={`gps-user-panel gps-business-panel business-workspace${onNavigate ? ' has-mobile-nav' : ''}`}>
    <header className="business-header no-print">
      <div><h1>{title}</h1>{description && <p>{description}</p>}</div>
      <div className="business-header-action"><button className="business-button business-global-search" onClick={openPalette}><Icon name="search" size={16} />차량·메뉴 검색 <kbd>Ctrl K</kbd></button>{action}</div>
    </header>
    <div className="business-layout">
      <nav className="business-nav no-print" aria-label={`${title} 메뉴`}>
        {navigation.map(item => <button className="business-nav-item" key={item.id} type="button" aria-current={(groups ? activeGroup : tab) === item.id ? 'page' : undefined} onClick={() => onTab(groups ? lastInGroup[item.id] || tabs.find(t => t.group === item.id).id : item.id)}>
          <Icon name={item.icon} size={18} /><span>{item.label}</span>
        </button>)}
      </nav>
      {subTabs.length > 1 && <nav className="business-subnav no-print" aria-label={`${navigation.find(g => g.id === activeGroup)?.label} 하위 메뉴`}>{subTabs.map(item => <button key={item.id} type="button" aria-current={tab === item.id ? 'page' : undefined} onClick={() => onTab(item.id)}>{item.label}</button>)}</nav>}
      <div className="business-content" key={tab}>
        <div className="business-page-heading no-print"><h2>{active.label}</h2>{active.description && <p>{active.description}</p>}</div>
        {children}
      </div>
    </div>
    {onNavigate && <nav className="app-bottom-nav business-mobile-nav no-print" aria-label={`${title} 빠른 메뉴`}>
      <button className="business-mobile-item" aria-current={tab === tabs[0].id ? 'page' : undefined} onClick={() => choose(tabs[0].id)}><Icon name="home" size={22} />현황</button>
      <button className="business-mobile-item" aria-current={(kind === 'corporate' ? activeGroup === 'vehicles' : tab === schedule?.id) ? 'page' : undefined} onClick={() => choose(kind === 'corporate' ? lastInGroup.vehicles || 'vehicles' : schedule.id)}><Icon name={kind === 'corporate' ? 'list' : 'clock'} size={22} />{kind === 'rentcar' ? '배차표' : '차량'}</button>
      <div className="business-mobile-create">{mobileAction || action}</div>
      <button className="business-mobile-item" onClick={() => onNavigate('home')}><Icon name="mapPin" size={22} />지도</button>
      <button className="business-mobile-item" aria-expanded={more} onClick={() => setMore(true)}><Icon name="more" size={22} />더보기</button>
    </nav>}
    {more && <BusinessDrawer title={`${title} 메뉴`} onClose={() => setMore(false)}><div className="business-more-menu">{groups ? groups.map(group => <section className="business-menu-group" key={group.id}><h3>{group.label}</h3>{tabs.filter(item => item.group === group.id).map(item => <button className="business-button" key={item.id} aria-current={tab === item.id ? 'page' : undefined} onClick={() => choose(item.id)}>{item.label}</button>)}</section>) : tabs.map(item => <button className="business-button" key={item.id} aria-current={tab === item.id ? 'page' : undefined} onClick={() => choose(item.id)}><Icon name={item.icon} size={18} />{item.label}</button>)}<hr /><button className="business-button" onClick={() => { setMore(false); onNavigate('devices'); }}>단말기 관리</button><button className="business-button" onClick={() => { setMore(false); onNavigate('profile'); }}>내정보·계정 유형</button></div></BusinessDrawer>}
    {selected && (renderVehicleDetail ? renderVehicleDetail(selected,()=>setSelectedId(null)) : <BusinessVehicleDetail key={selected.id} device={selected} meta={meta[selected.id]} kind={kind} onClose={() => setSelectedId(null)} onMap={onMap} onAction={onVehicleAction} onManage={onManageVehicle} onUpdated={onVehiclesChange} />)}
  </section></VehicleContext.Provider></SelectionContext.Provider>;
}
export function BusinessLocation({ devices }) {
  const openVehicle = useContext(VehicleContext);
  const selection = useContext(SelectionContext), now = useBusinessClock();
  const counts = locationSummary(devices, now);
  const selected = devices.find(d => String(d.id) === String(selection?.focusedId));
  return <BusinessSection title="차량 위치" description={`현재 수신 ${counts.current} · 오래된 위치 ${counts.old} · 위치 없음 ${counts.none}`}>
    <BusinessMap devices={devices} onSelect={selection?.focusVehicle || openVehicle} selectedId={selection?.focusedId} />
    <p className="business-map-note">현재 수신: 최근 5분 내 위치 · 지도는 마지막 수신 위치를 표시합니다.</p>
    {selected && <div className="business-map-selection"><div><strong>{corporateVehicleName(selected)}</strong><p>{terminalName(selected)} · 마지막 위치 {selected.last_fix_at ? kstDateTime(selected.last_fix_at) : '수신 시각 없음'}</p></div><BusinessButton onClick={() => openVehicle?.(selected)}>차량 상세</BusinessButton></div>}
  </BusinessSection>;
}
export function BusinessButton({ children, icon, primary = false, ...props }) {
  return <button type="button" className={`business-button${primary ? ' is-primary' : ''}`} {...props}>{icon && <Icon name={icon} size={16} />}{children}</button>;
}
export function BusinessError({ children = '정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.', onRetry }) {
  return <div className="business-error" role="alert"><Icon name="warn" size={18} /><span>{children}</span>{onRetry && <BusinessButton onClick={onRetry} icon="refresh">다시 시도</BusinessButton>}</div>;
}
export function BusinessEmpty({ title = '표시할 항목이 없습니다.', children, compact = false }) {
  return <div className={`business-empty${compact ? ' is-compact' : ''}`}><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}
export function BusinessSection({ title, description, action, children }) {
  return <section className="business-section"><div className="business-section-title"><div><h3>{title}</h3>{description && <p>{description}</p>}</div>{action}</div>{children}</section>;
}
export function BusinessMetrics({ items }) {
  return <div className="business-metrics">{items.map(item => <div className={`business-metric ${item.tone || ''}`} key={item.label}>
    <div><span>{item.label}</span><Icon name={item.icon || 'bar'} size={18} /></div><strong>{item.value ?? '—'}{item.value != null && <small>{item.unit}</small>}</strong><p>{item.hint}</p>
  </div>)}</div>;
}
export function BusinessTask({ title, description, label, tone = '', action, onClick }) {
  return <div className="business-task"><span className={`business-task-mark ${tone}`} /><div className="business-task-copy"><strong>{title}</strong><p>{description}</p></div>{label && <span className={`business-badge ${tone}`}>{label}</span>}{onClick && <BusinessButton onClick={onClick}>{action || '확인'}</BusinessButton>}</div>;
}
export function BusinessSettings({ company, subscription }) {
  const [selected, setSelected] = useState(company ? 'company' : 'subscription');
  return <div className="business-settings"><div className="business-switch no-print">{company && <button className="business-switch-item" aria-pressed={selected === 'company'} onClick={() => setSelected('company')}>회사 정보</button>}<button className="business-switch-item" aria-pressed={selected === 'subscription'} onClick={() => setSelected('subscription')}>이용권 관리</button></div>{selected === 'company' ? company : subscription}</div>;
}
export function BusinessVehicles({ devices = [], onMap, onDetail, detailLabel = '차량 관리', availability, statusUnknown = false, separateTerminal = false, localMap = false }) {
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [sort, setSort] = useState('name');
  const openVehicle = useContext(VehicleContext), selection = useContext(SelectionContext), now = useBusinessClock();
  const nameFor = separateTerminal ? corporateVehicleName : vehicleName;
  const rows = devices.filter(d => (filter === 'all' || (filter === 'enabled' ? d.enabled !== false : d.enabled === false)) && [nameFor(d), d.car_plate, d.license_plate, terminalName(d), d.department].some(v => String(v || '').toLowerCase().includes(query.trim().toLowerCase())))
    .sort((a,b) => sort === 'seen' ? (Date.parse(b.last_seen_at) || 0) - (Date.parse(a.last_seen_at) || 0) : nameFor(a).localeCompare(nameFor(b),'ko',{numeric:true}));
  const focusOnMap = device => {
    selection?.focusVehicle(device);
    if (localMap && validPosition(device)) document.querySelector('.business-map-wrap')?.scrollIntoView({block:'center',behavior:'smooth'});
    else onMap?.(device.id);
  };
  return <BusinessSection title="차량 목록" action={<label className="business-search"><Icon name="search" size={16} /><input aria-label="차량 검색" placeholder="차량 · 단말명 · 부서" value={query} onChange={e => setQuery(e.target.value)} /></label>}>
    {separateTerminal && <div className="business-list-filters"><label>상태 <select aria-label="차량 상태" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">전체</option><option value="enabled">사용 가능</option><option value="disabled">사용 정지</option></select></label><label>정렬 <select aria-label="차량 정렬" value={sort} onChange={e=>setSort(e.target.value)}><option value="name">차량 이름순</option><option value="seen">최근 통신순</option></select></label><span>{rows.length}대</span></div>}
    <div className={separateTerminal ? 'business-fleet-table has-terminal-column' : 'business-fleet-table'}>
    <div className="business-fleet-head"><span>차량</span>{separateTerminal && <span>단말명</span>}<span>운영 상태</span><span>단말기 통신</span><span>작업</span></div>
    {rows.length ? rows.map(device => {
      const status = classifyDevice(device, undefined, now);
      const available = availability?.(device);
      const name = nameFor(device);
      const detail = separateTerminal ? [device.car_plate || device.license_plate, device.department].filter(v=>v && v!==name).join(' · ') : [device.car_model || (device.display_name !== name ? device.display_name : null), device.department].filter(Boolean).join(' · ');
      const focused = String(selection?.focusedId) === String(device.id);
      return <div className={`business-vehicle${focused ? ' is-selected' : ''}`} key={device.id}>
        <div className="business-vehicle-identity">
          <div className="business-vehicle-name">{device.car_image_url && <span className="business-vehicle-icon"><CarImage vehicleId={device.fleet_vehicle_id} deviceId={device.source_device_id || device.id} version={device.car_image_url} /></span>}<div>{openVehicle ? <button type="button" className="business-vehicle-link" onClick={() => openVehicle(device)} aria-label={`${name} · ${terminalName(device)} 차량 상세`}><span className="business-vehicle-title" title={name}>{name}</span><Icon name="chevron-right" size={14} /></button> : <strong className="business-vehicle-title" title={name}>{name}</strong>}{detail && <p title={detail}>{detail}</p>}</div></div>
          {separateTerminal && <div className="business-terminal-name"><small>단말명</small><span title={terminalName(device)}>{terminalName(device)}</span></div>}
          <div className="business-vehicle-availability"><span className={`business-badge ${device.enabled === false || statusUnknown ? '' : available?.tone || 'good'}`}>{device.enabled === false ? '사용 정지' : statusUnknown ? '확인 필요' : available?.label || '사용 가능'}</span></div>
        </div>
        <div className="business-connection"><span style={{ color: status.color }}>{status.label}</span><small>{device.last_seen_at ? `최근 통신 ${ageString(device.last_seen_at)}` : '수신 이력 없음'}</small>{separateTerminal && <small>{locationState(device, now) === 'none' ? '위치 없음' : `${locationState(device,now) === 'current' ? '현재 수신' : '오래된 위치'} · ${device.last_fix_at ? kstDateTime(device.last_fix_at) : '시각 없음'}`}</small>}</div>
        <div className="business-row-actions">{onMap && <BusinessButton icon="mapPin" onClick={() => focusOnMap(device)}>{localMap ? '위치' : '지도'}</BusinessButton>}{onDetail && <BusinessButton icon={detailLabel === '운행 리포트' ? 'bar' : 'wrench'} onClick={() => onDetail(device)}>{detailLabel}</BusinessButton>}</div>
      </div>;
    }) : <BusinessEmpty title={devices.length ? '검색 결과가 없습니다.' : '등록된 차량이 없습니다.'}>{devices.length ? '검색어나 상태 필터를 변경해 주세요.' : '연결된 단말기의 차량 정보를 등록해 주세요.'}</BusinessEmpty>}
    </div>
  </BusinessSection>;
}
