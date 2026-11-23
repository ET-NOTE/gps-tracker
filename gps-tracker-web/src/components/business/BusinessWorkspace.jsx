import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import Icon from '../Icon';
import CarImage from '../CarImage';
import { classifyDevice, ageString } from '../../colors';
import { vehicleName } from '../../lib/business';
import { corporateVehicleName, terminalName, locationState, locationSummary } from '../../lib/corporateOverview';
import { corporatePageHint } from '../../lib/corporateNavigation';
import { kstDateTime } from '../../lib/businessExport';
import { useBusinessClock } from './useBusinessData';
import { openPalette } from '../ui/CommandPalette';
import BusinessDrawer from './BusinessDrawer';
import BusinessMap from './BusinessMap';
import BusinessVehicleDetail from './BusinessVehicleDetail';
import useCorporatePhone from '../../useCorporatePhone';
import CorporateMobileHeader from './CorporateMobileHeader';
import {WorkspaceAvatar,WorkspaceBreadcrumb,WorkspaceHeaderActions,WorkspaceScope,WorkspaceWidthControl} from './WorkspaceHeader';
import FleetQuickPanel from './FleetQuickPanel';
import './business.css';

const VehicleContext = createContext(null);
const SelectionContext = createContext(null);
export const useBusinessVehicle = () => useContext(VehicleContext);
export function RentalVehicleScope({devices, meta, onMap, onVehicleAction, onManageVehicle, children}) {
  const [focusedId, setFocusedId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const selected = devices.find(d => String(d.id) === String(selectedId));
  function openVehicle(device) {
    setFocusedId(device.id);
    setSelectedId(device.id);
  }
  return <SelectionContext.Provider value={{ focusedId, focusVehicle: d => setFocusedId(d.id), kind: 'rentcar' }}>
    <VehicleContext.Provider value={openVehicle}>{children}
      {selected && <BusinessVehicleDetail key={selected.id} device={selected} meta={meta?.[selected.id]} kind="rentcar"
        onClose={() => setSelectedId(null)} onMap={onMap} onAction={onVehicleAction} onManage={onManageVehicle}/>}
    </VehicleContext.Provider>
  </SelectionContext.Provider>;
}
export function BusinessWorkspace({ initialVehicleId = null, renderVehicleDetail, title, description, tabs, groups, tab, section, sections, onSection, companyLabel, onTab, action, mobileAction, toolbar, globalNavigation, children, devices = [], vehicleStatus='ready', kind, onMap, onVehicleAction, onManageVehicle, onNavigate, onVehiclesChange, meta = {} }) {
  const workspaceRef = useRef(null);
  const phone = useCorporatePhone('navigation');
  // Mobile scrolls the persistent workspace; desktop's keyed content remounts
  // below. Reset only on navigation so vehicle-map focus keeps its own scroll.
  useEffect(() => { if (kind === 'corporate') workspaceRef.current?.scrollTo({ top: 0 }); }, [kind, tab, section]);
  const active = tabs.find(item => item.id === tab) || tabs[0];
  const navigation = groups || tabs;
  const activeGroup = active.group || active.id;
  const subnavGroup = active.subnavGroup || activeGroup;
  const subTabs = groups ? tabs.filter(item => (item.subnavGroup || item.group) === subnavGroup) : [];
  const subnavLabel = navigation.find(item => item.id === subnavGroup)?.label;
  const [lastInGroup, setLastInGroup] = useState({});
  const [expanded, setExpanded] = useState(activeGroup);
  useEffect(() => { setExpanded(activeGroup); }, [activeGroup]);
  const [wide,setWide] = useState(() => {
    try { return localStorage.getItem('fleet.workArea.width') === 'wide'; } catch { return false; }
  });
  function chooseWidth(value) {
    setWide(value);
    try { localStorage.setItem('fleet.workArea.width', value ? 'wide' : 'normal'); } catch { /* storage may be unavailable */ }
  }
  useEffect(() => { setLastInGroup(previous => previous[activeGroup] === tab ? previous : { ...previous, [activeGroup]: tab }); }, [activeGroup, tab]);
  const [selectedId, setSelectedId] = useState(initialVehicleId), [more, setMore] = useState(false);
  const [accountMenu, setAccountMenu] = useState(false);
  const [focusedId, setFocusedId] = useState(initialVehicleId);
  useEffect(() => { if (devices.length && !devices.some(d => String(d.id) === String(focusedId))) setFocusedId(null); }, [devices, focusedId]);
  const selected = devices.find(d => String(d.id) === String(selectedId));
  const openVehicle = device => { setFocusedId(device.id); setSelectedId(device.id); };
  const schedule = tabs.find(t => ['schedule', 'reservations'].includes(t.id));
  const choose = value => { setMore(false); onTab(value); };
  const corporate = kind === 'corporate';
  const [quick,setQuick]=useState(null);
  useEffect(()=>{
    if (!corporate || typeof window==='undefined') return;
    const shortcut=e=>{
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase()!=='k') return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (quick==='search') setQuick(null);
      else if (!document.querySelector('[role="dialog"][aria-modal="true"]')) setQuick('search');
    };
    window.addEventListener('keydown',shortcut,true);
    return ()=>window.removeEventListener('keydown',shortcut,true);
  },[corporate,quick]);
  const accountNavigation = (globalNavigation || [{ id: 'home', label: '지도', icon: 'mapPin' }, { id: 'devices', label: '단말기 관리', icon: 'list' }, { id: 'profile', label: '내정보', icon: 'user' }])
    .map(item => corporate && item.id === 'home' ? { ...item, label: '실시간 지도', icon: 'mapPin' } : item);
  const mapNavigation = corporate && accountNavigation.find(item => item.id === 'home');
  function visit(page,child) {
    if (child && onSection) {onTab(page); onSection(page,child);}
    else onTab(page,child);
  }
  // Pages and sections without their own sidebar link highlight the link they open from.
  const navParent = {sites:{page:'staff',id:'organization'},audit:{page:'staff',id:'permissions'},subscription:{page:'settings',id:'company'}};
  const currentLink = active.nav===false ? navParent[active.id] : sections?.[active.id]?.find(([id])=>id===section)?.[2]?.hidden ? navParent[section] : {page:tab,id:section};
  const navCurrent = link => currentLink && link.page===currentLink.page && (!link.id || link.id===currentLink.id);
  const groupLabel = navigation.find(item=>item.id===activeGroup)?.label || active.label;
  const pageLabel = sections?.[active.id]?.find(([id])=>section===id)?.[1] || active.label;
  const company = companyLabel || '내 회사';
  const day = useBusinessClock();
  const calendarLabel = new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul',year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(day);
  const subNavigation = subTabs.length > 1 && <nav className="business-subnav no-print" aria-label={`${subnavLabel} 하위 메뉴`}>{subTabs.map(item => <button className="business-subnav-item" key={item.id} type="button" aria-current={tab === item.id ? 'page' : undefined} onClick={() => onTab(item.id)}>{item.label}</button>)}</nav>;
  return <SelectionContext.Provider value={{ focusedId, focusVehicle: d => setFocusedId(d.id), kind }}><VehicleContext.Provider value={openVehicle}><section ref={workspaceRef} data-view-width={corporate ? (wide ? 'wide' : 'normal') : undefined} className={`gps-user-panel gps-business-panel business-workspace${kind === 'corporate' ? ' business-workspace--corporate' : ''}${onNavigate ? ' has-mobile-nav' : ''}`}>
    {!corporate && <header className="business-header no-print">
      <div><h1>{title}</h1>{description && <p>{description}</p>}</div>
      <div className="business-header-action"><button className="business-button business-global-search" onClick={openPalette}><Icon name="search" size={16} />차량·메뉴 검색 <kbd>Ctrl K</kbd></button>{action}</div>
    </header>}
    <div className={`business-layout${subTabs.length > 1 ? ' has-subnav' : ''}`}>
      <nav className="business-nav no-print" aria-label={`${title} 메뉴`}>
        {corporate && <div className="fleet-member-brand"><button type="button" className="fleet-brand-home" aria-label="시리얼링크 운영 현황" onClick={()=>onTab('overview')}><span className="fleet-brand-symbol"><Icon name="car" size={19}/></span>법인운행</button><small>{company} · 업무 공간</small></div>}
        {corporate ? navigation.map(item=>{
          const pages=tabs.filter(t=>(t.group || t.id)===item.id&&t.nav!==false);
          const links=pages.flatMap(p=>sections?.[p.id]?.length ? sections[p.id].filter(entry=>!entry[2]?.hidden).map(([id,label])=>({page:p.id,id,label})) : [{page:p.id,label:p.label}]);
          if (!links.length) return null;
          const nested=links.length>1, open=expanded===item.id, current=activeGroup===item.id;
          return <div className="fleet-nav-group" key={item.id}><button type="button" className="business-nav-item" aria-current={current?'page':undefined} aria-expanded={nested?open:undefined} onClick={()=>{
            if (nested && current) {setExpanded(open?null:item.id);return;}
            onTab(lastInGroup[item.id] && pages.some(p=>p.id===lastInGroup[item.id]) ? lastInGroup[item.id] : pages[0].id);
            setExpanded(item.id);
          }}><Icon name={item.icon} size={18}/><span>{item.label}</span>{nested&&<Icon name={open?'chevron-down':'chevron-right'} size={14}/>}</button>
            {nested&&open&&<nav className="fleet-nav-children" aria-label={`${item.label} 하위 메뉴`}>{links.map(link=><button key={link.page+(link.id||'')} type="button" aria-current={navCurrent(link)?'page':undefined} onClick={()=>visit(link.page,link.id)}>{link.label}</button>)}</nav>}
          </div>;
        }) : navigation.map(item => <button className="business-nav-item" key={item.id} type="button" aria-current={(groups ? activeGroup : tab) === item.id ? 'page' : undefined} onClick={() => onTab(groups ? lastInGroup[item.id] || tabs.find(t => t.group === item.id).id : item.id)}>
          <Icon name={item.icon} size={18} /><span>{item.label}</span>
        </button>)}
        {!corporate && onNavigate && mapNavigation && <button className="business-nav-item business-map-shortcut" type="button" title="내 계정 단말기의 전체 지도" onClick={() => onNavigate('home')}><Icon name="mapPin" size={18} /><span>실시간 지도</span></button>}
        {corporate && <div className="business-nav-tools">{action}{onNavigate && <button className="fleet-nav-service-link" type="button" onClick={() => onNavigate('profile')}><Icon name="settings" size={14} />이용 서비스 설정</button>}<small className="fleet-nav-copyright">시리얼링크 © {new Date(day).getFullYear()}</small></div>}
      </nav>
      {corporate && phone ? <CorporateMobileHeader active={active} groups={groups} tabs={tabs} section={section} sections={sections} company={company}
        onTab={visit} toolbar={toolbar} onNavigate={onNavigate} destinations={accountNavigation} onQuick={setQuick} wide={wide} onWidth={chooseWidth}/>
      : corporate ? <header className="business-topbar ws-member-top no-print">
        <div className="fleet-topbar-inner"><WorkspaceBreadcrumb service="법인운행" group={groupLabel} page={pageLabel}/>
        <WorkspaceHeaderActions scope={<WorkspaceScope fallback={toolbar}/>}
          widthControl={<WorkspaceWidthControl className="fleet-width" wide={wide} onChange={chooseWidth}/>}
          search={<button className="ws-wide-search" type="button" onClick={()=>setQuick('search')} aria-label="차량·메뉴 검색"><Icon name="search" size={17}/><span>차량·메뉴 검색</span></button>}
          alerts={<button className="ws-icon" type="button" onClick={()=>setQuick('alerts')} aria-label="운영 알림"><Icon name="bell" size={17}/></button>}/>
        {onNavigate&&<WorkspaceAvatar label="회사 및 계정 메뉴" expanded={accountMenu} onClick={()=>setAccountMenu(true)}/>}</div>
      </header> : subNavigation}
      <div className="business-content" key={tab}>
        {corporate && <header className="fleet-page-title fleet-member-heading no-print"><div><h1>{pageLabel}</h1><p>{corporatePageHint(tab,section)}</p></div><time>{calendarLabel}</time></header>}
        {!corporate && <div className="business-page-heading no-print"><h2>{active.label}</h2>{active.description && <p>{active.description}</p>}</div>}
        {children}
      </div>
    </div>
    {onNavigate && !(corporate && phone) && <nav className="app-bottom-nav business-mobile-nav no-print" aria-label={`${title} 빠른 메뉴`}>
      <button className="business-mobile-item" aria-current={tab === tabs[0].id ? 'page' : undefined} onClick={() => choose(tabs[0].id)}><Icon name="home" size={22} />현황</button>
      <button className="business-mobile-item" aria-current={(kind === 'corporate' ? activeGroup === 'vehicles' : tab === schedule?.id) ? 'page' : undefined} onClick={() => choose(kind === 'corporate' ? lastInGroup.vehicles || 'vehicles' : schedule.id)}><Icon name={kind === 'corporate' ? 'list' : 'clock'} size={22} />{kind === 'rentcar' ? '배차표' : '차량'}</button>
      {corporate && tabs.some(item => item.id === 'staff')
        ? <button type="button" className="business-mobile-item" aria-current={activeGroup === 'staff' ? 'page' : undefined} onClick={() => choose('staff')}><Icon name="user" size={22} />사용자</button>
        : <div className="business-mobile-create">{mobileAction || action}</div>}
      <button className="business-mobile-item" onClick={() => onNavigate('home')}><Icon name="mapPin" size={22} />지도</button>
      <button className="business-mobile-item" aria-expanded={more} onClick={() => setMore(true)}><Icon name="more" size={22} />더보기</button>
    </nav>}
    {more && <BusinessDrawer title={`${title} 메뉴`} onClose={() => setMore(false)}>
      <div className={`business-more-menu${corporate ? ' business-more-menu--corporate' : ''}`}>
        {groups ? groups.map(group => {
          const items = tabs.filter(item => item.group === group.id);
          const links = items.map(item => <button className="business-button" key={item.id} aria-current={tab === item.id ? 'page' : undefined} onClick={() => choose(item.id)}>
            {corporate && <Icon name={item.icon} size={18} />}{item.label}
          </button>);
          if (corporate && items.length === 1) return links[0];
          return <section className="business-menu-group" key={group.id}><h3>{group.label}</h3>{links}</section>;
        }) : tabs.map(item => <button className="business-button" key={item.id} aria-current={tab === item.id ? 'page' : undefined} onClick={() => choose(item.id)}><Icon name={item.icon} size={18} />{item.label}</button>)}
        <hr />
        {corporate ? accountNavigation.map(item => <button className="business-button" key={item.id} onClick={() => { setMore(false); onNavigate(item.id); }}><Icon name={item.icon} size={18} />{item.label}</button>) : <><button className="business-button" onClick={() => { setMore(false); onNavigate('devices'); }}>단말기 관리</button><button className="business-button" onClick={() => { setMore(false); onNavigate('profile'); }}>내정보·계정 유형</button></>}
      </div>
    </BusinessDrawer>}
    {accountMenu && onNavigate && <BusinessDrawer title="계정 메뉴" onClose={() => setAccountMenu(false)}><div className="business-more-menu">{toolbar}{accountNavigation.map(item => <button className="business-button" key={item.id} onClick={() => { setAccountMenu(false); onNavigate(item.id); }}><Icon name={item.icon} size={18} />{item.label}</button>)}</div></BusinessDrawer>}
    {quick&&<FleetQuickPanel mode={quick} tabs={tabs} groups={navigation} sections={sections} devices={devices} vehicleStatus={vehicleStatus} onVehicle={openVehicle} onClose={()=>setQuick(null)} onVisit={visit}/>}
    {selected && (renderVehicleDetail ? renderVehicleDetail(selected,()=>setSelectedId(null)) : <BusinessVehicleDetail key={selected.id} device={selected} meta={meta[selected.id]} kind={kind} onClose={() => setSelectedId(null)} onMap={onMap} onAction={onVehicleAction} onManage={onManageVehicle} onUpdated={onVehiclesChange} />)}
  </section></VehicleContext.Provider></SelectionContext.Provider>;
}
export function BusinessLocation({ devices, onLive }) {
  const openVehicle = useContext(VehicleContext);
  const selection = useContext(SelectionContext), now = useBusinessClock();
  const counts = locationSummary(devices, now);
  const corporate = selection?.kind === 'corporate';
  const selected = devices.find(d => String(d.id) === String(selection?.focusedId));
  let selectedLocation = '지도에 표시할 위치가 없습니다.';
  if (selected && locationState(selected, now) !== 'none') {
    selectedLocation = selected.last_fix_at ? `마지막 위치 ${kstDateTime(selected.last_fix_at)}` : '마지막 위치 수신 시각 없음';
  }
  const positions = `현재 수신 ${counts.current} · 오래된 위치 ${counts.old} · 위치 없음 ${counts.none}`;
  return <BusinessSection title="차량 위치" className={corporate ? 'fleet-location-panel' : undefined} description={corporate ? `위치 표시 ${counts.current + counts.old}대 · 전체 ${devices.length}대` : positions}
    action={onLive && <button className="fleet-dashboard-link" type="button" aria-label="실시간 관제" onClick={onLive}>{corporate ? '더보기' : '실시간 관제'} <Icon name="chevron-right" size={14}/></button>}>
    <BusinessMap devices={devices} onSelect={selection?.focusVehicle || openVehicle} selectedId={selection?.focusedId} controls={corporate?'compact':undefined} />
    {corporate ? <div className="fleet-location-counts" aria-label="차량 위치 수신 현황">
      <span>현재 수신 <b>{counts.current}</b></span><span>오래된 위치 <b>{counts.old}</b></span><span>위치 없음 <b>{counts.none}</b></span>
    </div> : <p className="business-map-note">현재 수신: 최근 5분 내 위치 · 지도는 마지막 수신 위치를 표시합니다.</p>}
    {selected && <div className="business-map-selection"><div><strong>{corporateVehicleName(selected)}</strong><p>{terminalName(selected)} · {selectedLocation}</p></div><BusinessButton onClick={() => openVehicle?.(selected)}>차량 상세</BusinessButton></div>}
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
export function BusinessSection({ title, description, action, children, className }) {
  return <section className={className ? 'business-section ' + className : 'business-section'}><div className="business-section-title"><div><h3>{title}</h3>{description && <p>{description}</p>}</div>{action}</div>{children}</section>;
}
export function BusinessMetrics({ items }) {
  return <div className="business-metrics">{items.map(item => <div className={`business-metric ${item.tone || ''}`} key={item.label} title={item.detail}>
    <div><span>{item.label}</span><Icon name={item.icon || 'bar'} size={18} /></div>
    <strong className={item.value == null && item.emptyLabel ? 'business-metric-status' : undefined}>{item.value ?? item.emptyLabel ?? '—'}{item.value != null && <small>{item.unit}</small>}</strong>
    {item.hint && <p>{item.hint}</p>}
  </div>)}</div>;
}
export function BusinessTask({ title, description, label, tone = '', action, onClick, icon }) {
  if (icon && onClick) return <button type="button" className={'fleet-member-task '+tone} aria-label={action+' · '+title} onClick={onClick}>
    <i><Icon name={icon} size={16}/></i><span><strong>{title}</strong><small>{description}</small></span>
    {label&&<span className={'business-badge '+tone}>{label}</span>}<Icon name="chevron-right" size={13}/>
  </button>;
  return <div className="business-task"><span className={`business-task-mark ${tone}`} /><div className="business-task-copy"><strong>{title}</strong><p>{description}</p></div>{label && <span className={`business-badge ${tone}`}>{label}</span>}{onClick && <BusinessButton onClick={onClick}>{action || '확인'}</BusinessButton>}</div>;
}
export function BusinessSettings({ company, subscription, activeTab, onTab, hideNavigation=false }) {
  const [internalTab, setInternalTab] = useState(company ? 'company' : 'subscription');
  const selected=activeTab??internalTab;
  const setSelected=value=>{setInternalTab(value);onTab?.(value);};
  return <div className="business-settings">{!hideNavigation&&<div className="business-switch no-print">{company && <button className="business-switch-item" aria-pressed={selected === 'company'} onClick={() => setSelected('company')}>회사 정보</button>}<button className="business-switch-item" aria-pressed={selected === 'subscription'} onClick={() => setSelected('subscription')}>이용권 관리</button></div>}{selected === 'company' ? company : subscription}</div>;
}
export function BusinessVehicles({ devices = [], onMap, onDetail, detailLabel = '차량 관리', availability, statusUnknown = false, separateTerminal = false, localMap = false }) {
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [sort, setSort] = useState('name');
  const openVehicle = useContext(VehicleContext), selection = useContext(SelectionContext), now = useBusinessClock();
  const nameFor = separateTerminal ? corporateVehicleName : vehicleName;
  const rows = devices.filter(d => (filter === 'all' || (filter === 'enabled' ? d.enabled !== false : d.enabled === false)) && [nameFor(d), d.car_plate, d.license_plate, terminalName(d), d.department].some(v => String(v || '').toLowerCase().includes(query.trim().toLowerCase())))
    .sort((a,b) => sort === 'seen' ? (Date.parse(b.last_seen_at) || 0) - (Date.parse(a.last_seen_at) || 0) : nameFor(a).localeCompare(nameFor(b),'ko',{numeric:true}));
  const focusOnMap = device => {
    selection?.focusVehicle(device);
    if (localMap) document.querySelector('.business-map-wrap')?.scrollIntoView({block:'center',behavior:'smooth'});
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
        <div className="business-connection">
          <span style={{ color: status.color }}>{device.terminal_status_label || status.label}</span>
          {!device.terminal_status_label && <small>{device.last_seen_at ? `최근 통신 ${ageString(device.last_seen_at)}` : '수신 이력 없음'}</small>}
          {separateTerminal && <small>{locationState(device, now) === 'none' ? '위치 없음' : `${locationState(device,now) === 'current' ? '현재 수신' : '오래된 위치'} · ${device.last_fix_at ? kstDateTime(device.last_fix_at) : '시각 없음'}`}</small>}
        </div>
        <div className="business-row-actions">{onMap && <BusinessButton icon="mapPin" onClick={() => focusOnMap(device)}>{localMap ? '위치' : '지도'}</BusinessButton>}{onDetail && <BusinessButton icon={detailLabel === '운행 리포트' ? 'bar' : 'wrench'} onClick={() => onDetail(device)}>{detailLabel}</BusinessButton>}</div>
      </div>;
    }) : <BusinessEmpty title={devices.length ? '검색 결과가 없습니다.' : '등록된 차량이 없습니다.'}>{devices.length ? '검색어나 상태 필터를 변경해 주세요.' : separateTerminal ? '차량 관리에서 차량을 먼저 등록한 뒤 단말기를 연결해 주세요.' : '연결된 단말기의 차량 정보를 등록해 주세요.'}</BusinessEmpty>}
    </div>
  </BusinessSection>;
}
