import { useState } from 'react';
import { useRentals } from '../../state';
import { businessDate, rentalStatus } from '../../lib/business';
import { kstDateTime } from '../../lib/businessExport';
import { ContractPhotos } from './RentalPhotos';

const statuses = { draft: '초안', active: '임대 중', overdue: '반납 지연', returned: '반납 완료', cancelled: '취소' };
export default function VehiclePhotoHistory({ device }) {
  const [days, setDays] = useState('180'), [query, setQuery] = useState('');
  const to = businessDate(), from = businessDate(Date.now() - Number(days) * 86400000);
  const result = useRentals({ device_id: device.id, from: `${from}T00:00:00+09:00`, to: `${to}T23:59:59+09:00` });
  const contracts = (result.data || []).filter(c => String(c.device_id) === String(device.id)).sort((a, b) => Date.parse(b.starts_at) - Date.parse(a.starts_at) || Number(b.id) - Number(a.id));
  const rows = contracts.filter(c => [c.renter_name, String(c.id)].some(v => String(v || '').toLowerCase().includes(query.trim().toLowerCase())));
  return <div className="business-photo-history">
    <div className="business-photo-history-filters"><label>계약 조회 기간<select value={days} onChange={e => setDays(e.target.value)}><option value="30">최근 30일</option><option value="180">최근 180일</option><option value="365">최근 1년</option></select></label><label>계약 검색<input placeholder="임차인 이름 · 계약 번호" value={query} onChange={e => setQuery(e.target.value)} /></label></div>
    <p className="business-note">기간과 겹치는 계약을 최신순으로 표시합니다. 계약을 펼치면 인수·반납 사진을 종류별로 비교할 수 있습니다.</p>
    {result.isLoading ? <p>계약 이력을 불러오는 중…</p> : result.error ? <div role="alert" className="business-error">계약 이력을 불러오지 못했습니다.<button className="business-button" onClick={() => result.refetch()}>다시 시도</button></div> : <>
      <p className="business-note">조회 기간 {from} ~ {to} · {rows.length}개 계약</p>
      {rows.length ? rows.map((contract, i) => <HistoryContract key={contract.id} contract={contract} initiallyOpen={i === 0} />) : <p className="business-photo-empty">{contracts.length ? '검색한 계약이 없습니다.' : '이 기간에 계약이 없습니다.'}</p>}
    </>}
  </div>;
}
function HistoryContract({ contract, initiallyOpen }) {
  const [open, setOpen] = useState(initiallyOpen);
  return <section className="business-photo-timeline-item">
    <button className="business-photo-timeline-heading" type="button" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <span><strong>{contract.renter_name || '임차인 미등록'} · 계약 #{contract.id}</strong><small>{kstDateTime(contract.starts_at)} ~ {kstDateTime(contract.ends_at)}</small></span><span>{statuses[rentalStatus(contract)] || '상태 확인'} {open ? '−' : '+'}</span>
    </button>
    {open && <div className="business-photo-timeline-body"><ContractPhotos contractId={contract.id} /></div>}
  </section>;
}
