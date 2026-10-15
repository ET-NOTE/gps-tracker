import React, { createContext, useContext, useState } from 'react';
import Icon from '../Icon';
import { classifyDevice, ageString } from '../../colors';
import { vehicleName } from '../../lib/business';
import { validPosition } from '../../lib/businessWorkspace';
import { openPalette } from '../ui/CommandPalette';
import BusinessDrawer from './BusinessDrawer';
import BusinessMap from './BusinessMap';
import BusinessVehicleDetail from './BusinessVehicleDetail';
import './business.css';

const VehicleContext = createContext(null);
export const useBusinessVehicle = () => useContext(VehicleContext);
export function BusinessWorkspace({ title, description, tabs, tab, onTab, action, children, devices = [], kind, onMap, onVehicleAction, onManageVehicle, onNavigate, meta = {} }) {
  const active = tabs.find(item => item.id === tab) || tabs[0];
  const [selectedId, setSelectedId] = useState(null), [more, setMore] = useState(false);
  const selected = devices.find(d => String(d.id) === String(selectedId));
  const openVehicle = device => setSelectedId(device.id);
  const schedule = tabs.find(t => ['schedule', 'reservations'].includes(t.id));
  const choose = value => { setMore(false); onTab(value); };
  return <VehicleContext.Provider value={openVehicle}><section className={`gps-user-panel gps-business-panel business-workspace${onNavigate ? ' has-mobile-nav' : ''}`}>
    <header className="business-header no-print">
      <div><h1>{title}</h1><p>{description}</p></div>
      <div className="business-header-action"><button className="business-button business-global-search" onClick={openPalette}><Icon name="search" size={16} />차량·메뉴 검색 <kbd>Ctrl K</kbd></button>{action}</div>
    </header>
    <div className="business-layout">
      <nav className="business-nav no-print" aria-label={`${title} 메뉴`}>
        {tabs.map(item => <button className="business-nav-item" key={item.id} type="button" aria-current={tab === item.id ? 'page' : undefined} onClick={() => onTab(item.id)}>
          <Icon name={item.icon} size={18} /><span>{item.label}</span>{tab === item.id && <span className="business-nav-dot" />}
        </button>)}
      </nav>
      <div className="business-content" key={tab}>
        <div className="business-page-heading no-print"><h2>{active.label}</h2><p>{active.description}</p></div>
        {children}
      </div>
    </div>
    {onNavigate && <nav className="business-mobile-nav no-print" aria-label={`${title} 빠른 메뉴`}>
      <button className="business-mobile-item" aria-current={tab === tabs[0].id ? 'page' : undefined} onClick={() => choose(tabs[0].id)}><Icon name="home" size={21} />현황</button>
      <button className="business-mobile-item" aria-current={tab === schedule?.id ? 'page' : undefined} onClick={() => choose(schedule.id)}><Icon name="clock" size={21} />{kind === 'rentcar' ? '배차표' : '예약'}</button>
      <div className="business-mobile-create">{action}</div>
      <button className="business-mobile-item" onClick={() => onNavigate('home')}><Icon name="mapPin" size={21} />지도</button>
      <button className="business-mobile-item" aria-expanded={more} onClick={() => setMore(true)}><Icon name="more" size={21} />더보기</button>
    </nav>}
    {more && <BusinessDrawer title={`${title} 메뉴`} onClose={() => setMore(false)}><div className="business-more-menu">{tabs.map(item => <button className="business-button" key={item.id} aria-current={tab === item.id ? 'page' : undefined} onClick={() => choose(item.id)}><Icon name={item.icon} size={18} />{item.label}</button>)}<hr /><button className="business-button" onClick={() => { setMore(false); onNavigate('devices'); }}>단말기 관리</button><button className="business-button" onClick={() => { setMore(false); onNavigate('profile'); }}>내정보·계정 유형</button></div></BusinessDrawer>}
    {selected && <BusinessVehicleDetail key={selected.id} device={selected} meta={meta[selected.id]} kind={kind} onClose={() => setSelectedId(null)} onMap={onMap} onAction={onVehicleAction} onManage={onManageVehicle} />}
  </section></VehicleContext.Provider>;
}
export function BusinessLocation({ devices }) {
  const openVehicle = useContext(VehicleContext);
  const located = devices.filter(validPosition).length;
  return <BusinessSection title="차량 위치" description={`위치 수신 ${located} / ${devices.length}대 · 마커를 눌러 상세 확인`}>
    <BusinessMap devices={devices} onSelect={openVehicle} />
    <p className="business-map-note">마지막 수신 위치 · 최근 통신과 위치 수신 시각은 차량 상세에서 확인하세요.</p>
  </BusinessSection>;
}
export function BusinessButton({ children, icon, primary = false, ...props }) {
  return <button type="button" className={`business-button${primary ? ' is-primary' : ''}`} {...props}>{icon && <Icon name={icon} size={16} />}{children}</button>;
}
export function BusinessError({ children = '정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.', onRetry }) {
  return <div className="business-error" role="alert"><Icon name="warn" size={18} /><span>{children}</span>{onRetry && <BusinessButton onClick={onRetry} icon="refresh">다시 시도</BusinessButton>}</div>;
}
export function BusinessEmpty({ title = '표시할 항목이 없습니다.', children, compact = false }) {
  return <div className={`business-empty${compact ? ' is-compact' : ''}`}><Icon name="check" size={24} /><strong>{title}</strong>{children && <p>{children}</p>}</div>;
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
export function BusinessVehicles({ devices = [], onMap, onDetail, detailLabel = '차량 관리', availability, statusUnknown = false }) {
  const [query, setQuery] = useState('');
  const openVehicle = useContext(VehicleContext);
  const rows = devices.filter(d => [vehicleName(d), d.car_model, d.display_name, d.department].some(v => String(v || '').toLowerCase().includes(query.trim().toLowerCase())));
  return <BusinessSection title="차량 목록" description="차량의 운영 상태와 최근 통신을 함께 확인하세요." action={<label className="business-search"><Icon name="filter" size={16} /><input aria-label="차량 검색" placeholder="차량번호 · 이름 · 부서 검색" value={query} onChange={e => setQuery(e.target.value)} /></label>}>
    <div className="business-fleet-head"><span>차량</span><span>운영 상태</span><span>단말기 통신</span><span>작업</span></div>
    {rows.length ? rows.map(device => {
      const status = classifyDevice(device);
      const available = availability?.(device);
      return <div className="business-vehicle" key={device.id}>
        <div className="business-vehicle-name"><span className="business-vehicle-icon">{device.car_image_url ? <img src={device.car_image_url} alt="" /> : <Icon name="list" size={22} />}</span><div>{openVehicle ? <button type="button" className="business-vehicle-link" onClick={() => openVehicle(device)} aria-label={`${vehicleName(device)} 차량 상세`}>{vehicleName(device)} <Icon name="chevron-right" size={14} /></button> : <strong>{vehicleName(device)}</strong>}<p>{[device.car_model || device.display_name, device.department].filter(Boolean).join(' · ') || '차량 정보 미등록'}</p></div></div>
        <div><span className={`business-badge ${device.enabled === false || statusUnknown ? '' : available?.tone || 'good'}`}>{device.enabled === false ? '사용 중지' : statusUnknown ? '확인 필요' : available?.label || '사용 가능'}</span></div>
        <div className="business-connection"><span style={{ color: status.color }}>{status.label}</span><small>{device.last_seen_at ? `최근 통신 ${ageString(device.last_seen_at)}` : '수신 이력 없음'}</small></div>
        <div className="business-row-actions">{onMap && <BusinessButton icon="mapPin" onClick={() => onMap(device.id)}>지도</BusinessButton>}{onDetail && <BusinessButton onClick={() => onDetail(device)}>{detailLabel}</BusinessButton>}</div>
      </div>;
    }) : <BusinessEmpty title={devices.length ? '검색 결과가 없습니다.' : '등록된 차량이 없습니다.'}>{devices.length ? '다른 차량번호나 이름으로 검색해 주세요.' : '단말기 메뉴에서 차량을 먼저 등록해 주세요.'}</BusinessEmpty>}
  </BusinessSection>;
}
