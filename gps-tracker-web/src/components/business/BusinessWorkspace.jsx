import React, { useState } from 'react';
import Icon from '../Icon';
import { classifyDevice, ageString } from '../../colors';
import { businessDate, vehicleName } from '../../lib/business';
import './business.css';

export function BusinessWorkspace({ title, description, tabs, tab, onTab, action, children }) {
  const active = tabs.find(item => item.id === tab) || tabs[0];
  return <section className="gps-user-panel gps-business-panel business-workspace">
    <header className="business-header no-print">
      <div><span className="business-eyebrow">차량 운영 관리</span><h1>{title}</h1><p>{description}</p></div>
      <div className="business-header-action"><span>{businessDate().replaceAll('-', '. ')} · 한국 시간</span>{action}</div>
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
  </section>;
}
export function BusinessButton({ children, icon, primary = false, ...props }) {
  return <button type="button" className={`business-button${primary ? ' is-primary' : ''}`} {...props}>{icon && <Icon name={icon} size={16} />}{children}</button>;
}
export function BusinessError({ children = '정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.', onRetry }) {
  return <div className="business-error" role="alert"><Icon name="warn" size={18} /><span>{children}</span>{onRetry && <BusinessButton onClick={onRetry} icon="refresh">다시 시도</BusinessButton>}</div>;
}
export function BusinessEmpty({ title = '표시할 항목이 없습니다.', children }) {
  return <div className="business-empty"><Icon name="check" size={24} /><strong>{title}</strong>{children && <p>{children}</p>}</div>;
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
  const rows = devices.filter(d => [vehicleName(d), d.car_model, d.display_name, d.department].some(v => String(v || '').toLowerCase().includes(query.trim().toLowerCase())));
  return <BusinessSection title="차량 목록" description="차량의 운영 상태와 최근 통신을 함께 확인하세요." action={<label className="business-search"><Icon name="filter" size={16} /><input aria-label="차량 검색" placeholder="차량번호 · 이름 · 부서 검색" value={query} onChange={e => setQuery(e.target.value)} /></label>}>
    <div className="business-fleet-head"><span>차량</span><span>운영 상태</span><span>단말기 통신</span><span>작업</span></div>
    {rows.length ? rows.map(device => {
      const status = classifyDevice(device);
      const available = availability?.(device);
      return <div className="business-vehicle" key={device.id}>
        <div className="business-vehicle-name"><span className="business-vehicle-icon">{device.car_image_url ? <img src={device.car_image_url} alt="" /> : <Icon name="list" size={22} />}</span><div><strong>{vehicleName(device)}</strong><p>{[device.car_model || device.display_name, device.department].filter(Boolean).join(' · ') || '차량 정보 미등록'}</p></div></div>
        <div><span className={`business-badge ${device.enabled === false || statusUnknown ? '' : available?.tone || 'good'}`}>{device.enabled === false ? '사용 중지' : statusUnknown ? '확인 필요' : available?.label || '사용 가능'}</span></div>
        <div className="business-connection"><span style={{ color: status.color }}>{status.label}</span><small>{device.last_seen_at ? `최근 통신 ${ageString(device.last_seen_at)}` : '수신 이력 없음'}</small></div>
        <div className="business-row-actions">{onMap && <BusinessButton icon="mapPin" onClick={() => onMap(device.id)}>지도</BusinessButton>}{onDetail && <BusinessButton onClick={() => onDetail(device)}>{detailLabel}</BusinessButton>}</div>
      </div>;
    }) : <BusinessEmpty title={devices.length ? '검색 결과가 없습니다.' : '등록된 차량이 없습니다.'}>{devices.length ? '다른 차량번호나 이름으로 검색해 주세요.' : '단말기 메뉴에서 차량을 먼저 등록해 주세요.'}</BusinessEmpty>}
  </BusinessSection>;
}
