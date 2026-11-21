import { useState } from 'react';
import Icon from '../Icon';
import { classifyDevice, isStale } from '../../colors';
import BatteryStatus from '../BatteryStatus';
import DeviceReadingTime from './DeviceReadingTime';
import { deviceBattery } from '../../lib/battery';
import { terminalName } from '../../lib/corporateOverview';
import { validPosition } from '../../lib/businessWorkspace';
import { useVisibleNow } from '../../hooks/useVisibleNow';
import { SERVICES, deviceBucket, deviceMatches } from './platformModel';

const FILTERS = [
  ['all', '전체 상태'], ['online', '통신 정상'], ['disconnected', '통신 끊김·대기'], ['pending', '위치 수신 대기'],
];
const DETAILED_FILTERS = [['normal', '정상·절전'], ['attention', '확인 필요'], ['offline', '오프라인'], ['unknown', '수신 전']];

function matchesDeviceStatus(filter, device, status) {
  if (filter === 'all') return true;
  if (filter === 'pending') return !validPosition(device);
  if (filter === 'online' || filter === 'disconnected') {
    const communicating = status.id !== 'unknown' && !isStale(device.last_seen_at);
    return filter === 'online' ? communicating : !communicating;
  }
  return deviceBucket(status) === filter;
}

export default function PortalDeviceList({ devices = [], meta = {}, selectedId, detailId, onSelect, onDetail, onPair,
  scope, scopeLabel, availableServices = [], error, loading, onRetry, children }) {
  const [term, setTerm] = useState('');
  const [filter, setFilter] = useState('all');
  const [service, setService] = useState('');
  const now = useVisibleNow(true, 60000);
  const rows = devices.map(device => ({ device, status: classifyDevice(device, meta[device.id], now) }));
  const serviceOptions = SERVICES.filter(s => availableServices.includes(s.key) || devices.some(d => d.portalServices?.includes(s.key)));
  const showServices = scope === 'company' || (!scope && scopeLabel === '내 사업장');
  const selectedService = showServices && serviceOptions.some(s => s.key === service) ? service : '';
  const filtered = rows.filter(({ device, status }) =>
    deviceMatches(device, term) && matchesDeviceStatus(filter, device, status)
      && (!selectedService || device.portalServices?.includes(selectedService)));
  return <section className="pt-device-pane" aria-label="단말기 관리">
    <div className="pt-device-heading"><div><h1>{showServices ? '회사 단말기' : '내 단말기'} <span>{devices.length}</span></h1><p>위치와 단말기 상태를 한곳에서 확인하세요.</p></div>
      {onPair && <button className="pt-button pt-primary" type="button" aria-label="단말기 등록" onClick={onPair}><Icon name="plus" size={14}/>등록</button>}
    </div>
    {children}
    <div className="pt-device-filters">
      <label className="pt-search-field"><Icon name="search" size={15}/><input type="search" aria-label="단말기 검색" placeholder="이름·번호·차량 검색" value={term} onChange={e => setTerm(e.target.value)}/></label>
      <label className="pt-filter"><select aria-label="단말기 상태 필터" value={filter} onChange={e => setFilter(e.target.value)}>
        {FILTERS.map(([key,label]) => <option key={key} value={key}>{label}</option>)}
        <optgroup label="세부 상태">{DETAILED_FILTERS.map(([key,label]) => <option key={key} value={key}>{label}</option>)}</optgroup>
      </select></label>
      {showServices && <label className="pt-filter"><select aria-label="업무 구분" value={selectedService} onChange={e => setService(e.target.value)}>
        <option value="">전체 서비스</option>{serviceOptions.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select></label>}
    </div>
    {!error && !loading && <div className="pt-device-result-count">단말기 {filtered.length}개</div>}
    {error ? <div className="pt-empty" role="alert">단말기를 불러오지 못했습니다. {onRetry && <button className="pt-text-button" type="button" onClick={onRetry}>다시 시도</button>}</div>
      : loading ? <p className="pt-empty" role="status">단말기를 불러오는 중입니다.</p>
      : !filtered.length ? <p className="pt-empty">{devices.length ? '조건에 맞는 단말기가 없습니다.' : '이 범위에 등록된 단말기가 없습니다.'}</p>
      : <ul className="pt-device-list">{filtered.map(({ device, status }) => {
        const selected = selectedId === device.id;
        const open = detailId === device.id;
        const name = terminalName(device);
        const vehicle = device.license_plate || device.car_plate;
        const subtitle = (vehicle && vehicle !== name) ? vehicle : device.device_uid;
        const battery = deviceBattery(device, meta[device.id]);
        return <li key={device.id} className={'pt-device-card' + (selected ? ' is-selected' : '')}>
          <div className="pt-device-pick">
            <span className="pt-device-identity">{onDetail
              ? <button className="pt-device-detail-link" type="button" aria-label={name + ' 상세 열기'} onClick={() => onDetail(device.id)}><strong>{name}</strong></button>
              : <strong>{name}</strong>}
              {subtitle && subtitle !== name && <small title={device.device_uid}>{subtitle}</small>}
            </span>
            <span className="pt-state" style={{color:status.color,background:status.background}}>{status.label}</span>
          </div>
          <BatteryStatus reading={battery} showRuntime={false} sourceCaption/>
          <dl className="pt-device-times"><div><dt>최근 통신</dt><dd><DeviceReadingTime split value={device.last_seen_at}/></dd></div><div><dt>최근 위치</dt><dd><DeviceReadingTime split value={device.last_fix_at}/></dd></div></dl>
          <div className="pt-device-buttons">
            <button type="button" className={'pt-button' + (selected ? ' pt-selected-button' : '')} onClick={() => onSelect?.(device.id)} aria-label={name + ' 지도에서 보기'}><Icon name="mapPin" size={14}/>지도 보기</button>
            {onDetail && <button type="button" className="pt-button" aria-label={name + ' 상세·설정'} aria-expanded={open} onClick={() => onDetail(device.id)}>상세·설정</button>}
          </div>
        </li>;
      })}</ul>}
    <p className="pt-device-note"><Icon name="info" size={13}/>통신 시각과 위치 수신 시각은 다를 수 있습니다.</p>
  </section>;
}
