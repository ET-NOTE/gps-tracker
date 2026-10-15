import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { useRentals, useRentalPhotos, qk } from '../../state';
import { businessDate, vehicleName } from '../../lib/business';
import { kstDateTime } from '../../lib/businessExport';
import { classifyDevice, ageString } from '../../colors';
import { deviceBattery } from '../../lib/battery';
import BatteryStatus from '../BatteryStatus';
import BusinessDrawer from './BusinessDrawer';
import BusinessMap from './BusinessMap';

export default function BusinessVehicleDetail({ device, meta, kind, onClose, onMap, onAction, onManage }) {
  const [tab, setTab] = useState('status');
  const status = classifyDevice(device, meta);
  return <BusinessDrawer title={vehicleName(device)} subtitle={[device.car_model, device.department].filter(Boolean).join(' · ') || '차량 상세'} onClose={onClose}>
    <div className="business-switch"><button className="business-switch-item" aria-pressed={tab === 'status'} onClick={() => setTab('status')}>상태·위치</button><button className="business-switch-item" aria-pressed={tab === 'history'} onClick={() => setTab('history')}>{kind === 'rentcar' ? '계약·사진 이력' : '최근 운행'}</button></div>
    {tab === 'status' ? <>
      <BusinessMap devices={[device]} />
      <dl className="business-detail-facts"><div><dt>단말기 상태</dt><dd style={{ color: status.color }}>{status.label}</dd></div><div><dt>최근 통신</dt><dd>{device.last_seen_at ? ageString(device.last_seen_at) : '수신 이력 없음'}</dd></div><div><dt>마지막 위치 수신</dt><dd>{device.last_fix_at ? kstDateTime(device.last_fix_at) : '수신 이력 없음'}</dd></div></dl>
      <BatteryStatus reading={deviceBattery(device, meta)} />
      <p className="business-note">지도는 마지막으로 수신한 위치입니다. 계약·예약 상태와 단말기 통신 상태는 별도로 확인해 주세요.</p>
      <dl className="business-detail-facts">{[['next_service_date', '다음 정비일'], ['insurance_expiry', '보험 만료일'], ['inspection_expiry', '검사 만료일']].map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{device[key] || '미등록'}</dd></div>)}</dl>
      {onManage && <button className="business-button" onClick={() => { onClose(); onManage(device.id); }}>차량 정보·점검 일정 수정</button>}
    </> : kind === 'rentcar' ? <VehicleRentalHistory device={device} /> : <VehicleTripHistory device={device} />}
    <div className="business-detail-actions"><button className="business-button" onClick={() => { onClose(); onMap?.(device.id); }}>전체 지도 보기</button><button className="business-button is-primary" onClick={() => { onClose(); onAction?.(device); }}>{kind === 'rentcar' ? '계약 관리·사진 추가' : '운행일지 작성'}</button></div>
  </BusinessDrawer>;
}

function VehicleTripHistory({ device }) {
  const from = businessDate(Date.now() - 6 * 86400000), to = businessDate();
  const result = useQuery({ queryKey: qk.trips(device.id, { from, to }), queryFn: () => api.listTrips(device.id, { from, to }), staleTime: 60000 });
  return <><p className="business-note">최근 7일 운행 · 최대 10건 표시</p>{result.isPending ? <p>운행기록을 불러오는 중…</p> : result.error ? <ReadError onRetry={result.refetch} /> : result.data?.length ? result.data.slice().sort((a, b) => new Date(b.started_at) - new Date(a.started_at)).slice(0, 10).map((trip, i) => <article className="business-history-item" key={trip.id || i}><strong>{kstDateTime(trip.started_at)}</strong><p>{trip.end_address || (trip.ended_at ? '종료된 운행' : '운행 중')} · {trip.distance_m == null ? '거리 미확인' : `${(trip.distance_m / 1000).toFixed(1)} km`}</p></article>) : <p className="business-note">이 기간에 운행기록이 없습니다.</p>}</>;
}

function VehicleRentalHistory({ device }) {
  const [contractId, setContractId] = useState('');
  const to = businessDate(), from = businessDate(Date.now() - 180 * 86400000);
  const result = useRentals({ device_id: device.id, from: `${from}T00:00:00+09:00`, to: `${to}T23:59:59+09:00` });
  const contracts = (result.data || []).filter(c => String(c.device_id) === String(device.id)).sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at));
  const selected = contracts.find(c => String(c.id) === contractId) || contracts[0];
  return <><p className="business-note">최근 180일 계약의 인수·반납 사진을 확인하세요. 사진 등록과 삭제는 계약 관리에서 할 수 있습니다.</p>
    {result.isLoading ? <p>계약을 불러오는 중…</p> : result.error ? <ReadError onRetry={result.refetch} /> : !contracts.length ? <p>이 기간에 계약이 없습니다.</p> : <>
      <label className="business-detail-field">계약 선택<select value={selected?.id || ''} onChange={e => setContractId(e.target.value)}>{contracts.map(c => <option key={c.id} value={c.id}>{businessDate(c.starts_at)} · {c.renter_name} · #{c.id}</option>)}</select></label>
      <p className="business-note">{kstDateTime(selected.starts_at)} ~ {kstDateTime(selected.ends_at)}</p>
      <ContractPhotos key={selected.id} contractId={selected.id} />
    </>}
  </>;
}
function ContractPhotos({ contractId }) {
  const result = useRentalPhotos(contractId);
  if (result.isLoading) return <p>사진 목록을 불러오는 중…</p>;
  if (result.error) return <ReadError onRetry={result.refetch} />;
  if (!result.data?.length) return <p className="business-note">이 계약에 등록된 사진이 없습니다.</p>;
  return <div className="business-photo-pair">{[['pickup_', '인수 시점'], ['return_', '반납 시점']].map(([prefix, label]) => <section key={prefix}><h3>{label}</h3>{result.data.filter(p => p.kind.startsWith(prefix)).map(photo => <AuthenticatedPhoto key={photo.id} photo={photo} />)}{!result.data.some(p => p.kind.startsWith(prefix)) && <p className="business-note">등록된 사진 없음</p>}</section>)}{result.data.filter(p => !/^(pickup_|return_)/.test(p.kind)).map(photo => <AuthenticatedPhoto key={photo.id} photo={photo} />)}</div>;
}
const photoKinds = { pickup_damage: '인수 외관', return_damage: '반납 외관', pickup_fuel: '인수 연료', return_fuel: '반납 연료', pickup_odometer: '인수 주행거리', return_odometer: '반납 주행거리' };
function AuthenticatedPhoto({ photo }) {
  const [url, setUrl] = useState(null), [error, setError] = useState(false), [retry, setRetry] = useState(0), [expanded, setExpanded] = useState(false);
  // Lazy mount network request when the photo approaches the drawer viewport.
  const [element, setElement] = useState(null), [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!element) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '100px' });
    observer.observe(element); return () => observer.disconnect();
  }, [element]);
  useEffect(() => {
    if (!visible) return;
    let disposed = false, objectUrl;
    setError(false);
    api.fetchRentalPhoto(photo.id).then(value => { if (disposed) URL.revokeObjectURL(value); else { objectUrl = value; setUrl(value); } }).catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [photo.id, visible, retry]);
  return <figure ref={setElement} className={`business-history-photo${expanded ? ' expanded' : ''}`}>
    {url ? <button className="business-photo-button" type="button" aria-expanded={expanded} onClick={() => setExpanded(v => !v)} aria-label={`${photoKinds[photo.kind] || '계약 사진'} ${expanded ? '접기' : '확대'}`}><img src={url} alt={photoKinds[photo.kind] || '계약 사진'} /></button> : error ? <ReadError onRetry={() => setRetry(v => v + 1)} /> : <div className="business-photo-loading">사진 불러오는 중…</div>}
    <figcaption>{photoKinds[photo.kind] || '계약 사진'}<br />{kstDateTime(photo.created_at)}</figcaption>
  </figure>;
}
function ReadError({ onRetry }) { return <div role="alert" className="business-error">불러오지 못했습니다.<button className="business-button" onClick={onRetry}>다시 시도</button></div>; }
