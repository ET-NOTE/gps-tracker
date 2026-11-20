import { useState } from 'react';
import Icon from '../Icon';
import { classifyDevice, ageString } from '../../colors';
import { deviceBattery } from '../../lib/battery';
import { terminalName } from '../../lib/corporateOverview';
import { useVisibleNow } from '../../hooks/useVisibleNow';
import { SERVICES, deviceBucket, deviceMatches } from './platformModel';

const FILTERS = [
  ['all', '전체'], ['normal', '정상·절전'], ['attention', '확인 필요'], ['offline', '오프라인'], ['unknown', '수신 전'],
];

export default function PortalDeviceList({ devices = [], meta = {}, selectedId, detailId, onSelect, onDetail, onPair,
  renderTools, scope, scopeLabel, error, loading, onRetry, children }) {
  const [term, setTerm] = useState('');
  const [filter, setFilter] = useState('all');
  const [service, setService] = useState('');
  const [expanded, setExpanded] = useState(null);
  const now = useVisibleNow(true, 60000);
  const rows = devices.map(device => ({ device, status: classifyDevice(device, meta[device.id], now) }));
  const serviceOptions = SERVICES.filter(s => devices.some(d => d.portalServices?.includes(s.key)));
  const showServices = scope === 'company' || (!scope && scopeLabel === '내 사업장');
  const selectedService = showServices && serviceOptions.some(s => s.key === service) ? service : '';
  const filtered = rows.filter(({ device, status }) =>
    deviceMatches(device, term) && (filter === 'all' || deviceBucket(status) === filter)
      && (!selectedService || device.portalServices?.includes(selectedService)));
  const activeDetail = detailId === undefined ? expanded : detailId;
  function showDetail(id) {
    setExpanded(activeDetail === id ? null : id);
    onDetail?.(id);
  }
  return <section className="pt-device-pane" aria-label="단말기 관리">
    <div className="pt-device-heading"><div><span className="pt-overline">{scopeLabel || '내 단말기'}</span><h1>단말기 <span>{devices.length}</span></h1></div>
      {onPair && <button className="pt-button pt-primary" type="button" onClick={onPair}><Icon name="plus" size={16}/>단말기 등록</button>}
    </div>
    {children}
    <div className="pt-device-filters">
      <label className="pt-search-field"><Icon name="search" size={17}/><input type="search" aria-label="단말기 검색" placeholder="단말기 이름 또는 등록 번호" value={term} onChange={e => setTerm(e.target.value)}/></label>
      <label className="pt-filter"><Icon name="filter" size={14}/><select aria-label="단말기 상태 필터" value={filter} onChange={e => setFilter(e.target.value)}>{FILTERS.map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      {showServices && serviceOptions.length > 0 && <label className="pt-filter"><select aria-label="업무 구분" value={selectedService} onChange={e => setService(e.target.value)}>
        <option value="">전체 업무</option>{serviceOptions.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select></label>}
    </div>
    {error ? <div className="pt-empty" role="alert">단말기를 불러오지 못했습니다. {onRetry && <button className="pt-text-button" type="button" onClick={onRetry}>다시 시도</button>}</div>
      : loading ? <p className="pt-empty" role="status">단말기를 불러오는 중입니다.</p>
      : !filtered.length ? <p className="pt-empty">{devices.length ? '조건에 맞는 단말기가 없습니다.' : '이 범위에 등록된 단말기가 없습니다.'}</p>
      : <ul className="pt-device-list">{filtered.map(({ device, status }) => {
        const selected = selectedId === device.id;
        const open = activeDetail === device.id;
        const name = terminalName(device);
        const battery = deviceBattery(device, meta[device.id]);
        return <li key={device.id} className={'pt-device-card' + (selected ? ' is-selected' : '')}>
          <button type="button" className="pt-device-pick" onClick={() => onSelect?.(device.id)} aria-pressed={selected} aria-label={name + ' 지도에서 보기'}>
            <span className="pt-device-symbol"><Icon name="antenna" size={21}/></span>
            <span className="pt-device-identity"><strong>{name}</strong>
              {device.device_uid && device.device_uid !== name && <small>{device.device_uid}</small>}
            </span>
            <span className="pt-state" style={{color:status.color,background:status.background}}>{status.label}</span>
          </button>
          <div className="pt-device-meta"><span><Icon name="clock" size={14}/>{device.last_seen_at ? ageString(device.last_seen_at) : '수신 전'}</span>
            {battery.percent != null && <span><Icon name="battery" size={15}/>약 {battery.percent}%</span>}
            {showServices && device.portalServices?.length > 0 && <span>{SERVICES.filter(s => device.portalServices.includes(s.key)).map(s => s.label).join(' · ')}</span>}
            {(onDetail || renderTools) && <button type="button" className="pt-text-button" aria-label={name + ' 상세'} aria-expanded={renderTools ? open : undefined}
              onClick={() => showDetail(device.id)}>상세<Icon name={open ? 'chevron-up' : 'chevron-right'} size={13}/></button>}
          </div>
          {open && renderTools && <div className="pt-device-tools">{renderTools(device)}</div>}
        </li>;
      })}</ul>}
  </section>;
}
