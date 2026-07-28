// (2026-07-28) 렌트카 계정 전용 대시보드 (Stage-2 shell).
// CorporatePanel 과 동일 톤 — shared StatCard + fleet 요약 상단 + 아래 임대 관련
// 목록 자리 (실 데이터는 Stage-3 에서 backend rental_contracts 추가 후 연결).
//
// 지금은 device 만 있으니:
//  · 전체 차량        = devices.length
//  · 임대 가능        = 유휴 (last_event_kind !== 'wake') 차량 수 (임시)
//  · 오늘 반납 예정    = 0 (rental_contracts 없음)
//  · 이번달 임대 매출  = 0 (매출 데이터 없음)
// 임대 계약 실 도입 시 useFleetStats 확장 or 별도 hook.

import React, { useEffect, useMemo, useState, useRef } from 'react';
import Icon from './Icon';
import { api } from '../api';
import { alertDialog, confirmDialog } from './Dialog';
import { StatCard, StatCardGrid } from './shared/StatCard';
import { useFleetStats } from './shared/useFleetStats';
import { panelPropsEqual } from './shared/memoPanel';
import { Modal, FormField, Button, Pill, SkeletonList, toast } from './ui';
import {
  useRentals, useCreateRental, useUpdateRental, useReturnRental, useDeleteRental,
  useRenters, useRenterDetail, useAddBlacklist, useRemoveBlacklist,
  useHandoffTokens, useIssueHandoffToken, useRevokeHandoffToken,
  useRentalPhotos, useUploadRentalPhoto, useDeleteRentalPhoto, qk,
} from '../state';
import { useQueryClient } from '@tanstack/react-query';

function RentcarPanel({ devices }) {
  const [tab, setTab] = useState(() => localStorage.getItem('rentcar_tab') || 'fleet');
  const setTabPersist = (t) => { setTab(t); try { localStorage.setItem('rentcar_tab', t); } catch {} };

  const tabs = [
    { id: 'fleet',    label: '홈',         icon: 'home' },
    { id: 'rentals',  label: '임대 계약',  icon: 'route' },
    { id: 'schedule', label: '반납 일정',  icon: 'clock' },
    { id: 'renters',  label: '임차인',     icon: 'user' },
  ];

  return (
    <div style={st.wrap}>
      <div style={st.tabBar}>
        {tabs.map(t => {
          const on = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTabPersist(t.id)}
              style={{
                ...st.tabBtn,
                color: on ? 'var(--primary)' : 'var(--text-2)',
                background: on ? 'var(--surface-2)' : 'transparent',
                fontWeight: on ? 700 : 500,
                borderBottom: on ? '2px solid var(--primary)' : '2px solid transparent',
              }}>
              <Icon name={t.icon} size={14} />
              {t.label}
            </button>
          );
        })}
      </div>

      <div style={st.body}>
        {tab === 'fleet'    && <FleetTab devices={devices} />}
        {tab === 'rentals'  && <RentalsTab devices={devices} />}
        {tab === 'schedule' && <ScheduleTab devices={devices} />}
        {tab === 'renters'  && <RentersTab />}
      </div>
    </div>
  );
}

// (F3) devices lat/lng 만 바뀌면 재렌더 skip — WS location fix 폭주 대응.
export default React.memo(RentcarPanel, panelPropsEqual);

// ═══════════════════════════════════════════════════════
// (2026-07-28 Stage-R2) 반납 캘린더 — 월 그리드에 계약 표시.
// 각 셀: 그 날 진행중이거나 반납 예정인 계약. 반납 날짜 셀은 강조.
// 셀 클릭 → 그 날 preset 신규 계약. 계약 pill 클릭 → 편집.
// ═══════════════════════════════════════════════════════
function ScheduleTab({ devices }) {
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
  const { data: list = [], isLoading: loading, error: qError } = useRentals(scheduleParams);
  const error = qError?.message || null;

  // 오늘 반납 예정 (표시 월 내 active + ends_at 오늘)
  const todayReturns = useMemo(() => {
    const t = new Date().toISOString().slice(0, 10);
    return list.filter(c =>
      (c.status === 'active' || c.status === 'draft') &&
      (c.ends_at || '').slice(0, 10) === t);
  }, [list]);
  // 표시 월 내 반납 예정 총 건수
  const monthReturns = useMemo(() => {
    return list.filter(c => (c.ends_at || '').slice(0, 7) === ym).length;
  }, [list, ym]);

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <StatCardGrid>
        <StatCard icon="clock"  label="오늘 반납"     value={todayReturns.length} unit="건" tone={todayReturns.length > 0 ? 'primary' : 'default'} />
        <StatCard icon="bar"    label={`${ym} 반납`}  value={monthReturns} unit="건" tone="default" />
        <StatCard icon="route"  label="전체 차량"     value={devices?.length ?? 0} unit="대" tone="default" />
      </StatCardGrid>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="month" value={ym} onChange={e => setYm(e.target.value || ym)}
          style={{ ...st.input, width: 140 }} />
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
          셀 클릭 = 그 날 preset 신규 계약 · 계약 클릭 = 편집
        </span>
        <button onClick={() => setEditing('new')} style={{ marginLeft: 'auto', ...st.btnPrimary }}>
          <Icon name="plus" size={13} /> 새 계약
        </button>
      </div>

      {error && <div style={{ ...st.muted, color: 'var(--danger)' }}>{error}</div>}
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
  const todayStr = new Date().toISOString().slice(0, 10);

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
    const dStr = date.toISOString().slice(0, 10);
    return (list || []).filter(c => {
      const s = new Date(c.starts_at).toISOString().slice(0, 10);
      const e = new Date(c.ends_at  ).toISOString().slice(0, 10);
      return dStr >= s && dStr <= e;
    });
  }
  function isReturnDay(date, c) {
    return date.toISOString().slice(0, 10) === new Date(c.ends_at).toISOString().slice(0, 10);
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
          const dStr = cell.date.toISOString().slice(0, 10);
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
                const s = RENTAL_STATUS[c.status] || RENTAL_STATUS.draft;
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

function RentalsTab({ devices }) {
  const [statusFilter, setStatusFilter] = useState('active');   // active | overdue | returned | all
  const [editing, setEditing] = useState(null);       // null | 'new' | contract
  const [returning, setReturning] = useState(null);   // contract to return
  const [handoff, setHandoff] = useState(null);       // contract for handoff link
  const [photosOf, setPhotosOf] = useState(null);     // contract for photo gallery

  // (F2-b) useRentals hook + useDeleteRental mutation. setTick 제거.
  // params 는 statusFilter 만 useMemo (from/to 는 tick 마다 변하면 캐시 miss 되니 useMemo).
  const rentalParams = useMemo(() => {
    const now = new Date();
    const params = {
      from: new Date(now.getTime() - 30 * 86400_000).toISOString(),
      to:   new Date(now.getTime() + 90 * 86400_000).toISOString(),
    };
    if (statusFilter === 'active')   params.status = ['draft', 'active'];
    else if (statusFilter !== 'all') params.status = [statusFilter];
    return params;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);
  const { data: list, isLoading: loading, error: qError } = useRentals(rentalParams);
  const deleteRental = useDeleteRental();
  const error = qError?.message || null;

  const activeCount   = (list || []).filter(c => c.status === 'active' || c.status === 'draft').length;
  const overdueCount  = (list || []).filter(c => c.status === 'overdue').length;
  const returnedCount = (list || []).filter(c => c.status === 'returned').length;
  const monthRevenue  = useMemo(() => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    return (list || [])
      .filter(c => c.settled_at && new Date(c.settled_at) >= monthStart)
      .reduce((sum, c) => sum + (c.settled_amount_krw || 0), 0);
  }, [list]);

  // 오늘 반납 예정 (active + ends_at 오늘)
  const returnToday = useMemo(() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    return (list || []).filter(c =>
      (c.status === 'active' || c.status === 'draft') &&
      (c.ends_at || '').slice(0, 10) === todayStr).length;
  }, [list]);

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <StatCardGrid>
        <StatCard icon="route"  label="활성 계약"     value={activeCount}   unit="건" tone="success" />
        <StatCard icon="clock"  label="오늘 반납"     value={returnToday}   unit="건" tone={returnToday > 0 ? 'primary' : 'default'} />
        <StatCard icon="warn"   label="연체"          value={overdueCount}  unit="건" tone={overdueCount > 0 ? 'danger' : 'default'} />
        <StatCard icon="coin"   label="이번달 매출"   value={monthRevenue.toLocaleString()} unit="원" tone="primary" />
      </StatCardGrid>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <FilterChip active={statusFilter==='active'}   onClick={() => setStatusFilter('active')}   label="활성"     count={activeCount} tone="success" />
        <FilterChip active={statusFilter==='overdue'}  onClick={() => setStatusFilter('overdue')}  label="연체"     count={overdueCount} tone="warn" />
        <FilterChip active={statusFilter==='returned'} onClick={() => setStatusFilter('returned')} label="반납완료" count={returnedCount} tone="primary" />
        <FilterChip active={statusFilter==='all'}      onClick={() => setStatusFilter('all')}      label="전체"     count={(list || []).length} />
        <button onClick={() => setEditing('new')} style={{
          marginLeft: 'auto', ...st.btnPrimary,
        }}>
          <Icon name="plus" size={13} /> 새 계약
        </button>
      </div>

      {error && <div style={{ ...st.muted, color: 'var(--danger)' }}>{error}</div>}
      {loading && !list && <SkeletonList count={4} itemHeight={80} />}
      {list && list.length === 0 && <div style={st.muted}>계약이 없습니다.</div>}

      {list && list.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 8 }}>
          {list.map(c => <RentalCard key={c.id} c={c}
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
  const s = RENTAL_STATUS[c.status] || RENTAL_STATUS.draft;
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

function RentalDialog({ init, devices, presetDate, onClose, onSaved }) {
  // presetDate 'YYYY-MM-DD' 있으면 그 날 09:00 시작, 다음날 09:00 종료. 없으면 오늘 기준.
  const defaultStart = () => {
    const d = presetDate ? new Date(`${presetDate}T09:00:00`) : new Date();
    d.setHours(9, 0, 0, 0); return d;
  };
  const defaultEnd = () => {
    const d = new Date(defaultStart().getTime() + 86400_000);
    return d;
  };
  const [deviceId, setDeviceId] = useState(init?.device_id ?? devices?.[0]?.id ?? '');
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
    <Modal open onClose={onClose} size="lg" title={init?.id ? '계약 편집' : '새 임대 계약'}>
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
          임차인 (PIPA 최소화)
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
          <Labeled label="시작"><input type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)} style={st.input} /></Labeled>
          <Labeled label="종료"><input type="datetime-local" value={endsAt}   onChange={e => setEndsAt(e.target.value)}   style={st.input} /></Labeled>
          <Labeled label="인수 오도미터 (km)"><input type="number" value={pickupOd} onChange={e => setPickupOd(e.target.value)} style={st.input} /></Labeled>
        </div>

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

        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-1)' }}>
          <Button onClick={onClose} disabled={busy} variant="ghost" size="md" style={{ flex: 1 }}>취소</Button>
          <Button onClick={save} busy={busy} variant="primary" size="lg" style={{ flex: 2 }}>
            {busy ? '저장 중...' : '저장'}
          </Button>
        </div>
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
function FleetTab({ devices }) {
  const s = useFleetStats(devices);
  const fmt = (n) => (n == null ? '–' : n.toLocaleString());

  const [rentals, setRentals] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const now = new Date();
    // 넓게 잡아 활성 + 최근 반납 + 예정 다 커버.
    api.listRentals({
      from: new Date(now.getTime() - 60 * 86400_000).toISOString(),
      to:   new Date(now.getTime() + 90 * 86400_000).toISOString(),
    }).then(rs => { if (!cancelled) { setRentals(rs || []); setLoading(false); } })
      .catch(()  => { if (!cancelled) { setRentals([]);    setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const now = Date.now();
  const list = rentals || [];
  const activeRentals = list.filter(c => c.status === 'active' || c.status === 'draft');
  const overdue       = list.filter(c => c.status === 'overdue');
  const returnedList  = list.filter(c => c.status === 'returned' && c.settled_at);

  // 오늘 반납 (active + ends_at 오늘 안)
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayEnd   = new Date(); todayEnd.setHours(23,59,59,999);
  const returnToday = activeRentals.filter(c => {
    const e = new Date(c.ends_at);
    return e >= todayStart && e <= todayEnd;
  });
  const returnThisWeek = activeRentals.filter(c => {
    const e = new Date(c.ends_at).getTime();
    return e >= now && e <= now + 7 * 86400_000;
  });

  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
  const monthRevenue = returnedList
    .filter(c => new Date(c.settled_at) >= monthStart)
    .reduce((sum, c) => sum + (c.settled_amount_krw || 0), 0);

  // 유휴 = fleet 총차량 - 임대중 차량 수 (device_id 기준 unique)
  const rentedDeviceIds = new Set(activeRentals.map(c => c.device_id));
  const rentedCount = rentedDeviceIds.size;
  const idleCount = Math.max(0, s.totalCount - rentedCount);

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <StatCardGrid>
        <StatCard icon="list"   label="전체 차량"     value={fmt(s.totalCount)}   unit="대" tone="default" loading={s.loading} />
        <StatCard icon="route"  label="임대 중"       value={fmt(rentedCount)}    unit="대" tone="success" loading={loading || s.loading} />
        <StatCard icon="mapPin" label="유휴"          value={fmt(idleCount)}      unit="대" tone="primary" loading={loading || s.loading} />
        <StatCard icon="clock"  label="오늘 반납"     value={fmt(returnToday.length)} unit="건" tone={returnToday.length > 0 ? 'primary' : 'default'} loading={loading} />
        <StatCard icon="warn"   label="연체"          value={fmt(overdue.length)} unit="건" tone={overdue.length > 0 ? 'danger' : 'default'} loading={loading} />
        <StatCard icon="bar"    label="이번주 반납"   value={fmt(returnThisWeek.length)} unit="건" tone="default" loading={loading} />
        <StatCard icon="coin"   label="이번달 매출"   value={fmt(monthRevenue)}   unit="원" tone="primary" loading={loading} />
        <StatCard icon="check"  label="이번달 주행"   value={fmt(s.monthKm)}      unit="km" tone="default" loading={s.loading} />
      </StatCardGrid>

      {/* 반납 임박 (오늘·내일 위주) */}
      {returnThisWeek.length > 0 && (
        <ReturnsUpcoming rentals={returnThisWeek} now={now} />
      )}

      {/* 연체 강조 */}
      {overdue.length > 0 && (
        <OverdueList rentals={overdue} now={now} />
      )}

      {/* 활성 계약 요약 */}
      <ActiveRentalsMini rentals={activeRentals} />

      {/* 차량 목록 (기존 유지) */}
      <FleetTable devices={devices} />

      {/* 최근 반납 */}
      {returnedList.length > 0 && (
        <RecentReturns rentals={returnedList.slice().sort((a,b) => new Date(b.settled_at) - new Date(a.settled_at)).slice(0, 5)} />
      )}
    </div>
  );
}

// ── R8 홈 서브컴포넌트 ─────────────────────────────
function ReturnsUpcoming({ rentals, now }) {
  const sorted = rentals.slice().sort((a, b) => new Date(a.ends_at) - new Date(b.ends_at));
  return (
    <div style={st.card}>
      <div style={{ ...st.cardTitle, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name="clock" size={13} style={{ color: 'var(--primary)' }} />
        반납 임박 <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 500 }}>· 7일 이내</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {sorted.map(c => {
          const endMs = new Date(c.ends_at).getTime();
          const diff = endMs - now;
          const hours = Math.round(diff / 3600_000);
          const days  = Math.round(diff / 86400_000);
          const urgency = hours <= 24 ? 'danger' : hours <= 72 ? 'warning' : 'text-2';
          const label = hours <= 0 ? '오늘 반납' : hours <= 24 ? `${hours}시간 후` : `${days}일 후`;
          return (
            <div key={c.id} style={{
              display: 'flex', gap: 10, alignItems: 'center',
              padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 8,
              borderLeft: `3px solid var(--${urgency})`,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)' }}>
                  {c.license_plate || c.device_name || `#${c.device_id}`}
                  <span style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 500, marginLeft: 6 }}>
                    · {c.renter_name}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                  {new Date(c.ends_at).toLocaleString('ko-KR', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })}
                  {c.renter_phone && ` · ${c.renter_phone}`}
                </div>
              </div>
              <span style={{
                fontSize: 11, fontWeight: 800,
                color: `var(--${urgency})`,
                padding: '4px 10px', borderRadius: 999,
                background: `color-mix(in srgb, var(--${urgency}) 15%, transparent)`,
              }}>{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OverdueList({ rentals, now }) {
  return (
    <div style={{ ...st.card, borderLeft: '3px solid var(--danger)' }}>
      <div style={{ ...st.cardTitle, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--danger)' }}>
        <Icon name="warn" size={13} style={{ color: 'var(--danger)' }} />
        연체 계약
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rentals.map(c => {
          const days = Math.round((now - new Date(c.ends_at).getTime()) / 86400_000);
          return (
            <div key={c.id} style={{
              display: 'flex', gap: 10, alignItems: 'center',
              padding: '8px 10px', background: 'color-mix(in srgb, var(--danger) 8%, transparent)', borderRadius: 8,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)' }}>
                  {c.license_plate || c.device_name || `#${c.device_id}`}
                  <span style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 500, marginLeft: 6 }}>· {c.renter_name}</span>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                  {c.renter_phone || '연락처 없음'} · 계약 종료 {new Date(c.ends_at).toLocaleDateString('ko-KR')}
                </div>
              </div>
              <span style={{
                fontSize: 11, fontWeight: 800, color: 'var(--danger)',
                padding: '4px 10px', borderRadius: 999,
                background: 'color-mix(in srgb, var(--danger) 20%, transparent)',
              }}>{days}일 경과</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActiveRentalsMini({ rentals }) {
  if (!rentals.length) return null;
  return (
    <div style={st.card}>
      <div style={{ ...st.cardTitle, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name="route" size={13} style={{ color: 'var(--accent)' }} />
        임대 중 <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 500 }}>· {rentals.length}건</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 6 }}>
        {rentals.map(c => (
          <div key={c.id} style={{
            padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 8,
            display: 'flex', flexDirection: 'column', gap: 3,
          }}>
            <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--text)' }}>
              {c.license_plate || c.device_name || `#${c.device_id}`}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-2)' }}>{c.renter_name}</div>
            <div style={{ fontSize: 10, color: 'var(--text-3)' }}>
              ~ {new Date(c.ends_at).toLocaleDateString('ko-KR', { month:'2-digit', day:'2-digit' })}
              {' · '}
              {(c.rate_amount_krw || 0).toLocaleString()}원/{RATE_TYPE_LABEL[c.rate_type] || c.rate_type}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RecentReturns({ rentals }) {
  return (
    <div style={st.card}>
      <div style={{ ...st.cardTitle, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name="check" size={13} style={{ color: 'var(--primary)' }} />
        최근 반납 <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 500 }}>· {rentals.length}건</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rentals.map(c => (
          <div key={c.id} style={{
            display: 'flex', gap: 10, alignItems: 'center',
            padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 8,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--text)' }}>
                {c.license_plate || c.device_name || `#${c.device_id}`}
                <span style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 500, marginLeft: 6 }}>· {c.renter_name}</span>
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                {new Date(c.settled_at).toLocaleString('ko-KR', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })}
                {c.refund_krw != null && c.deposit_krw > 0 && (
                  <span style={{
                    marginLeft: 6,
                    color: c.refund_krw >= 0 ? 'var(--accent)' : 'var(--danger)',
                    fontWeight: 700,
                  }}>
                    · {c.refund_krw >= 0 ? '환급' : '추가청구'} {Math.abs(c.refund_krw).toLocaleString()}원
                  </span>
                )}
              </div>
            </div>
            <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--primary)' }}>
              {(c.settled_amount_krw || 0).toLocaleString()}원
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// 차량 리스트 — 상태 뱃지 (운행중/주차/오프라인) + 마지막 위치 요약.
// 첨부 이미지 스타일: 아이콘 + 차량명 + 상태 뱃지 + 부가 정보 우측.
function FleetTable({ devices }) {
  const rows = useMemo(() => (devices || []).map(d => ({
    id: d.id,
    label: d.display_name || d.device_uid,
    state: rentcarState(d),
    lastLat: d.last_lat, lastLng: d.last_lng,
    lastFixAt: d.last_fix_at,
  })), [devices]);

  if (!rows.length) return <div style={st.muted}>차량이 없습니다.</div>;

  return (
    <div style={st.card}>
      <div style={st.cardTitle}>차량 목록</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map(r => (
          <div key={r.id} style={st.vehicleRow}>
            <div style={st.vehicleIcon}><Icon name="mapPin" size={16} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{r.label}</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                {r.lastFixAt ? formatAge(r.lastFixAt) : '위치 미확인'}
              </div>
            </div>
            <StateBadge state={r.state} />
          </div>
        ))}
      </div>
    </div>
  );
}

function StateBadge({ state }) {
  const map = {
    active:  { color: 'var(--accent)',  bg: 'color-mix(in srgb, var(--accent) 15%, transparent)',  label: '운행중' },
    idle:    { color: 'var(--text-2)',  bg: 'var(--surface-2)',                                    label: '유휴' },
    offline: { color: 'var(--text-3)',  bg: 'var(--surface-2)',                                    label: '오프라인' },
  };
  const m = map[state] || map.offline;
  return (
    <span style={{
      fontSize: 11, fontWeight: 700,
      padding: '4px 10px', borderRadius: 999,
      color: m.color, background: m.bg,
      flexShrink: 0,
    }}>
      {m.label}
    </span>
  );
}

// 렌트카 관점 상태 파생 — last_event_kind='wake' 이면 운행중.
// last_fix_at 기준 30분+ 없으면 offline. 그 외 idle.
function rentcarState(d) {
  if (d.last_event_kind === 'wake') return 'active';
  if (!d.last_fix_at) return 'offline';
  const age = Date.now() - new Date(d.last_fix_at).getTime();
  if (age > 30 * 60 * 1000) return 'offline';
  return 'idle';
}

function formatAge(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return '방금';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const d = Math.floor(hr / 24);
  return `${d}일 전`;
}

function PlaceholderTab({ title, hint }) {
  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', textAlign: 'center' }}>
      <div style={{ width: 48, height: 48, borderRadius: 12, background: 'var(--surface-2)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)' }}>
        <Icon name="clock" size={22} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{title}</div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', maxWidth: 360, lineHeight: 1.6 }}>{hint}</div>
    </div>
  );
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
