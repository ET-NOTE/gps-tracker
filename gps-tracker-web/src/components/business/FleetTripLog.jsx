import { useMemo, useState } from 'react';
import useCorporatePhone from '../../useCorporatePhone';
import {hideOutsideMockup} from '../../lib/mockupHidden';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { useStaff } from '../../state';
import { kstDateTime, purposeLabel } from '../../lib/businessExport';
import { reportIncluded } from '../../lib/tripQuality';
import { reportVehicleLabel } from '../../lib/ntsReport';
import { businessDate } from '../../lib/business';
import Icon from '../Icon';
import ExportButtons from './ExportButtons';
import FleetRecordMetrics from './FleetRecordMetrics';
import { BusinessButton, BusinessEmpty, BusinessError } from './BusinessWorkspace';
import { SkeletonList } from '../ui';

// Company-wide trip ledger: every vehicle's trips in one table, as in the mockup.
// Opening a row hands off to the per-vehicle record view, which keeps editing and exports.
const views = [
  ['all', '전체 운행', () => true],
  ['running', '운행 중', t => tripState(t) === 'running'],
  ['ended', '완료 운행', t => Boolean(t.ended_at) && tripState(t) !== 'running'],
  ['review', '확인 필요', t => tripState(t) === 'review'],
  ['confirmed', '기록 확정', t => tripState(t) === 'confirmed'],
];
const stateLabels = {
  running: ['운행 중', 'good'], review: ['확인 필요', 'warning'], confirmed: ['기록 확정', 'info'], ended: ['완료', ''],
};
export function tripState(t) {
  if (t.quality?.status === 'running' && !t.ended_at) return 'running';
  if (reportIncluded(t)) return 'confirmed';
  if (t.quality?.status === 'review' || t.quality?.report_included === false) return 'review';
  return 'ended';
}
const tripPurpose = t => t.annotation?.company_purpose_name || (t.annotation?.purpose && t.annotation.purpose !== 'unspecified' ? purposeLabel[t.annotation.purpose] : '');
const tripPlace = t => t.end_sites?.[0]?.name || t.end_address || '';
const km = m => (Number(m) || 0) / 1000;
const clock = v => kstDateTime(v).slice(11, 16);
function duration(t) {
  const minutes = Number.isFinite(t.duration_min) ? t.duration_min
    : t.ended_at ? Math.round((Date.parse(t.ended_at) - Date.parse(t.started_at)) / 60000) : null;
  if (minutes == null || minutes < 0) return '';
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? `${h}시간 ${String(m).padStart(2, '0')}분` : `${m}분`;
}

export default function FleetTripLog({ devices, onOpenVehicle }) {
  const desk = !useCorporatePhone() && hideOutsideMockup;
  const today = businessDate();
  const initial = { from: `${today.slice(0, 7)}-01`, to: today, vehicle: '', driver: '', department: '', purpose: '', query: '' };
  const [filters, setFilters] = useState(initial);
  const [view, setView] = useState('all');
  const set = (key, value) => setFilters(f => ({ ...f, [key]: value }));
  const invalid = !filters.from || !filters.to || filters.from > filters.to;
  const ids = devices.map(d => d.id).join(',');
  const q = useQuery({
    queryKey: ['fleet-trip-log', ids, filters.from, filters.to],
    enabled: !invalid && devices.length > 0,
    queryFn: async ({ signal }) => {
      // At most four vehicles at a time, so a large fleet does not trip the API rate limit.
      const lists = new Array(devices.length);
      let next = 0;
      async function worker() {
        while (next < devices.length && !signal?.aborted) {
          const index = next++, d = devices[index];
          const rows = await api.listFleetVehicleTrips(d.id, { from: filters.from, to: filters.to }, { signal });
          lists[index] = (rows || []).map(t => ({ ...t, vehicle: d }));
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, devices.length) }, worker));
      return lists.filter(Boolean).flat().sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
    },
  });
  const { data: staffAll } = useStaff();
  const staff = staffAll || [];
  const trips = q.data;
  const drivers = useMemo(() => [...new Set((trips || []).map(t => t.annotation?.driver_name).filter(Boolean))].sort(), [trips]);
  const departments = useMemo(() => [...new Set([...(trips || []).map(t => t.annotation?.driver_department), ...staff.map(s => s.department)].filter(Boolean))].sort(), [trips, staff]);
  const purposes = useMemo(() => [...new Set((trips || []).map(tripPurpose).filter(Boolean))].sort(), [trips]);
  const needle = filters.query.trim().toLocaleLowerCase();
  const scoped = (trips || []).filter(t =>
    (!filters.vehicle || String(t.vehicle.id) === filters.vehicle) &&
    (!filters.driver || (filters.driver === 'unassigned' ? !t.annotation?.driver_name : t.annotation?.driver_name === filters.driver)) &&
    (!filters.department || t.annotation?.driver_department === filters.department) &&
    (!filters.purpose || (filters.purpose === 'unclassified' ? !tripPurpose(t) : tripPurpose(t) === filters.purpose)) &&
    (!needle || [reportVehicleLabel(t.vehicle), t.vehicle.car_model, t.annotation?.driver_name, tripPurpose(t), tripPlace(t)].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle)));
  const matches = views.find(v => v[0] === view)[2];
  const rows = scoped.filter(matches);
  const known = Boolean(trips) && !invalid;
  const report = known && {
    title: '운행기록부', filename: `운행기록부_${filters.from}_${filters.to}`,
    columns: [['date', '운행일'], ['vehicle', '차량'], ['driver', '운전자'], ['department', '운전자 부서'], ['purpose', '운행목적'], ['place', '도착지'], ['start', '시작'], ['end', '종료'], ['distance', '주행거리(km)'], ['state', '기록 상태']].map(([key, label]) => ({ key, label })),
    rows: rows.map(t => ({
      date: kstDateTime(t.started_at).slice(0, 10), vehicle: reportVehicleLabel(t.vehicle), driver: t.annotation?.driver_name || '미지정',
      department: t.annotation?.driver_department || '', purpose: tripPurpose(t) || '미분류', place: tripPlace(t),
      start: kstDateTime(t.started_at), end: t.ended_at ? kstDateTime(t.ended_at) : tripState(t) === 'running' ? '운행 중' : '종료 미확인', distance: km(t.distance_m).toFixed(1), state: stateLabels[tripState(t)][0],
    })),
  };
  const count = state => known ? scoped.filter(t => tripState(t) === state).length : null;
  // Desktop design: no header row when the list is empty.
  const deskEmpty = desk && !rows.length;
  return <div className="corporate-reservations fleet-trip-log">
    <FleetRecordMetrics label="조회된 운행 요약" items={[
      { name: '조회된 운행', value: known ? scoped.length : null, unit: '건', icon: 'route' },
      { name: '운행 중', value: count('running'), unit: '건', tone: 'green' },
      { name: '확인 필요', value: count('review'), unit: '건', tone: 'amber' },
      { name: '조회 주행거리', value: known ? scoped.reduce((sum, t) => sum + km(t.distance_m), 0).toLocaleString('ko-KR', { maximumFractionDigits: 1, minimumFractionDigits: 1 }) : null, unit: 'km' },
    ]}/>
    <div className="fleet-booking-query">
      <div className="fleet-record-toolbar">
        <div className="corporate-view-switch fleet-trip-log-tabs" role="group" aria-label="운행 상태">
          {views.map(([id, label]) => <button key={id} type="button" className="corporate-view-option" aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>)}
        </div>
        <div className="fleet-record-actions"><ExportButtons csvOnly report={report} disabled={!rows.length}/></div>
      </div>
      <div className="fleet-record-fields fleet-booking-query-fields fleet-trip-log-fields">
        <div className="fleet-date-field"><span>운행 기간</span><div>
          <label className="fleet-date-endpoint"><span>시작일</span><input type="date" aria-label="운행 조회 시작일" value={filters.from} max={filters.to} onChange={e => set('from', e.target.value)}/></label><span aria-hidden="true">~</span>
          <label className="fleet-date-endpoint"><span>종료일</span><input type="date" aria-label="운행 조회 종료일" value={filters.to} min={filters.from} max={today} onChange={e => set('to', e.target.value)}/></label>
        </div></div>
        <label>차량<select value={filters.vehicle} onChange={e => set('vehicle', e.target.value)}><option value="">전체 차량</option>{devices.map(d => <option key={d.id} value={d.id}>{reportVehicleLabel(d)}</option>)}</select></label>
        <label>운전자<select value={filters.driver} onChange={e => set('driver', e.target.value)}><option value="">전체 운전자</option><option value="unassigned">미지정</option>{drivers.map(n => <option key={n}>{n}</option>)}</select></label>
        <label>운전자 부서<select value={filters.department} onChange={e => set('department', e.target.value)}><option value="">전체 부서</option>{departments.map(n => <option key={n}>{n}</option>)}</select></label>
        <label>운행목적<select value={filters.purpose} onChange={e => set('purpose', e.target.value)}><option value="">전체 운행목적</option><option value="unclassified">미분류</option>{purposes.map(n => <option key={n}>{n}</option>)}</select></label>
      </div>
      <div className="fleet-record-filterfoot"><label className="fleet-labeled-search"><span>검색</span><span className="fleet-inline-search"><Icon name="search" size={16}/><input type="search" aria-label="운행 검색" placeholder="차량, 운전자, 도착지 검색" value={filters.query} onChange={e => set('query', e.target.value)}/></span></label><div>
        <button type="button" className="fleet-filter-reset-link" onClick={() => { setFilters(initial); setView('all'); }}><Icon name="refresh" size={13}/>조건 초기화</button>
      </div></div>
    </div>
    {invalid && <BusinessError>시작일과 종료일을 확인해 주세요.</BusinessError>}
    {q.isError && <BusinessError onRetry={q.refetch}>운행기록을 불러오지 못했습니다.</BusinessError>}
    {!invalid && q.isPending && devices.length > 0 && <SkeletonList count={3} itemHeight={64}/>}
    {(known || !devices.length) && <section className="corporate-reservation-ledger fleet-trip-log-ledger">
      {deskEmpty?<div className="mockup-empty" role="status"><Icon name="search" size={31}/><strong>조회된 내역이 없습니다</strong><small>기간이나 검색 조건을 변경해 보세요.</small></div>:<div className="corporate-reservation-scroll" role="region" aria-label="운행 목록 · 좌우 스크롤" tabIndex={0}>
        <table className="corporate-reservation-table fleet-trip-log-table"><thead><tr><th scope="col">차량 / 운행일</th><th scope="col">운전자</th><th scope="col">운행목적 / 도착지</th><th scope="col">운행 시간</th><th scope="col">주행거리</th><th scope="col">기록 상태</th></tr></thead>
          <tbody>{rows.map(t => {
            const [label, tone] = stateLabels[tripState(t)];
            const open = () => onOpenVehicle(t.vehicle.id, { from: filters.from, to: filters.to });
            return <tr key={t.vehicle.id + '-' + t.started_at} className="booking-detail-row" onClick={event => { if (!event.target.closest('button')) open(); }}>
              <td data-label="차량 / 운행일" className="corporate-reservation-vehicle"><i className="corporate-reservation-thumb" aria-hidden="true"><Icon name="car" size={18}/></i>
                <span><button type="button" className="booking-detail-link" onClick={open}>{t.vehicle.license_plate || t.vehicle.name || '차량'}</button><small>{[t.vehicle.car_model || (t.vehicle.license_plate && t.vehicle.name !== t.vehicle.license_plate ? t.vehicle.name : ''), kstDateTime(t.started_at).slice(0, 10).replace(/-/g, '.')].filter(Boolean).join(' · ')}</small></span></td>
              <td data-label="운전자">{t.annotation?.driver_name || <span className="fleet-trip-log-missing">미지정</span>}</td>
              <td data-label="운행목적 / 도착지">{tripPurpose(t) ? <span>{tripPurpose(t)}</span> : <span className="fleet-trip-log-missing">미분류</span>}{tripPlace(t) && <small>{tripPlace(t)}</small>}</td>
              <td data-label="운행 시간">{clock(t.started_at)} – {t.ended_at ? clock(t.ended_at) : tripState(t) === 'running' ? '운행 중' : '종료 미확인'}<small>{duration(t)}</small></td>
              <td data-label="주행거리">{km(t.distance_m).toFixed(1)} km</td>
              <td data-label="기록 상태"><span className={'business-badge ' + tone}>{label}</span></td>
            </tr>;
          })}</tbody>
        </table>
        {!rows.length && <BusinessEmpty title={devices.length ? '조회된 운행이 없습니다.' : '등록된 차량이 없습니다.'}>{devices.length ? '운행 기간이나 조건을 변경해 주세요.' : '차량을 등록하면 운행 기록이 쌓입니다.'}</BusinessEmpty>}
      </div>}
      <footer className="corporate-reservation-footer">{rows.length}건</footer>
    </section>}
  </div>;
}
