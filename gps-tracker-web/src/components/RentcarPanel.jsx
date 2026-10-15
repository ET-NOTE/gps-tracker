import React, { useEffect, useMemo, useState, useRef } from 'react';
import Icon from './Icon';
import ExportButtons from './business/ExportButtons';
import { rentalReport, invoiceReport, rentalPeriod } from '../lib/businessExport';
import { BusinessWorkspace, BusinessLocation, BusinessButton, BusinessError, BusinessEmpty, BusinessSection, BusinessMetrics, BusinessTask, BusinessSettings, BusinessVehicles } from './business/BusinessWorkspace';
import RentalBoard from './business/RentalBoard';
import { useBusinessClock, useRentalOperations, useBusinessSubscription } from './business/useBusinessData';
import { calendarDate, businessDate, rentalSummary, rentalStatus, filterRentals } from '../lib/business';
import { api } from '../api';
import { alertDialog, confirmDialog } from './Dialog';
import { StatCard, StatCardGrid } from './shared/StatCard';
import { Modal, FormField, Button, Pill, SkeletonList, toast } from './ui';
import {
  useRentals, useCreateRental, useUpdateRental, useReturnRental, useDeleteRental,
  useRenters, useRenterDetail, useAddBlacklist, useRemoveBlacklist,
  useHandoffTokens, useIssueHandoffToken, useRevokeHandoffToken,
  useRentalPhotos, useUploadRentalPhoto, useDeleteRentalPhoto, qk,
} from '../state';
import { useQueryClient } from '@tanstack/react-query';

function RentcarPanel({ devices, onMap, onNavigate, meta }) {
  const [tab, setTab] = useState('fleet');
  const [request, setRequest] = useState(null);
  const subscription = useBusinessSubscription('rentcar');
  const qc = useQueryClient();
  const openContracts = value => { setRequest(value); setTab('rentals'); };
  const tabs = [
    { id: 'fleet', label: '운영 현황', icon: 'home', description: '오늘 처리할 일과 차량 상태를 한눈에 확인하세요.' },
    { id: 'rentals', label: '계약 관리', icon: 'route', description: '차량과 임차인을 찾고 인수·반납을 처리하세요.' },
    { id: 'schedule', label: '배차·반납 일정', icon: 'clock', description: '차량별 계약 기간과 반납 일정을 확인하세요.' },
    { id: 'renters', label: '임차인', icon: 'user', description: '고객의 이용 이력과 유의 사항을 관리하세요.' },
    { id: 'settings', label: '설정', icon: 'wrench', description: '이용권 상태와 제공 기능을 확인하세요.' },
  ];
  return <BusinessWorkspace title="렌트카 운영" description="출고부터 반납까지, 오늘의 차량 업무를 관리하세요." tabs={tabs} tab={tab} onTab={value => { setRequest(null); setTab(value); }} devices={devices} kind="rentcar" onMap={onMap} onVehicleAction={d => openContracts({ deviceId: d.id })} onNavigate={onNavigate} meta={meta}
    action={<BusinessButton primary icon="plus" onClick={() => openContracts({ new: true })}>새 계약</BusinessButton>}>
    {tab === 'fleet' && <FleetTab devices={devices} onMap={onMap} onContracts={openContracts} />}
    {tab === 'rentals' && <RentalsTab devices={devices} request={request} />}
    {tab === 'schedule' && <ScheduleTab devices={devices} />}
    {tab === 'renters' && <RentersTab />}
    {tab === 'settings' && <BusinessSettings subscription={subscription.error
      ? <BusinessError onRetry={subscription.refetch}>이용권 정보를 불러오지 못했습니다.</BusinessError>
      : <SubTab sub={subscription.data} onChange={v => qc.setQueryData(qk.businessSubscription('rentcar'), v)} />} />}
  </BusinessWorkspace>;
}

// ═══════════════════════════════════════════════════════
// (2026-07-29 R-Sub) 렌트카 구독 탭 — CorporatePanel SubTab 미러.
// 각 계정 유형별 독립 구독 (rentcar_report / corporate_report).
// ═══════════════════════════════════════════════════════
function SubTab({ sub, onChange }) {
  const [busy, setBusy] = useState(false);

  async function buy() {
    const ok = await confirmDialog({
      title: '렌트카 구독 결제',
      body: `${sub.price_krw.toLocaleString()}원 — 포인트에서 차감되며 30일 추가됩니다.`,
      confirmLabel: '결제',
      tone: 'success',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.buyRentcarSubscription();
      onChange(r);
      await alertDialog({
        title: '구독 완료',
        body: `${new Date(r.expires_at).toLocaleDateString('ko-KR')} 까지 사용 가능합니다.`,
        tone: 'success',
      });
    } catch (e) {
      await alertDialog({ title: '결제 실패', body: e.message, tone: 'danger' });
    } finally { setBusy(false); }
  }

  if (!sub) return <div style={st.muted}>로딩...</div>;

  const daysLeft = sub.expires_at
    ? Math.max(0, Math.ceil((new Date(sub.expires_at).getTime() - Date.now()) / 86400_000))
    : null;

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 상태 요약 카드 */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 14, padding: 20, display: 'flex', gap: 16, alignItems: 'center',
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: 12,
          background: sub.active
            ? 'color-mix(in srgb, var(--accent) 15%, transparent)'
            : 'var(--surface-2)',
          color: sub.active ? 'var(--accent)' : 'var(--text-3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Icon name={sub.active ? 'coin' : 'warn'} size={22} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>렌트카 리포트 구독</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>
            {sub.active
              ? <>활성 · <b>{new Date(sub.expires_at).toLocaleDateString('ko-KR')}</b> 까지
                  {daysLeft != null && <span style={{ color: daysLeft <= 7 ? 'var(--warning)' : 'var(--text-3)' }}> ({daysLeft}일 남음)</span>}</>
              : '비활성 — 결제하면 30일 이용 가능'}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--primary)', letterSpacing: '-0.02em' }}>
            {sub.price_krw.toLocaleString()}<span style={{ fontSize: 13, color: 'var(--text-3)', marginLeft: 2 }}>원 / 30일</span>
          </div>
        </div>
      </div>

      <button onClick={buy} disabled={busy} style={{
        ...st.btnPrimary, padding: '14px 20px', fontSize: 14, alignSelf: 'flex-start',
      }}>
        {busy ? '...' : (sub.active ? '30일 추가 결제' : '구독 시작')}
      </button>

      {/* 안내 — 렌트카 유형 구독으로 이용 가능한 기능 */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 10, overflow: 'hidden',
      }}>
        <div style={{
          padding: '10px 14px', background: 'var(--surface-2)',
          fontSize: 12, fontWeight: 700, color: 'var(--text-2)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Icon name="info" size={14} />
          <span>구독으로 이용 가능한 기능</span>
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[
            { icon: 'route', title: '임대 계약 관리',       desc: '계약 등록·수정, 반납 정산과 청구서 다운로드' },
            { icon: 'clock', title: '반납 일정 캘린더',      desc: '월 그리드 · 오늘 반납 · 연체 표시 · 셀 클릭 신규 계약' },
            { icon: 'user',  title: '임차인 · 이용 유의사항',   desc: '재이용 이력 · 블랙리스트 등록/해제 · 전화번호 대조' },
            { icon: 'share', title: '인수·반납 QR 토큰',    desc: '고객에게 인수·반납 링크 전달, 차량 사진과 연료·주행거리 기록' },
          ].map(f => (
            <div key={f.title} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <div style={{
                width: 28, height: 28, borderRadius: 8,
                background: 'color-mix(in srgb, var(--primary) 12%, transparent)',
                color: 'var(--primary)', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Icon name={f.icon} size={14} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{f.title}</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, lineHeight: 1.5 }}>{f.desc}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{
          padding: '10px 16px', borderTop: '1px solid var(--border)',
          fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5,
        }}>
          * 법인운행 구독과 완전 분리 — 각 계정 유형별 독립 구독으로 운영됩니다.
        </div>
      </div>
    </div>
  );
}

// (F3) devices lat/lng 만 바뀌면 재렌더 skip — WS location fix 폭주 대응.
export default React.memo(RentcarPanel);

// ═══════════════════════════════════════════════════════
// (2026-07-28 Stage-R2) 반납 캘린더 — 월 그리드에 계약 표시.
// 각 셀: 그 날 진행중이거나 반납 예정인 계약. 반납 날짜 셀은 강조.
// 셀 클릭 → 그 날 preset 신규 계약. 계약 pill 클릭 → 편집.
// ═══════════════════════════════════════════════════════
function ScheduleTab({ devices }) {
  const [mode, setMode] = useState('board'), [editing, setEditing] = useState(null);
  const now = useBusinessClock();
  return <div className="business-schedule">
    <div className="business-switch"><button className="business-switch-item" aria-pressed={mode === 'board'} onClick={() => setMode('board')}>차량별 배차표</button><button className="business-switch-item" aria-pressed={mode === 'month'} onClick={() => setMode('month')}>월간 달력</button></div>
    {mode === 'board' ? <RentalBoard devices={devices} now={now} onNew={(deviceId, day) => setEditing({ new: true, deviceId, day })} onEdit={setEditing} /> : <MonthScheduleTab devices={devices} />}
    {editing && <RentalDialog init={editing.new ? null : editing} devices={devices} presetDate={editing.day} presetDeviceId={editing.deviceId} onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />}
  </div>;
}
function MonthScheduleTab({ devices }) {
  const [ym, setYm] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const [editing, setEditing] = useState(null);   // null | 'new' | contract | {new: 'YYYY-MM-DD'}
  const [returning, setReturning] = useState(null);

  // (F2-b) useRentals hook — ym 변할 때만 params key 변경 (useMemo 로 identity 안정).
  const scheduleParams = useMemo(() => {
    const [y, m] = ym.split('-').map(Number);
    const start = new Date(y, m - 1, 1);
    const end   = new Date(y, m, 1);
    return {
      from: new Date(start.getTime() - 7 * 86400_000).toISOString(),
      to:   new Date(end.getTime()   + 7 * 86400_000).toISOString(),
    };
  }, [ym]);
  const { data: list = [], isLoading: loading, error: qError, refetch } = useRentals(scheduleParams);
  const error = qError?.message || null;

  // 오늘 반납 예정 (표시 월 내 active + ends_at 오늘)
  const todayReturns = useMemo(() => {
    const t = businessDate();
    return list.filter(c =>
      ['active', 'overdue'].includes(c.status) &&
      businessDate(c.ends_at) === t);
  }, [list]);
  // 표시 월 내 반납 예정 총 건수
  const monthReturns = useMemo(() => {
    return list.filter(c => c.status !== 'cancelled' && businessDate(c.ends_at).slice(0, 7) === ym).length;
  }, [list, ym]);

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <StatCardGrid>
        <StatCard icon="clock"  label="오늘 반납"     value={qError || loading ? '—' : todayReturns.length} unit="건" tone={todayReturns.length > 0 ? 'primary' : 'default'} />
        <StatCard icon="bar"    label={`${ym} 반납`}  value={qError || loading ? '—' : monthReturns} unit="건" tone="default" />
        <StatCard icon="route"  label="전체 차량"     value={devices?.length ?? 0} unit="대" tone="default" />
      </StatCardGrid>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="month" value={ym} onChange={e => setYm(e.target.value || ym)}
          style={{ ...st.input, width: 140 }} />
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
          날짜를 누르면 새 계약을, 계약을 누르면 상세 정보를 열 수 있습니다.
        </span>
        <button onClick={() => setEditing('new')} style={{ marginLeft: 'auto', ...st.btnPrimary }}>
          <Icon name="plus" size={13} /> 새 계약
        </button>
      </div>

      {error && <BusinessError onRetry={refetch}>반납 일정을 불러오지 못했습니다.</BusinessError>}
      {loading && !list && <SkeletonList count={3} itemHeight={80} />}

      <RentalCalendar ym={ym} list={list}
        onDayClick={(dateStr) => setEditing({ new: dateStr })}
        onEventClick={(c) => setEditing(c)} />

      {editing && (
        <RentalDialog init={editing === 'new' || editing.new ? null : editing}
          devices={devices}
          presetDate={editing?.new || null}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)} />
      )}
      {returning && (
        <ReturnDialog contract={returning}
          onClose={() => setReturning(null)}
          onDone={() => setReturning(null)} />
      )}
    </div>
  );
}

function RentalCalendar({ ym, list, onDayClick, onEventClick }) {
  const [y, m] = ym.split('-').map(Number);
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd   = new Date(y, m, 0);
  const startDay   = monthStart.getDay();
  const daysInMonth = monthEnd.getDate();
  const todayStr = businessDate();

  const cells = [];
  for (let i = 0; i < startDay; i++) {
    const d = new Date(y, m - 1, i - startDay + 1);
    cells.push({ date: d, currentMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(y, m - 1, d), currentMonth: true });
  }
  while (cells.length < 42) {
    const last = cells[cells.length - 1].date;
    cells.push({ date: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1), currentMonth: false });
  }

  function contractsOn(date) {
    const dStr = calendarDate(date);
    return (list || []).filter(c => {
      const s = businessDate(c.starts_at);
      const e = businessDate(c.ends_at);
      return dStr >= s && dStr <= e;
    });
  }
  function isReturnDay(date, c) {
    return calendarDate(date) === businessDate(c.ends_at);
  }

  const DOW = ['일', '월', '화', '수', '목', '금', '토'];

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 8,
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
        {DOW.map((d, i) => (
          <div key={d} style={{
            fontSize: 11, fontWeight: 700, padding: '6px 2px', textAlign: 'center',
            color: i === 0 ? 'var(--danger)' : i === 6 ? 'var(--primary)' : 'var(--text-2)',
          }}>{d}</div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {cells.map((cell, i) => {
          const dStr = calendarDate(cell.date);
          const dayContracts = contractsOn(cell.date);
          const isToday = dStr === todayStr;
          const dow = cell.date.getDay();
          const hasReturn = dayContracts.some(c => isReturnDay(cell.date, c) && c.status !== 'returned' && c.status !== 'cancelled');
          const MAX_BADGES = 2;
          return (
            <div key={i} onClick={() => cell.currentMonth && onDayClick(dStr)} style={{
              minHeight: 'clamp(60px, 13vw, 92px)',
              padding: 3,
              minWidth: 0,
              background: isToday
                ? 'color-mix(in srgb, var(--primary) 8%, transparent)'
                : cell.currentMonth ? 'var(--surface)' : 'var(--surface-2)',
              border: hasReturn && cell.currentMonth
                ? '2px solid var(--warning)'
                : '1px solid ' + (isToday ? 'var(--primary)' : 'var(--border)'),
              borderRadius: 6,
              opacity: cell.currentMonth ? 1 : 0.4,
              cursor: cell.currentMonth ? 'pointer' : 'default',
              display: 'flex', flexDirection: 'column', gap: 2,
              overflow: 'hidden',
              position: 'relative',
            }}>
              <div style={{
                fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                color: !cell.currentMonth ? 'var(--text-3)'
                     : isToday ? 'var(--primary)'
                     : dow === 0 ? 'var(--danger)'
                     : dow === 6 ? 'var(--primary)'
                     : 'var(--text)',
              }}>
                <span>{cell.date.getDate()}</span>
                {hasReturn && cell.currentMonth && (
                  <span style={{ fontSize: 8, color: 'var(--warning)', fontWeight: 800 }}>반납</span>
                )}
              </div>
              {dayContracts.slice(0, MAX_BADGES).map(c => {
                const s = RENTAL_STATUS[rentalStatus(c)] || RENTAL_STATUS.draft;
                const returnHere = isReturnDay(cell.date, c);
                return (
                  <div key={c.id} onClick={(e) => { e.stopPropagation(); onEventClick(c); }} style={{
                    fontSize: 10, fontWeight: 600,
                    padding: '1px 3px', borderRadius: 3,
                    background: s.bg, color: s.color,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    cursor: 'pointer',
                    borderLeft: returnHere ? '3px solid var(--warning)' : 'none',
                    minWidth: 0,
                  }} title={`${c.renter_name} · ${c.license_plate || c.device_name || ''} · ${s.label}${returnHere ? ' · 오늘 반납' : ''}`}>
                    {c.license_plate || c.device_name || `#${c.device_id}`}
                  </div>
                );
              })}
              {dayContracts.length > MAX_BADGES && (
                <div style={{ fontSize: 9, color: 'var(--text-3)', textAlign: 'center' }}>
                  +{dayContracts.length - MAX_BADGES}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// (2026-07-28 Stage-R1) 렌트카 계약 관리 — 실 구현.
// ═══════════════════════════════════════════════════════
const RENTAL_STATUS = {
  draft:     { label: '초안',    color: 'var(--text-3)',  bg: 'var(--surface-2)' },
  active:    { label: '임대중',  color: 'var(--accent)',  bg: 'color-mix(in srgb, var(--accent) 15%, transparent)' },
  returned:  { label: '반납완료', color: 'var(--primary)', bg: 'color-mix(in srgb, var(--primary) 12%, transparent)' },
  overdue:   { label: '연체',    color: 'var(--danger)',  bg: 'color-mix(in srgb, var(--danger) 15%, transparent)' },
  cancelled: { label: '취소',    color: 'var(--text-3)',  bg: 'var(--surface-2)' },
};
const RATE_TYPE_LABEL = { hourly: '시간', daily: '일', monthly: '월' };

function RentalsTab({ devices, request }) {
  const [statusFilter, setStatusFilter] = useState('active');   // active | overdue | returned | all
  const [editing, setEditing] = useState(null);       // null | 'new' | contract
  const [returning, setReturning] = useState(null);   // contract to return
  const [handoff, setHandoff] = useState(null);       // contract for handoff link
  const [photosOf, setPhotosOf] = useState(null);     // contract for photo gallery
  const [rangeMode, setRangeMode] = useState('operations');
  const [from, setFrom] = useState(() => businessDate().slice(0,7)+'-01');
  const [to, setTo] = useState(() => businessDate());
  const rangeValid = rangeMode==='operations' || (!!from && !!to && from<=to);

  const now = useBusinessClock();
  const period = rangeMode==='operations' || !rangeValid ? null : {from:`${from}T00:00:00+09:00`,to:new Date(new Date(`${to}T00:00:00+09:00`).getTime()+86400000).toISOString()};
  const operations = useRentalOperations(now, period, rangeValid);
  const all = rangeMode==='operations' ? operations.data || [] : rentalPeriod(operations.data || [],{from,to,kind:rangeMode});
  const summary = rentalSummary(all, devices, now);
  const [query, setQuery] = useState('');
  const [deviceFilter, setDeviceFilter] = useState('');
  const [exportKind, setExportKind] = useState('contracts');
  useEffect(() => {
    setDeviceFilter(request?.deviceId || '');
    if (request?.new) setEditing('new');
    if (request?.contract) setEditing(request.contract);
    if (request?.returning) setReturning(request.returning);
    if (request?.status) setStatusFilter(request.status);
    else if (request?.deviceId) setStatusFilter('all');
  }, [request]);
  const list = operations.data ? filterRentals(all, { status: statusFilter, deviceId: deviceFilter, query }, now) : null;
  const loading = operations.isLoading;
  const deleteRental = useDeleteRental();
  const activeCount = filterRentals(all, { status: 'active' }, now).length;
  const overdueCount = summary.overdue.length;
  const returnedCount = all.filter(c => c.status === 'returned').length;
  const monthRevenue = summary.revenue;
  const returnToday = summary.todayReturns.length;

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <StatCardGrid>
        <StatCard icon="route"  label="활성 계약"     value={operations.error || !operations.data ? '—' : activeCount}   unit="건" tone="success" />
        <StatCard icon="clock"  label="오늘 반납"     value={operations.error || !operations.data ? '—' : returnToday}   unit="건" tone={returnToday > 0 ? 'primary' : 'default'} />
        <StatCard icon="warn"   label="연체"          value={operations.error || !operations.data ? '—' : overdueCount}  unit="건" tone={overdueCount > 0 ? 'danger' : 'default'} />
        <StatCard icon="coin"   label="이번달 매출"   value={operations.error || !operations.data ? '—' : monthRevenue.toLocaleString()} unit="원" tone="primary" />
      </StatCardGrid>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <FilterChip active={statusFilter==='active'}   onClick={() => setStatusFilter('active')}   label="활성"     count={activeCount} tone="success" />
        <FilterChip active={statusFilter==='overdue'}  onClick={() => setStatusFilter('overdue')}  label="연체"     count={overdueCount} tone="warn" />
        <FilterChip active={statusFilter==='returned'} onClick={() => setStatusFilter('returned')} label="반납완료" count={returnedCount} tone="primary" />
        <FilterChip active={statusFilter==='all'}      onClick={() => setStatusFilter('all')}      label="전체"     count={all.length} />
        <button onClick={() => setEditing('new')} style={{
          marginLeft: 'auto', ...st.btnPrimary,
        }}>
          <Icon name="plus" size={13} /> 새 계약
        </button>
      </div>

      <div className="business-filter-bar">
        <select aria-label="계약 조회 범위" value={rangeMode} onChange={e=>{setRangeMode(e.target.value);setStatusFilter('all');if(e.target.value==='settled')setExportKind('settlements');}} style={st.input}>
          <option value="operations">운영 범위</option><option value="contracts">계약 기간 지정</option><option value="settled">정산 기간 지정</option>
        </select>
        {rangeMode!=='operations' && <><input aria-label="계약 조회 시작일" type="date" value={from} onChange={e=>setFrom(e.target.value)} style={st.input}/><span>~</span><input aria-label="계약 조회 종료일" type="date" value={to} onChange={e=>setTo(e.target.value)} style={st.input}/></>}
        <label className="business-search"><Icon name="filter" size={16}/><input aria-label="계약 검색" placeholder="차량 · 임차인 · 연락처 검색" value={query} onChange={e => setQuery(e.target.value)} /></label>
        <select aria-label="계약 차량 필터" value={deviceFilter} onChange={e => setDeviceFilter(e.target.value)} style={st.input}>
          <option value="">전체 차량</option>{devices.map(d => <option key={d.id} value={d.id}>{d.car_plate || d.license_plate || d.display_name || d.device_uid}</option>)}
        </select>
      </div>
      <p className="business-note">{rangeMode==='operations'?'진행 중인 계약과 이번 달부터 90일 이내 일정 · 이번 달 정산 내역입니다.':`${from} ~ ${to}의 ${rangeMode==='settled'?'정산 완료':'계약 기간과 겹치는'} 내역입니다.`} 요약은 검색·상태 필터와 관계없이 조회 범위 기준으로 집계합니다.</p>
      {!rangeValid && <p role="alert" className="business-export-error">조회 시작일과 종료일을 올바르게 선택해 주세요.</p>}
      <div className="business-export-bar">
        <label>내보낼 자료 <select aria-label="내보낼 자료" value={exportKind} onChange={e=>setExportKind(e.target.value)} style={st.input}>
          <option value="contracts">검색 결과 계약 목록</option><option value="settlements">검색 결과 중 반납 정산</option>
        </select></label>
        <ExportButtons report={list ? rentalReport(list,{settlement:exportKind==='settlements',now,filterText:`조회: ${rangeMode==='operations'?'이번 달 이후 90일 일정·진행 계약·이번 달 정산':`${from} ~ ${to} (${rangeMode==='settled'?'정산일':'계약 기간'} 기준)`} / 상태: ${statusFilter==='all'?'전체':RENTAL_STATUS[statusFilter]?.label || '활성'} / 차량: ${deviceFilter || '전체'} / 검색: ${query || '없음'}`}) : null} disabled={loading || !!operations.error || !rangeValid} />
        <span className="business-note">현재 검색·차량·상태 조건을 적용합니다. 전체 정산은 ‘전체’ 또는 ‘반납완료’를 선택하세요.</span>
      </div>
      {operations.error && <BusinessError onRetry={operations.refetch}>계약 정보를 불러오지 못했습니다. 표시 중인 정보가 있다면 이전 조회 결과입니다.</BusinessError>}
      {loading && !list && <SkeletonList count={4} itemHeight={80} />}
      {list && !operations.error && list.length === 0 && <BusinessEmpty title="조건에 맞는 계약이 없습니다.">검색 조건을 변경하거나 새 계약을 등록해 주세요.</BusinessEmpty>}

      {list && list.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 8 }}>
          {list.map(c => <RentalCard key={c.id} c={{ ...c, status: rentalStatus(c, now) }}
            onEdit={() => setEditing(c)}
            onReturn={() => setReturning(c)}
            onHandoff={() => setHandoff(c)}
            onPhotos={() => setPhotosOf(c)}
            onDelete={async () => {
              const ok = await confirmDialog({ title: '계약 삭제', body: '삭제하시겠습니까?', danger: true });
              if (!ok) return;
              try { await deleteRental.mutateAsync(c.id); }
              catch (e) { await alertDialog({ title: '삭제 실패', body: e.message, tone: 'danger' }); }
            }} />)}
        </div>
      )}

      {editing && (
        <RentalDialog init={editing === 'new' ? null : editing} devices={devices}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)} />
      )}
      {returning && (
        <ReturnDialog contract={returning}
          onClose={() => setReturning(null)}
          onDone={() => setReturning(null)} />
      )}
      {handoff && (
        <HandoffTokenDialog contract={handoff}
          onClose={() => setHandoff(null)} />
      )}
      {photosOf && (
        <PhotoGalleryModal contract={photosOf}
          onClose={() => setPhotosOf(null)} />
      )}
    </div>
  );
}

function RentalCard({ c, onEdit, onReturn, onDelete, onHandoff, onPhotos }) {
  const s = RENTAL_STATUS[rentalStatus(c)] || RENTAL_STATUS.draft;
  const start = new Date(c.starts_at);
  const end   = new Date(c.ends_at);
  const isReturned  = c.status === 'returned' || c.status === 'cancelled';
  const isOverdue   = c.status === 'overdue';
  const daysUntilEnd = Math.ceil((end.getTime() - Date.now()) / 86400_000);
  const fmtDate = d => d.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' });

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 8,
      borderLeft: isOverdue ? '4px solid var(--danger)' : '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 10, padding: '3px 8px', borderRadius: 999,
          background: s.bg, color: s.color, fontWeight: 700,
        }}>{s.label}</span>
        <span style={{ fontWeight: 800, fontSize: 14 }}>
          {c.license_plate || c.device_name || `#${c.device_id}`}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{c.renter_name}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {!isReturned && (
            <>
              <button onClick={onHandoff} style={{ ...st.btnGhost, padding: '4px 8px' }} title="임차인 QR/링크 발급">
                <Icon name="link" size={11} />
              </button>
              <button onClick={onReturn} style={{ ...st.btnPrimary, padding: '4px 10px', fontSize: 11 }} title="반납 처리">
                반납
              </button>
            </>
          )}
          <button onClick={onPhotos} style={{ ...st.btnGhost, padding: '4px 8px' }} title="사진 (오도미터/파손/연료)">
            <Icon name="cam" size={11} />
          </button>
          <button onClick={onEdit} style={{ ...st.btnGhost, padding: '4px 8px' }} title="편집">
            <Icon name="edit" size={11} />
          </button>
          <button onClick={onDelete} style={{ ...st.btnGhost, padding: '4px 8px', color: 'var(--danger)' }} title="삭제">
            <Icon name="trash2" size={11} />
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, fontSize: 12, color: 'var(--text-2)', flexWrap: 'wrap' }}>
        <span><Icon name="clock" size={11} /> {fmtDate(start)} ~ {fmtDate(end)}</span>
        <span>· {c.rate_amount_krw.toLocaleString()}원/{RATE_TYPE_LABEL[c.rate_type] || c.rate_type}</span>
        {c.deposit_krw > 0 && <span>· 보증금 {c.deposit_krw.toLocaleString()}</span>}
        {c.renter_phone && <span>· {c.renter_phone}</span>}
      </div>

      {!isReturned && !isOverdue && daysUntilEnd >= 0 && daysUntilEnd <= 3 && (
        <div style={{
          fontSize: 11, color: 'var(--warning)', fontWeight: 700,
          background: 'color-mix(in srgb, var(--warning) 12%, transparent)',
          padding: '4px 8px', borderRadius: 6,
        }}>
          🔔 {daysUntilEnd === 0 ? '오늘 반납' : `${daysUntilEnd}일 후 반납`}
        </div>
      )}
      {isOverdue && (
        <div style={{
          fontSize: 11, color: 'var(--danger)', fontWeight: 800,
          background: 'color-mix(in srgb, var(--danger) 15%, transparent)',
          padding: '4px 8px', borderRadius: 6,
        }}>
          ⚠ 반납 지연 · {Math.abs(daysUntilEnd)}일 경과
        </div>
      )}
      {c.settled_amount_krw != null && (
        <SettlementSummary c={c} />
      )}
    </div>
  );
}

// (R4) 정산 breakdown 표시 + 청구서 다운로드.
function SettlementSummary({ c }) {
  const lines = c.settlement_json?.lines || [];
  const refund = c.refund_krw ?? ((c.deposit_krw || 0) - (c.settled_amount_krw || 0));
  return (
    <div style={{
      background: 'var(--surface-2)', borderRadius: 8, padding: 8,
      display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11,
    }}>
      {lines.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, color: 'var(--text-2)' }}>
          <span style={{ color: 'var(--text-3)', minWidth: 44 }}>
            {({ base:'기본료', over_km:'초과km', late:'지연', extra:'기타' })[l.kind] || l.kind}
          </span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.label}</span>
          <span style={{ fontWeight: 600, color: 'var(--text)' }}>{(l.amount||0).toLocaleString()}</span>
        </div>
      ))}
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        marginTop: 4, paddingTop: 4, borderTop: '1px dashed var(--border)',
        fontWeight: 700, color: 'var(--text)',
      }}>
        <span>소계</span>
        <span style={{ color: 'var(--primary)' }}>{(c.settled_amount_krw || 0).toLocaleString()}원</span>
      </div>
      {c.deposit_krw > 0 && (
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          fontWeight: 800,
          color: refund >= 0 ? 'var(--accent)' : 'var(--danger)',
        }}>
          <span>{refund >= 0 ? '환급' : '추가청구'}</span>
          <span>{Math.abs(refund).toLocaleString()}원</span>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button onClick={() => downloadInvoice(c)} style={{ ...st.btnGhost, fontSize: 10, padding: '4px 8px', flex: 1 }}>
          <Icon name="download" size={10} /> 청구서 XLSX
        </button>
        <ExportButtons report={invoiceReport(c)} pdfOnly />
      </div>
    </div>
  );
}

async function downloadInvoice(c) {
  try {
    const { blob, filename } = await api.rentalInvoiceXlsx(c.id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    a.remove(); URL.revokeObjectURL(url);
  } catch (e) {
    alertDialog({ title: '청구서 다운로드 실패', body: e.message, tone: 'danger' });
  }
}

// datetime-local 헬퍼
function isoToLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localToIso(v) { return v ? new Date(v).toISOString() : null; }

function RentalDialog({ init, devices, presetDate, presetDeviceId, onClose, onSaved }) {
  // presetDate 'YYYY-MM-DD' 있으면 그 날 09:00 시작, 다음날 09:00 종료. 없으면 오늘 기준.
  const defaultStart = () => {
    const d = presetDate ? new Date(`${presetDate}T09:00:00`) : new Date();
    d.setHours(9, 0, 0, 0); return d;
  };
  const defaultEnd = () => {
    const d = new Date(defaultStart().getTime() + 86400_000);
    return d;
  };
  const [deviceId, setDeviceId] = useState(init?.device_id ?? presetDeviceId ?? devices?.[0]?.id ?? '');
  const [renterName,   setRenterName]   = useState(init?.renter_name ?? '');
  const [renterPhone,  setRenterPhone]  = useState(init?.renter_phone ?? '');
  const [idLast4,      setIdLast4]      = useState(init?.renter_id_last4 ?? '');
  const [startsAt,     setStartsAt]     = useState(init ? isoToLocal(init.starts_at) : isoToLocal(defaultStart().toISOString()));
  const [endsAt,       setEndsAt]       = useState(init ? isoToLocal(init.ends_at)   : isoToLocal(defaultEnd().toISOString()));
  const [rateType,     setRateType]     = useState(init?.rate_type ?? 'daily');
  const [rateAmount,   setRateAmount]   = useState(init?.rate_amount_krw ?? 0);
  const [includedKm,   setIncludedKm]   = useState(init?.included_km_per_day ?? '');
  const [overKmPrice,  setOverKmPrice]  = useState(init?.over_km_price_krw ?? '');
  const [deposit,      setDeposit]      = useState(init?.deposit_krw ?? 0);
  const [pickupOd,     setPickupOd]     = useState(init?.pickup_odometer_km ?? '');
  const [pickupLoc,    setPickupLoc]    = useState(init?.pickup_location ?? '');
  const [returnLoc,    setReturnLoc]    = useState(init?.return_location ?? '');
  const [status,       setStatus]       = useState(init?.status ?? 'draft');
  const [note,         setNote]         = useState(init?.note ?? '');
  // (F2-b) mutation — 성공 시 자동 invalidate.
  const createMut = useCreateRental();
  const updateMut = useUpdateRental();
  const busy = createMut.isPending || updateMut.isPending;
  const [phoneLookup, setPhoneLookup] = useState(null);   // { blacklisted, entry, visits }

  // (R6) phone 300ms debounce → lookup 재방문/블랙리스트.
  useEffect(() => {
    const p = renterPhone.trim();
    if (!p || p.length < 7) { setPhoneLookup(null); return; }
    let cancelled = false;
    const id = setTimeout(() => {
      api.checkBlacklist(p).then(r => { if (!cancelled) setPhoneLookup(r); })
        .catch(() => { if (!cancelled) setPhoneLookup(null); });
    }, 300);
    return () => { cancelled = true; clearTimeout(id); };
  }, [renterPhone]);

  async function save() {
    if (!deviceId) { alertDialog({ title: '차량 선택 필요', body: '', tone: 'danger' }); return; }
    if (!renterName.trim()) { alertDialog({ title: '임차인 이름 필요', body: '', tone: 'danger' }); return; }
    // (R6) 블랙리스트 block 이면 신규 계약 차단, warn 이면 확인 통과.
    if (phoneLookup?.blacklisted && phoneLookup.entry?.severity === 'block' && !init?.id) {
      await alertDialog({
        title: '⛔ 블랙리스트 차단',
        body: `이 임차인 (${renterPhone}) 은 차단 등록됨: ${phoneLookup.entry.reason}\n임차인 탭에서 해제 후 진행하세요.`,
        tone: 'danger',
      });
      return;
    }
    if (phoneLookup?.blacklisted && phoneLookup.entry?.severity === 'warn' && !init?.id) {
      const ok = await confirmDialog({
        title: '⚠ 블랙리스트 경고',
        body: `이 임차인은 경고 등록됨: ${phoneLookup.entry.reason}\n계속하시겠습니까?`,
        danger: true,
      });
      if (!ok) return;
    }
    const body = {
      device_id: Number(deviceId),
      renter_name: renterName.trim(),
      renter_phone: renterPhone.trim() || null,
      renter_id_last4: idLast4.trim() || null,
      starts_at: localToIso(startsAt),
      ends_at:   localToIso(endsAt),
      rate_type: rateType,
      rate_amount_krw: Number(rateAmount) || 0,
      included_km_per_day: includedKm === '' ? null : Number(includedKm),
      over_km_price_krw:   overKmPrice === '' ? null : Number(overKmPrice),
      deposit_krw: Number(deposit) || 0,
      pickup_odometer_km: pickupOd === '' ? null : Number(pickupOd),
      pickup_location: pickupLoc.trim() || null,
      return_location: returnLoc.trim() || null,
      status,
      note: note.trim() || null,
    };
    try {
      if (init?.id) await updateMut.mutateAsync({ id: init.id, body });
      else          await createMut.mutateAsync(body);
      onSaved();
    } catch (e) {
      alertDialog({ title: '저장 실패', body: e.message, tone: 'danger' });
    }
  }

  return (
    <Modal open onClose={onClose} size="lg" title={init?.id ? '계약 편집' : '새 임대 계약'} footer={<>
      <Button onClick={onClose} disabled={busy} variant="ghost" size="lg" style={{ flex: 1 }}>취소</Button>
      <Button onClick={save} busy={busy} variant="primary" size="lg" style={{ flex: 2 }}>
        {busy ? '저장 중...' : '저장'}
      </Button>
    </>}>
        {/* 차량 + 상태 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
          <Labeled label="차량">
            <select value={deviceId} onChange={e => setDeviceId(e.target.value)} style={st.input}>
              {(devices || []).map(d => (
                <option key={d.id} value={d.id}>
                  {d.license_plate ? `${d.license_plate} · ` : ''}{d.display_name || d.device_uid}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="상태">
            <select value={status} onChange={e => setStatus(e.target.value)} style={st.input}>
              {Object.entries(RENTAL_STATUS).map(([id, meta]) => (
                <option key={id} value={id}>{meta.label}</option>
              ))}
            </select>
          </Labeled>
        </div>

        {/* 임차인 */}
        <div style={{ fontSize: 11, color: 'var(--primary)', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          임차인 정보
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
          <Labeled label="이름 *"><input value={renterName} onChange={e => setRenterName(e.target.value)} style={st.input} /></Labeled>
          <Labeled label="연락처"><input value={renterPhone} onChange={e => setRenterPhone(e.target.value)} placeholder="010-..." style={st.input} /></Labeled>
          <Labeled label="신분증 뒤 4자리"><input value={idLast4} maxLength={4} onChange={e => setIdLast4(e.target.value.replace(/\D/g, ''))} placeholder="1234" style={st.input} /></Labeled>
        </div>
        {phoneLookup && (phoneLookup.visits > 0 || phoneLookup.blacklisted) && (
          <div style={{
            padding: '8px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
            display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
            background: phoneLookup.blacklisted
              ? `color-mix(in srgb, var(--${phoneLookup.entry?.severity === 'block' ? 'danger' : 'warning'}) 12%, transparent)`
              : 'color-mix(in srgb, var(--primary) 10%, transparent)',
            color: phoneLookup.blacklisted
              ? `var(--${phoneLookup.entry?.severity === 'block' ? 'danger' : 'warning'})`
              : 'var(--primary)',
          }}>
            {phoneLookup.blacklisted ? (
              <>
                <span>{phoneLookup.entry.severity === 'block' ? '⛔ 블랙리스트 (차단)' : '⚠ 블랙리스트 (경고)'}</span>
                <span style={{ opacity: 0.8, fontWeight: 500 }}>사유: {phoneLookup.entry.reason}</span>
              </>
            ) : (
              <>
                <Icon name="refresh" size={12} />
                <span>재방문 임차인 · 기존 계약 {phoneLookup.visits}건</span>
              </>
            )}
          </div>
        )}

        {/* 기간 + 인수 오도미터 */}
        <div className="business-datetime-fields">
          <Labeled label="시작"><input type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)} style={st.input} /></Labeled>
          <Labeled label="종료"><input type="datetime-local" value={endsAt}   onChange={e => setEndsAt(e.target.value)}   style={st.input} /></Labeled>
        </div>
        <Labeled label="인수 오도미터 (km)"><input type="number" value={pickupOd} onChange={e => setPickupOd(e.target.value)} style={st.input} /></Labeled>

        {/* 요금 */}
        <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          요금
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
          <Labeled label="요금 단위">
            <select value={rateType} onChange={e => setRateType(e.target.value)} style={st.input}>
              {Object.entries(RATE_TYPE_LABEL).map(([id, label]) => <option key={id} value={id}>{label} 당</option>)}
            </select>
          </Labeled>
          <Labeled label={`요금 (원/${RATE_TYPE_LABEL[rateType]})`}>
            <input type="number" value={rateAmount} onChange={e => setRateAmount(e.target.value)} style={st.input} />
          </Labeled>
          <Labeled label="보증금 (원)">
            <input type="number" value={deposit} onChange={e => setDeposit(e.target.value)} style={st.input} />
          </Labeled>
          <Labeled label="1일 포함 km (선택)">
            <input type="number" value={includedKm} onChange={e => setIncludedKm(e.target.value)} placeholder="무제한" style={st.input} />
          </Labeled>
          <Labeled label="km 당 초과료 (원)">
            <input type="number" value={overKmPrice} onChange={e => setOverKmPrice(e.target.value)} placeholder="미부과" style={st.input} />
          </Labeled>
        </div>

        {/* 위치 + 메모 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
          <Labeled label="인수 장소"><input value={pickupLoc} onChange={e => setPickupLoc(e.target.value)} style={st.input} /></Labeled>
          <Labeled label="반납 장소"><input value={returnLoc} onChange={e => setReturnLoc(e.target.value)} style={st.input} /></Labeled>
        </div>
        <Labeled label="메모"><input value={note} onChange={e => setNote(e.target.value)} style={st.input} /></Labeled>

    </Modal>
  );
}

function ReturnDialog({ contract, onClose, onDone }) {
  const [odometer, setOdometer] = useState(contract.return_odometer_km ?? '');
  const [location, setLocation] = useState(contract.return_location ?? '');
  const [extraFee,   setExtraFee]   = useState('');
  const [extraLabel, setExtraLabel] = useState('');
  const [returnedAt, setReturnedAt] = useState(isoToLocal(new Date().toISOString()));
  const [note,     setNote]     = useState('');
  // (F2-b) useReturnRental mutation — 성공 시 rentals/renters 자동 invalidate.
  const returnMut = useReturnRental();
  const busy = returnMut.isPending;

  // (R4) 정산 실시간 preview — 백엔드와 동일 공식.
  const preview = useMemo(() => {
    return computeSettlementPreview(contract, {
      returnOdometerKm: odometer === '' ? null : Number(odometer),
      extraFeeKrw:      extraFee === '' ? 0    : Number(extraFee),
      extraLabel:       extraLabel.trim() || '기타',
      returnedAt:       returnedAt ? new Date(returnedAt) : new Date(),
    });
  }, [contract, odometer, extraFee, extraLabel, returnedAt]);

  async function submit() {
    try {
      await returnMut.mutateAsync({
        id: contract.id,
        body: {
          return_odometer_km: odometer === '' ? null : Number(odometer),
          return_location:    location.trim() || null,
          extra_fee_krw:      extraFee === '' ? null : Number(extraFee),
          extra_fee_label:    extraLabel.trim() || null,
          returned_at:        returnedAt ? new Date(returnedAt).toISOString() : null,
          note:               note.trim() || null,
        },
      });
      onDone();
    } catch (e) {
      alertDialog({ title: '반납 실패', body: e.message, tone: 'danger' });
    }
  }

  return (
    <Modal open onClose={onClose} size="md" title="반납 처리"
      subtitle={`${contract.license_plate || contract.device_name} · ${contract.renter_name}`}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 'var(--space-2)' }}>
          <Labeled label="실제 반납 시각">
            <input type="datetime-local" value={returnedAt}
              onChange={e => setReturnedAt(e.target.value)} style={st.input} />
          </Labeled>
          <Labeled label="반납 오도미터 (km)">
            <input type="number" value={odometer}
              onChange={e => setOdometer(e.target.value)} placeholder="예: 12345" style={st.input} />
          </Labeled>
        </div>
        <Labeled label="반납 장소">
          <input value={location} onChange={e => setLocation(e.target.value)} style={st.input} />
        </Labeled>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
          <Labeled label="기타 요금 사유 (세차·파손·연료 등)">
            <input value={extraLabel} onChange={e => setExtraLabel(e.target.value)}
              placeholder="예: 세차비" style={st.input} />
          </Labeled>
          <Labeled label="금액 (원)">
            <input type="number" value={extraFee} onChange={e => setExtraFee(e.target.value)}
              placeholder="0" style={st.input} />
          </Labeled>
        </div>
        <Labeled label="메모"><input value={note} onChange={e => setNote(e.target.value)} style={st.input} /></Labeled>

        {/* itemized preview */}
        <div style={{
          padding: 10, background: 'var(--surface-2)', borderRadius: 8,
          display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12,
        }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-3)', letterSpacing: 0.4 }}>
            정산 미리보기
          </div>
          {preview.lines.map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, color: 'var(--text-2)' }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.label}</span>
              <span style={{ fontWeight: 600, color: 'var(--text)' }}>{l.amount.toLocaleString()}원</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between',
              marginTop: 4, paddingTop: 4, borderTop: '1px dashed var(--border)',
              fontWeight: 700 }}>
            <span>소계</span>
            <span style={{ color: 'var(--primary)' }}>{preview.subtotal.toLocaleString()}원</span>
          </div>
          {contract.deposit_krw > 0 && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-2)' }}>
                <span>보증금</span>
                <span>{contract.deposit_krw.toLocaleString()}원</span>
              </div>
              <div style={{
                display: 'flex', justifyContent: 'space-between', fontWeight: 800,
                color: preview.balance >= 0 ? 'var(--accent)' : 'var(--danger)',
              }}>
                <span>{preview.balance >= 0 ? '환급 (임차인에게)' : '추가 청구 (임차인에게)'}</span>
                <span>{Math.abs(preview.balance).toLocaleString()}원</span>
              </div>
            </>
          )}
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-1)' }}>
          <Button onClick={onClose} disabled={busy} variant="ghost" style={{ flex: 1 }}>취소</Button>
          <Button onClick={submit} busy={busy} variant="primary" size="lg" style={{ flex: 2 }}>
            {busy ? '반납 처리 중...' : '반납 · 정산'}
          </Button>
        </div>
    </Modal>
  );
}

// (R4) 백엔드와 동일 공식으로 정산 line item 계산 — preview 전용.
function computeSettlementPreview(c, { returnOdometerKm, extraFeeKrw, extraLabel, returnedAt }) {
  const dur = new Date(c.ends_at) - new Date(c.starts_at); // ms
  const hours = dur / 3600_000;
  let units, unitLabel;
  if (c.rate_type === 'hourly')       { units = Math.max(1, Math.ceil(hours));       unitLabel = '시간'; }
  else if (c.rate_type === 'monthly') { units = Math.max(1, Math.ceil(hours/24/30)); unitLabel = '개월'; }
  else                                { units = Math.max(1, Math.ceil(hours/24));    unitLabel = '일'; }
  const rate = c.rate_amount_krw || 0;
  const baseFee = units * rate;

  // 초과 주행
  let overKm = 0, overFee = 0;
  if (returnOdometerKm != null && c.pickup_odometer_km != null
      && c.included_km_per_day != null && c.over_km_price_krw != null) {
    const driven = Math.max(0, returnOdometerKm - c.pickup_odometer_km);
    const days   = Math.max(1, Math.ceil(hours / 24));
    const allowed = c.included_km_per_day * days;
    overKm  = Math.max(0, driven - allowed);
    overFee = overKm * c.over_km_price_krw;
  }
  // 지연 반납
  const endsAt = new Date(c.ends_at);
  const lateHours = returnedAt > endsAt ? Math.max(0, Math.ceil((returnedAt - endsAt) / 3600_000)) : 0;
  const hourly = c.rate_type === 'hourly' ? rate
    : c.rate_type === 'monthly' ? Math.floor(rate / 720)
    : Math.floor(rate / 24);
  const lateFee = lateHours > 0 ? Math.round(lateHours * hourly * 1.5) : 0;

  const extra = Number(extraFeeKrw) || 0;
  const lines = [
    { kind: 'base', label: `기본 요금 (${units}${unitLabel} × ${rate.toLocaleString()}원)`, amount: baseFee },
  ];
  if (overKm > 0 && overFee > 0) {
    lines.push({ kind: 'over_km',
      label: `초과 주행 (${overKm}km × ${c.over_km_price_krw.toLocaleString()}원)`, amount: overFee });
  }
  if (lateHours > 0 && lateFee > 0) {
    lines.push({ kind: 'late',
      label: `지연 반납 (${lateHours}시간 × ${hourly.toLocaleString()}원 × 1.5배)`, amount: lateFee });
  }
  if (extra !== 0) {
    lines.push({ kind: 'extra', label: extraLabel, amount: extra });
  }
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const balance  = (c.deposit_krw || 0) - subtotal;
  return { lines, subtotal, balance };
}

function Labeled({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>{label}</div>
      {children}
    </div>
  );
}

function FilterChip({ active, onClick, label, count, tone = 'default' }) {
  const c = tone === 'success' ? 'var(--accent)' : tone === 'warn' ? 'var(--warning)' : tone === 'primary' ? 'var(--primary)' : 'var(--primary)';
  return (
    <button onClick={onClick} style={{
      padding: '6px 12px', borderRadius: 999,
      background: active ? c : 'var(--surface-2)',
      color: active ? 'white' : 'var(--text-2)',
      border: 'none', cursor: 'pointer',
      fontSize: 12, fontWeight: 700,
      display: 'flex', alignItems: 'center', gap: 6,
    }}>
      {label}
      <span style={{
        fontSize: 10, padding: '1px 6px', borderRadius: 999,
        background: active ? 'rgba(255,255,255,0.25)' : 'var(--surface)',
        color: active ? 'white' : 'var(--text-3)', fontWeight: 700,
      }}>{count}</span>
    </button>
  );
}

// (2026-07-28 Stage-R8) 렌트카 홈 대시보드 — rental_contracts 통합 뷰.
// 차량 fleet + 임대 사이드를 한 화면에서. 오늘/이번주 반납 임박, 활성 계약,
// 이번달 매출·유휴 차량, 최근 반납.
function FleetTab({ devices, onMap, onContracts }) {
  const now = useBusinessClock();
  const result = useRentalOperations(now);
  const summary = rentalSummary(result.data || [], devices, now);
  const ready = !!result.data && !result.error;
  const tasks = [
    ...summary.overdue.map(c => ({ c, key: `overdue-${c.id}`, label: '반납 지연', tone: 'urgent', date: c.ends_at, action: '반납 처리', returning: true })),
    ...summary.todayReturns.filter(c => rentalStatus(c, now) !== 'overdue').map(c => ({ c, key: `return-${c.id}`, label: '오늘 반납', tone: 'info', date: c.ends_at, action: '반납 처리', returning: true })),
    ...summary.todayPickups.map(c => ({ c, key: `pickup-${c.id}`, label: c.status === 'draft' ? '출고 확인' : '오늘 출고', tone: 'good', date: c.starts_at, action: '계약 확인' })),
  ];
  return <div className="business-overview">
    <BusinessMetrics items={[
      { label: '오늘 출고', value: ready ? summary.todayPickups.length : null, unit: '건', hint: '오늘 시작하는 계약', icon: 'route' },
      { label: '오늘 반납', value: ready ? summary.todayReturns.length : null, unit: '건', hint: '예정 시간과 반납 상태 확인', icon: 'clock' },
      { label: '반납 지연', value: ready ? summary.overdue.length : null, unit: '건', hint: '종료 시간을 지난 미반납 계약', tone: summary.overdue.length ? 'urgent' : '', icon: 'warn' },
      { label: '미배차 차량', value: ready ? summary.available.length : null, unit: '대', hint: '신규 계약 전 예약·정비 확인', tone: 'good', icon: 'list' },
    ]}/>
    {result.error && <BusinessError onRetry={result.refetch}>계약 현황을 불러오지 못했습니다. 배차·반납 상태를 확인한 후 처리해 주세요.</BusinessError>}
    <div className="business-overview-grid"><BusinessLocation devices={devices} />
    <BusinessSection title="오늘 처리할 일" description="지연된 반납을 먼저 확인하고 출고·반납을 처리하세요." action={<BusinessButton onClick={() => onContracts({ status: 'all' })}>계약 전체 보기</BusinessButton>}>
      {result.isLoading ? <SkeletonList count={3} itemHeight={72}/> : tasks.length ? tasks.map(({ c, key, label, tone, date, action, returning }) =>
        <BusinessTask key={key} title={c.license_plate || c.device_name || `차량 ${c.device_id}`} description={`${c.renter_name} · ${new Date(date).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`} label={label} tone={tone} action={action} onClick={() => onContracts(returning ? { returning: c } : { contract: c })}/>)
        : !result.error && <BusinessEmpty title="오늘 처리할 출고·반납이 없습니다.">새 계약을 등록하면 이곳에 일정이 표시됩니다.</BusinessEmpty>}
    </BusinessSection>
    </div>
    <BusinessVehicles devices={devices} onMap={onMap} onDetail={d => onContracts({ deviceId: d.id })} detailLabel="계약 보기" statusUnknown={!ready}
      availability={d => summary.occupied.has(String(d.id)) ? { label: '임대 중', tone: 'info' } : { label: '미배차', tone: 'good' }}/>
    <p className="business-note">전체 {devices.length}대 · {ready ? `현재 임대 ${summary.occupied.size}대 · 이번 달 정산 ${summary.revenue.toLocaleString()}원` : '임대·정산 정보 확인 필요'}. 차량의 운영 상태와 단말기 통신 상태는 별도로 표시합니다.</p>
  </div>;
}

const st = {
  wrap:    { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  tabBar:  { display: 'flex', gap: 4, padding: '8px 12px 0', borderBottom: '1px solid var(--border)', overflowX: 'auto', flexShrink: 0 },
  tabBtn:  { display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap', transition: 'all .15s' },
  body:    { flex: 1, overflowY: 'auto' },
  card:    { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16 },
  cardTitle: { fontSize: 13, fontWeight: 700, marginBottom: 12, color: 'var(--text)' },
  muted:   { padding: 16, color: 'var(--text-3)', fontSize: 13 },
  vehicleRow: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '10px 12px',
    borderRadius: 10, background: 'var(--surface-2)',
  },
  vehicleIcon: {
    width: 32, height: 32, borderRadius: 8,
    background: 'color-mix(in srgb, var(--primary) 12%, transparent)',
    color: 'var(--primary)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  // (Stage-R1) 다이얼로그/폼 재사용 스타일
  input: {
    display: 'block', width: '100%', padding: '8px 10px', boxSizing: 'border-box',
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 6, color: 'var(--text)', fontSize: 13,
  },
  btnPrimary: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: '8px 14px', background: 'var(--primary)', color: 'white',
    border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700,
  },
  btnGhost: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '6px 10px', fontSize: 11,
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
  },
  modalBackdrop: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 900,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 8,
  },
  modal: {
    background: 'var(--surface)', borderRadius: 14, padding: 16,
    width: '100%', maxWidth: 420, maxHeight: '92vh', overflowY: 'auto',
    display: 'flex', flexDirection: 'column', gap: 10,
    boxSizing: 'border-box',
  },
  modalWide: {
    background: 'var(--surface)', borderRadius: 14, padding: 16,
    width: '100%', maxWidth: 640, maxHeight: '92vh', overflowY: 'auto',
    display: 'flex', flexDirection: 'column', gap: 10,
    boxSizing: 'border-box',
  },
};

// ═══════════════════════════════════════════════════════════════
// (2026-07-28) Stage-R9-a: 임차인 handoff (QR/링크) 발급 다이얼로그.
// ═══════════════════════════════════════════════════════════════
function HandoffTokenDialog({ contract, onClose }) {
  const [purpose, setPurpose] = useState(contract.status === 'draft' ? 'pickup' : 'pickup');
  // (F2-b) useHandoffTokens + issue/revoke mutations. setTick 제거.
  const { data: tokens } = useHandoffTokens(contract.id);
  const issueMut  = useIssueHandoffToken();
  const revokeMut = useRevokeHandoffToken();
  const busy = issueMut.isPending || revokeMut.isPending;

  const activeToken = useMemo(() => {
    if (!tokens) return null;
    const now = Date.now();
    return tokens.find(t => t.purpose === purpose && !t.used_at && !t.revoked_at
      && new Date(t.expires_at).getTime() > now) || null;
  }, [tokens, purpose]);

  const publicOrigin = (typeof window !== 'undefined')
    ? window.location.origin + (window.location.pathname.includes('/gps-tracker/app/') ? '/gps-tracker/app' : '')
    : '';
  const publicUrl = activeToken ? `${publicOrigin}/handoff/${activeToken.token}` : '';

  async function issue() {
    try { await issueMut.mutateAsync({ contractId: contract.id, purpose, expiresHours: 72 }); }
    catch (e) { await alertDialog({ title: '발급 실패', body: e.message, tone: 'danger' }); }
  }
  async function revoke(id) {
    if (!(await confirmDialog({ title: '링크 취소', body: '이 링크를 취소하시겠습니까?', danger: true }))) return;
    try { await revokeMut.mutateAsync({ tokenId: id, contractId: contract.id }); }
    catch (e) { await alertDialog({ title: '취소 실패', body: e.message, tone: 'danger' }); }
  }
  async function copyLink() {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      toast.success({ title: '링크 복사됨', body: '카톡·문자로 임차인에게 전송하세요.' });
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = publicUrl; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy'); ta.remove();
      toast.success({ title: '링크 복사됨', body: '카톡·문자로 임차인에게 전송하세요.' });
    }
  }

  const toneOf = t => t.revoked_at ? 'muted' :
                       t.used_at    ? 'primary' :
                       new Date(t.expires_at).getTime() < Date.now() ? 'muted' : 'success';
  const labelOf = t => t.revoked_at ? '취소' :
                        t.used_at    ? '사용됨' :
                        new Date(t.expires_at).getTime() < Date.now() ? '만료' : '활성';

  return (
    <Modal open onClose={onClose}
      size="md"
      title="임차인 QR / 링크 발급"
      subtitle={`${contract.license_plate || contract.device_name} · ${contract.renter_name}`}
    >
      <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5 }}>
        발급된 링크를 카톡·문자로 전송하면 임차인이 로그인 없이 오도미터 사진 + 서명을 제출합니다.
        제출 시 자동으로 계약이 진행됩니다.
      </div>

      <FormField label="용도">
        <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
          {[
            { v: 'pickup', label: '차량 인수' },
            { v: 'return', label: '차량 반납' },
          ].map(o => (
            <Button key={o.v} onClick={() => setPurpose(o.v)}
              variant={purpose === o.v ? 'primary' : 'ghost'}
              size="sm" full={false}
              style={{ flex: 1 }}
            >{o.label}</Button>
          ))}
        </div>
      </FormField>

      {activeToken ? (
        <div style={{
          padding: 'var(--space-3)', background: 'var(--surface-2)', borderRadius: 'var(--radius-md)',
          display: 'flex', flexDirection: 'column', gap: 'var(--space-2)',
        }}>
          <div style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 700 }}>활성 링크 · 72시간 유효</div>
          <div style={{
            fontSize: 11, color: 'var(--text)',
            background: 'var(--surface)', border: '1px solid var(--border)',
            padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-sm)',
            wordBreak: 'break-all',
          }}>{publicUrl}</div>
          <div style={{ fontSize: 10, color: 'var(--text-3)' }}>
            만료: {new Date(activeToken.expires_at).toLocaleString('ko-KR')}
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
            <Button onClick={copyLink} variant="primary" size="sm" style={{ flex: 2 }}
              icon={<Icon name="copy" size={11} />}>링크 복사</Button>
            <Button onClick={() => revoke(activeToken.id)} variant="ghost" size="sm"
              style={{ color: 'var(--danger)' }}>취소</Button>
          </div>
        </div>
      ) : (
        <Button onClick={issue} busy={busy} variant="primary" full>
          {busy ? '발급 중...' : '링크 발급 (72h)'}
        </Button>
      )}

      {tokens && tokens.length > 0 && (
        <div style={{ marginTop: 'var(--space-1)' }}>
          <div style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 700, marginBottom: 4 }}>발급 이력</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 140, overflowY: 'auto' }}>
            {tokens.map(t => (
              <div key={t.id} style={{
                display: 'flex', gap: 'var(--space-2)', alignItems: 'center', fontSize: 10,
                padding: '4px var(--space-2)', background: 'var(--surface-2)',
                borderRadius: 'var(--radius-xs)',
              }}>
                <Pill tone={toneOf(t)} size="xs">{labelOf(t)}</Pill>
                <span style={{ color: 'var(--text-3)' }}>{t.purpose === 'pickup' ? '인수' : '반납'}</span>
                <span style={{ color: 'var(--text-3)', marginLeft: 'auto' }}>
                  {new Date(t.created_at).toLocaleString('ko-KR', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════
// (2026-07-28) Stage-R6: 임차인 registry — 재방문 인식 + 블랙리스트.
// ═══════════════════════════════════════════════════════════════
function RentersTab() {
  const [q,       setQ]       = useState('');
  const [detail,  setDetail]  = useState(null);   // { phone } | null
  const [blModal, setBlModal] = useState(null);   // { renter } | null

  // (F2-b) useRenters hook. setTick 제거 — blacklist mutation onSuccess 이 자동 invalidate.
  const { data: list, error: qError } = useRenters();
  const error = qError?.message || null;

  const filtered = useMemo(() => {
    if (!list) return null;
    const s = q.trim();
    if (!s) return list;
    return list.filter(r =>
      (r.renter_phone || '').includes(s) ||
      (r.renter_name  || '').includes(s));
  }, [list, q]);

  const totalRevenue = (list || []).reduce((sum, r) => sum + (r.total_revenue || 0), 0);
  const repeatCount  = (list || []).filter(r => r.contracts_count >= 2).length;
  const blacklistedCount = (list || []).filter(r => r.blacklisted).length;

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <StatCardGrid>
        <StatCard icon="user" label="총 임차인"   value={(list || []).length}   unit="명" tone="default" />
        <StatCard icon="refresh" label="재방문"   value={repeatCount}           unit="명" tone={repeatCount > 0 ? 'primary' : 'default'} />
        <StatCard icon="warn" label="블랙리스트"  value={blacklistedCount}      unit="명" tone={blacklistedCount > 0 ? 'danger' : 'default'} />
        <StatCard icon="coin" label="누적 매출"   value={totalRevenue.toLocaleString()} unit="원" tone="primary" />
      </StatCardGrid>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input value={q} onChange={e => setQ(e.target.value)}
          placeholder="이름/전화번호 검색"
          style={{ ...st.input, flex: 1, maxWidth: 320 }} />
      </div>

      {error && <div style={{ ...st.muted, color: 'var(--danger)' }}>{error}</div>}
      {list && list.length === 0 && <div style={st.muted}>등록된 임차인이 없습니다.</div>}

      {filtered && filtered.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 8 }}>
          {filtered.map(r => (
            <RenterCard key={r.renter_phone} r={r}
              onDetail={() => setDetail({ phone: r.renter_phone })}
              onBlacklist={() => setBlModal({ renter: r })} />
          ))}
        </div>
      )}

      {detail && (
        <RenterDetailModal phone={detail.phone}
          onClose={() => setDetail(null)} />
      )}
      {blModal && (
        <BlacklistDialog renter={blModal.renter}
          onClose={() => setBlModal(null)}
          onSaved={() => setBlModal(null)} />
      )}
    </div>
  );
}

function RenterCard({ r, onDetail, onBlacklist }) {
  const returnedRate = r.contracts_count > 0 ? Math.round((r.returned_count / r.contracts_count) * 100) : 0;
  const isRepeat = r.contracts_count >= 2;
  const isProblem = r.overdue_count > 0 || r.late_count > 0;
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 8,
      borderLeft: r.blacklisted
        ? `4px solid var(--${r.blacklist_severity === 'block' ? 'danger' : 'warning'})`
        : '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 800, fontSize: 14 }}>{r.renter_name || '(이름 없음)'}</span>
        {isRepeat && (
          <span style={{
            fontSize: 10, padding: '2px 6px', borderRadius: 999,
            background: 'color-mix(in srgb, var(--primary) 15%, transparent)',
            color: 'var(--primary)', fontWeight: 700,
          }}>재방문 · {r.contracts_count}회</span>
        )}
        {r.blacklisted && (
          <span style={{
            fontSize: 10, padding: '2px 6px', borderRadius: 999,
            background: `color-mix(in srgb, var(--${r.blacklist_severity === 'block' ? 'danger' : 'warning'}) 18%, transparent)`,
            color: `var(--${r.blacklist_severity === 'block' ? 'danger' : 'warning'})`,
            fontWeight: 800,
          }}>{r.blacklist_severity === 'block' ? '⛔ 차단' : '⚠ 경고'}</span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button onClick={onDetail} style={{ ...st.btnGhost, padding: '4px 8px' }} title="상세">
            <Icon name="info" size={11} />
          </button>
          <button onClick={onBlacklist} style={{
            ...st.btnGhost, padding: '4px 8px',
            color: r.blacklisted ? 'var(--danger)' : 'var(--text-2)',
          }} title="블랙리스트 관리">
            <Icon name="warn" size={11} />
          </button>
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{r.renter_phone}</div>
      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-3)', flexWrap: 'wrap' }}>
        <span>이용 {r.contracts_count}회</span>
        <span>· 반납 {r.returned_count} ({returnedRate}%)</span>
        {r.overdue_count > 0 && <span style={{ color: 'var(--danger)', fontWeight: 700 }}>· 연체 {r.overdue_count}</span>}
        {r.late_count > 0 && <span style={{ color: 'var(--warning)', fontWeight: 700 }}>· 지연 {r.late_count}</span>}
      </div>
      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-2)' }}>
        <span>매출 <b style={{ color: 'var(--text)' }}>{(r.total_revenue || 0).toLocaleString()}원</b></span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-3)' }}>
          최근 {new Date(r.last_at).toLocaleDateString('ko-KR')}
        </span>
      </div>
    </div>
  );
}

function RenterDetailModal({ phone, onClose }) {
  // (F2-b) useRenterDetail hook — deduped, focus refetch.
  const { data, error: qError } = useRenterDetail(phone);
  const error = qError?.message || null;
  const s = data?.summary;
  return (
    <Modal open onClose={onClose} size="lg" title="임차인 상세" subtitle={phone}>
        {error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
        {!data && !error && <SkeletonList count={3} itemHeight={48} />}
        {s && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(72px, 1fr))', gap: 8 }}>
              <MiniStat label="이용" value={s.contracts_count} />
              <MiniStat label="반납" value={s.returned_count} />
              <MiniStat label="연체" value={s.overdue_count} tone={s.overdue_count > 0 ? 'danger' : 'default'} />
              <MiniStat label="지연" value={s.late_count} tone={s.late_count > 0 ? 'warning' : 'default'} />
            </div>
            <div style={{
              padding: 10, background: 'var(--surface-2)', borderRadius: 8,
              display: 'flex', justifyContent: 'space-between', fontSize: 13,
            }}>
              <span style={{ color: 'var(--text-2)' }}>누적 매출</span>
              <b style={{ color: 'var(--primary)' }}>{(s.total_revenue || 0).toLocaleString()}원</b>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
              최초 {new Date(s.first_at).toLocaleDateString('ko-KR')} · 최근 {new Date(s.last_at).toLocaleDateString('ko-KR')}
            </div>
            {s.blacklisted && (
              <div style={{
                padding: 10, borderRadius: 8, fontSize: 12,
                background: `color-mix(in srgb, var(--${s.blacklist_severity === 'block' ? 'danger' : 'warning'}) 12%, transparent)`,
                color: `var(--${s.blacklist_severity === 'block' ? 'danger' : 'warning'})`,
                fontWeight: 700,
              }}>
                {s.blacklist_severity === 'block' ? '⛔ 신규 계약 차단' : '⚠ 경고'} — {s.blacklist_reason}
              </div>
            )}

            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-3)', marginTop: 4 }}>계약 이력</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
              {(data.contracts || []).map(c => {
                const stt = RENTAL_STATUS[c.status] || RENTAL_STATUS.draft;
                return (
                  <div key={c.id} style={{
                    padding: '6px 10px', background: 'var(--surface-2)', borderRadius: 6,
                    display: 'flex', gap: 8, alignItems: 'center', fontSize: 11,
                  }}>
                    <span style={{
                      padding: '2px 6px', borderRadius: 999, background: stt.bg, color: stt.color,
                      fontSize: 9, fontWeight: 800,
                    }}>{stt.label}</span>
                    <span style={{ fontWeight: 700 }}>{c.license_plate || c.device_name || `#${c.device_id}`}</span>
                    <span style={{ color: 'var(--text-3)' }}>
                      {new Date(c.starts_at).toLocaleDateString('ko-KR')} ~ {new Date(c.ends_at).toLocaleDateString('ko-KR')}
                    </span>
                    {c.settled_amount_krw != null && (
                      <span style={{ marginLeft: 'auto', color: 'var(--primary)', fontWeight: 700 }}>
                        {c.settled_amount_krw.toLocaleString()}원
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
    </Modal>
  );
}

function MiniStat({ label, value, tone = 'default' }) {
  const color = tone === 'danger' ? 'var(--danger)' : tone === 'warning' ? 'var(--warning)' : 'var(--text)';
  return (
    <div style={{
      padding: 10, background: 'var(--surface-2)', borderRadius: 8,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
    }}>
      <div style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color }}>{value}</div>
    </div>
  );
}

function BlacklistDialog({ renter, onClose, onSaved }) {
  const already = renter.blacklisted;
  const [reason, setReason] = useState(renter.blacklist_reason || '');
  const [severity, setSeverity] = useState(renter.blacklist_severity || 'warn');

  // (F2-b) mutations — onSuccess 이 자동 invalidateQueries.
  const addMut    = useAddBlacklist();
  const removeMut = useRemoveBlacklist();
  const busy = addMut.isPending || removeMut.isPending;

  async function submit() {
    if (!reason.trim()) {
      await alertDialog({ title: '사유 필요', body: '블랙리스트 등록 사유를 입력하세요.', tone: 'danger' });
      return;
    }
    try {
      await addMut.mutateAsync({
        renter_phone: renter.renter_phone,
        renter_name:  renter.renter_name,
        reason:       reason.trim(),
        severity,
      });
      onSaved();
    } catch (e) { await alertDialog({ title: '저장 실패', body: e.message, tone: 'danger' }); }
  }

  async function remove() {
    // remove 시 id 가 필요 — listBlacklist 로 찾아서 삭제.
    try {
      const bl = await api.listBlacklist();
      const hit = (bl || []).find(x => x.renter_phone === renter.renter_phone);
      if (hit) await removeMut.mutateAsync(hit.id);
      onSaved();
    } catch (e) { await alertDialog({ title: '해제 실패', body: e.message, tone: 'danger' }); }
  }

  return (
    <Modal open onClose={onClose} size="sm"
      title={`블랙리스트 ${already ? '수정' : '등록'}`}
      subtitle={`${renter.renter_name || '(이름 없음)'} · ${renter.renter_phone}`}>
        <Labeled label="사유">
          <input value={reason} onChange={e => setReason(e.target.value)}
            placeholder="예: 차량 파손 미보상 · 연체 3회"
            style={st.input} />
        </Labeled>
        <Labeled label="심각도">
          <div style={{ display: 'flex', gap: 6 }}>
            {[
              { v: 'warn',  label: '⚠ 경고 (계약 시 알림)' },
              { v: 'block', label: '⛔ 차단 (신규 계약 불가)' },
            ].map(o => (
              <button key={o.v} onClick={() => setSeverity(o.v)}
                style={{
                  padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)',
                  background: severity === o.v ? 'var(--surface-2)' : 'transparent',
                  color: severity === o.v ? 'var(--text)' : 'var(--text-3)',
                  fontWeight: severity === o.v ? 700 : 500,
                  cursor: 'pointer', flex: 1, fontSize: 11,
                }}>{o.label}</button>
            ))}
          </div>
        </Labeled>
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-1)' }}>
          <Button onClick={onClose} disabled={busy} variant="ghost" style={{ flex: 1 }}>취소</Button>
          {already && (
            <Button onClick={remove} disabled={busy}
              variant="ghost" style={{ color: 'var(--danger)', flex: 1 }}>해제</Button>
          )}
          <Button onClick={submit} busy={busy} variant="primary" style={{ flex: 2 }}>
            {busy ? '저장 중...' : (already ? '수정' : '등록')}
          </Button>
        </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════
// (2026-07-28) Stage-R9-a 확장: owner 계약별 사진 갤러리.
// 오도미터 / 파손 / 연료 사진 조회 · 추가 · 삭제. 각 kind 별로 그룹핑.
// ═══════════════════════════════════════════════════════════════

const PHOTO_KIND_LABEL = {
  pickup_odometer:  '인수 오도미터',
  pickup_damage:    '인수 파손',
  pickup_fuel:      '인수 연료',
  return_odometer:  '반납 오도미터',
  return_damage:    '반납 파손',
  return_fuel:      '반납 연료',
};

function PhotoGalleryModal({ contract, onClose }) {
  // (F2-b) useRentalPhotos + upload/delete mutations. setTick 제거.
  const { data: list, error: qError } = useRentalPhotos(contract.id);
  const uploadMut = useUploadRentalPhoto();
  const deleteMut = useDeleteRentalPhoto();
  const error = qError?.message || null;
  const [uploadKind, setUploadKind] = useState('pickup_damage');
  const [viewer, setViewer] = useState(null);   // { id, kind } | null
  const [viewerUrl, setViewerUrl] = useState(null);
  const fileRef = useRef(null);
  const busy = uploadMut.isPending || deleteMut.isPending;

  useEffect(() => {
    if (!viewer) { setViewerUrl(null); return; }
    let cancelled = false;
    let objectUrl;
    api.fetchRentalPhoto(viewer.id).then(url => {
      if (cancelled) { URL.revokeObjectURL(url); return; }
      objectUrl = url; setViewerUrl(url);
    }).catch(() => {});
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [viewer]);

  async function handleFile(f) {
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) {
      alertDialog({ title: '파일 크기 초과', body: '최대 10MB', tone: 'danger' });
      return;
    }
    try {
      const dataUrl = await compressToJpegDataUrl(f, 1600, 0.8);
      await uploadMut.mutateAsync({ contractId: contract.id, kind: uploadKind, dataUrl });
    } catch (e) {
      alertDialog({ title: '업로드 실패', body: e.message, tone: 'danger' });
    } finally { if (fileRef.current) fileRef.current.value = ''; }
  }

  async function remove(p) {
    if (!(await confirmDialog({ title: '사진 삭제', body: '이 사진을 삭제하시겠습니까?', danger: true }))) return;
    try { await deleteMut.mutateAsync({ photoId: p.id, contractId: contract.id }); }
    catch (e) { await alertDialog({ title: '삭제 실패', body: e.message, tone: 'danger' }); }
  }

  const grouped = useMemo(() => {
    const g = {};
    for (const p of (list || [])) {
      if (!g[p.kind]) g[p.kind] = [];
      g[p.kind].push(p);
    }
    return g;
  }, [list]);

  return (
    <Modal open onClose={onClose} size="lg" title="계약 사진"
      subtitle={`${contract.license_plate || contract.device_name} · ${contract.renter_name}`}>
        <div style={{
          padding: 10, background: 'var(--surface-2)', borderRadius: 8,
          display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)' }}>사진 추가</div>
          <select value={uploadKind} onChange={e => setUploadKind(e.target.value)}
            style={{ ...st.input, width: 'auto', flex: '1 1 140px', minWidth: 120 }}>
            {Object.entries(PHOTO_KIND_LABEL).map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
          <input ref={fileRef} type="file" accept="image/*" capture="environment"
            onChange={e => handleFile(e.target.files?.[0])}
            style={{ display: 'none' }} />
          <button onClick={() => fileRef.current?.click()} disabled={busy} style={{
            ...st.btnPrimary, padding: '8px 14px',
          }}>
            {busy ? '업로드 중...' : '파일 선택 · 촬영'}
          </button>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-3)' }}>
          자동 리사이즈 (1600px, JPEG 0.8) · 저장 후 owner 만 열람.
        </div>

        {error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
        {!list && !error && <div style={st.muted}>로딩 중...</div>}
        {list && list.length === 0 && <div style={st.muted}>등록된 사진 없음.</div>}

        {Object.keys(grouped).map(kind => (
          <div key={kind} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-2)' }}>
              {PHOTO_KIND_LABEL[kind] || kind} <span style={{ color: 'var(--text-3)', fontWeight: 500 }}>· {grouped[kind].length}장</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 6 }}>
              {grouped[kind].map(p => (
                <PhotoThumb key={p.id} photo={p}
                  onOpen={() => setViewer(p)}
                  onDelete={() => remove(p)} />
              ))}
            </div>
          </div>
        ))}

        {viewer && (
          <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 960,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12,
          }} onClick={() => setViewer(null)}>
            <div onClick={e => e.stopPropagation()} style={{ position: 'relative', maxWidth: '95vw', maxHeight: '95vh' }}>
              <button onClick={() => setViewer(null)} style={{
                position: 'absolute', top: 8, right: 8, zIndex: 1,
                background: 'rgba(0,0,0,0.5)', color: '#FFF', border: 'none',
                borderRadius: 6, padding: '6px 10px', cursor: 'pointer',
              }}><Icon name="close" size={13} /></button>
              {viewerUrl ? (
                <img src={viewerUrl} alt={PHOTO_KIND_LABEL[viewer.kind]}
                  style={{ maxWidth: '95vw', maxHeight: '95vh', objectFit: 'contain', borderRadius: 8 }} />
              ) : <div style={{ color: '#FFF' }}>로딩...</div>}
            </div>
          </div>
        )}
    </Modal>
  );
}

function PhotoThumb({ photo, onOpen, onDelete }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let cancelled = false;
    let obj;
    api.fetchRentalPhoto(photo.id).then(u => {
      if (cancelled) { URL.revokeObjectURL(u); return; }
      obj = u; setUrl(u);
    }).catch(() => {});
    return () => { cancelled = true; if (obj) URL.revokeObjectURL(obj); };
  }, [photo.id]);
  return (
    <div style={{ position: 'relative', aspectRatio: '1', borderRadius: 6, overflow: 'hidden', background: 'var(--surface-2)' }}>
      {url ? (
        <img src={url} alt="" onClick={onOpen}
          style={{ width: '100%', height: '100%', objectFit: 'cover', cursor: 'zoom-in', display: 'block' }} />
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-3)', fontSize: 10 }}>...</div>
      )}
      <button onClick={onDelete} style={{
        position: 'absolute', top: 4, right: 4,
        background: 'rgba(239,68,68,0.85)', color: '#FFF',
        border: 'none', borderRadius: 4, padding: '2px 6px',
        fontSize: 10, cursor: 'pointer',
      }}>×</button>
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        background: 'linear-gradient(to top, rgba(0,0,0,0.7), transparent)',
        color: '#FFF', fontSize: 9, padding: '10px 4px 3px', textAlign: 'right',
      }}>{Math.round((photo.size_bytes || 0) / 1024)}KB</div>
    </div>
  );
}

// 파일 → JPEG dataURL (max side 리사이즈 + 압축).
function compressToJpegDataUrl(file, maxSide = 1600, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('파일 읽기 실패'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('이미지 파싱 실패'));
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
