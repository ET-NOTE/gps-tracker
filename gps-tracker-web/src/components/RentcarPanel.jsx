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

import { useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import { api } from '../api';
import { alertDialog, confirmDialog } from './Dialog';
import { StatCard, StatCardGrid } from './shared/StatCard';
import { useFleetStats } from './shared/useFleetStats';

export default function RentcarPanel({ devices }) {
  const [tab, setTab] = useState(() => localStorage.getItem('rentcar_tab') || 'fleet');
  const setTabPersist = (t) => { setTab(t); try { localStorage.setItem('rentcar_tab', t); } catch {} };

  const tabs = [
    { id: 'fleet',    label: '차량 현황', icon: 'list' },
    { id: 'rentals',  label: '임대 계약', icon: 'route' },
    { id: 'schedule', label: '반납 일정', icon: 'clock' },
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
        {tab === 'schedule' && <PlaceholderTab title="반납 일정" hint="캘린더 뷰는 다음 라운드 (Stage-R2) 에서 예약 캘린더 컴포넌트 재사용 예정." />}
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
  const [list, setList]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [statusFilter, setStatusFilter] = useState('active');   // active | overdue | returned | all
  const [editing, setEditing] = useState(null);       // null | 'new' | contract
  const [returning, setReturning] = useState(null);   // contract to return
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    const now = new Date();
    const params = {
      from: new Date(now.getTime() - 30 * 86400_000).toISOString(),
      to:   new Date(now.getTime() + 90 * 86400_000).toISOString(),
    };
    if (statusFilter === 'active')   params.status = ['draft', 'active'];
    else if (statusFilter !== 'all') params.status = [statusFilter];
    api.listRentals(params).then(rs => {
      if (cancelled) return;
      setList(rs || []); setLoading(false);
    }).catch(e => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [statusFilter, tick]);

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
      {loading && !list && <div style={st.muted}>계약 로딩 중...</div>}
      {list && list.length === 0 && <div style={st.muted}>계약이 없습니다.</div>}

      {list && list.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 8 }}>
          {list.map(c => <RentalCard key={c.id} c={c}
            onEdit={() => setEditing(c)}
            onReturn={() => setReturning(c)}
            onDelete={async () => {
              const ok = await confirmDialog({ title: '계약 삭제', body: '삭제하시겠습니까?', danger: true });
              if (!ok) return;
              try { await api.deleteRental(c.id); setTick(t => t + 1); }
              catch (e) { await alertDialog({ title: '삭제 실패', body: e.message, tone: 'danger' }); }
            }} />)}
        </div>
      )}

      {editing && (
        <RentalDialog init={editing === 'new' ? null : editing} devices={devices}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); setTick(t => t + 1); }} />
      )}
      {returning && (
        <ReturnDialog contract={returning}
          onClose={() => setReturning(null)}
          onDone={() => { setReturning(null); setTick(t => t + 1); }} />
      )}
    </div>
  );
}

function RentalCard({ c, onEdit, onReturn, onDelete }) {
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
            <button onClick={onReturn} style={{ ...st.btnPrimary, padding: '4px 10px', fontSize: 11 }} title="반납 처리">
              반납
            </button>
          )}
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
        <div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 700 }}>
          정산 <span style={{ color: 'var(--primary)' }}>{c.settled_amount_krw.toLocaleString()}원</span>
          {c.settled_at && <span style={{ fontSize: 10, color: 'var(--text-3)', marginLeft: 6 }}>
            · {new Date(c.settled_at).toLocaleDateString('ko-KR')}
          </span>}
        </div>
      )}
    </div>
  );
}

// datetime-local 헬퍼
function isoToLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localToIso(v) { return v ? new Date(v).toISOString() : null; }

function RentalDialog({ init, devices, onClose, onSaved }) {
  const defaultStart = () => {
    const d = new Date(); d.setHours(9, 0, 0, 0); return d;
  };
  const defaultEnd = () => {
    const d = new Date(); d.setHours(9, 0, 0, 0); d.setDate(d.getDate() + 1); return d;
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
  const [busy,         setBusy]         = useState(false);

  async function save() {
    if (!deviceId) { alertDialog({ title: '차량 선택 필요', body: '', tone: 'danger' }); return; }
    if (!renterName.trim()) { alertDialog({ title: '임차인 이름 필요', body: '', tone: 'danger' }); return; }
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
    setBusy(true);
    try {
      if (init?.id) await api.updateRental(init.id, body);
      else          await api.createRental(body);
      onSaved();
    } catch (e) {
      alertDialog({ title: '저장 실패', body: e.message, tone: 'danger' });
    } finally { setBusy(false); }
  }

  return (
    <div style={st.modalBackdrop} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={st.modalWide}>
        <div style={{ fontSize: 15, fontWeight: 800 }}>
          {init?.id ? '계약 편집' : '새 임대 계약'}
        </div>

        {/* 차량 + 상태 */}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8 }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          <Labeled label="이름 *"><input value={renterName} onChange={e => setRenterName(e.target.value)} style={st.input} /></Labeled>
          <Labeled label="연락처"><input value={renterPhone} onChange={e => setRenterPhone(e.target.value)} placeholder="010-..." style={st.input} /></Labeled>
          <Labeled label="신분증 뒤 4자리"><input value={idLast4} maxLength={4} onChange={e => setIdLast4(e.target.value.replace(/\D/g, ''))} placeholder="1234" style={st.input} /></Labeled>
        </div>

        {/* 기간 + 인수 오도미터 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          <Labeled label="시작"><input type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)} style={st.input} /></Labeled>
          <Labeled label="종료"><input type="datetime-local" value={endsAt}   onChange={e => setEndsAt(e.target.value)}   style={st.input} /></Labeled>
          <Labeled label="인수 오도미터 (km)"><input type="number" value={pickupOd} onChange={e => setPickupOd(e.target.value)} style={st.input} /></Labeled>
        </div>

        {/* 요금 */}
        <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          요금
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Labeled label="인수 장소"><input value={pickupLoc} onChange={e => setPickupLoc(e.target.value)} style={st.input} /></Labeled>
          <Labeled label="반납 장소"><input value={returnLoc} onChange={e => setReturnLoc(e.target.value)} style={st.input} /></Labeled>
        </div>
        <Labeled label="메모"><input value={note} onChange={e => setNote(e.target.value)} style={st.input} /></Labeled>

        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button onClick={onClose} disabled={busy} style={{ ...st.btnGhost, flex: 1 }}>취소</button>
          <button onClick={save} disabled={busy} style={{ ...st.btnPrimary, flex: 2, padding: '12px' }}>
            {busy ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReturnDialog({ contract, onClose, onDone }) {
  const [odometer, setOdometer] = useState(contract.return_odometer_km ?? '');
  const [location, setLocation] = useState(contract.return_location ?? '');
  const [extraFee, setExtraFee] = useState('');
  const [note,     setNote]     = useState('');
  const [busy,     setBusy]     = useState(false);

  const dur = Math.max(1, Math.ceil((new Date(contract.ends_at) - new Date(contract.starts_at)) / 3600_000 / 24));
  const baseEstimate = contract.rate_type === 'daily' ? dur * contract.rate_amount_krw
    : contract.rate_type === 'monthly' ? Math.ceil(dur / 30) * contract.rate_amount_krw
    : Math.ceil(dur * 24) * contract.rate_amount_krw;

  async function submit() {
    setBusy(true);
    try {
      await api.returnRental(contract.id, {
        return_odometer_km: odometer === '' ? null : Number(odometer),
        return_location:    location.trim() || null,
        extra_fee_krw:      extraFee === '' ? null : Number(extraFee),
        note:               note.trim() || null,
      });
      onDone();
    } catch (e) {
      alertDialog({ title: '반납 실패', body: e.message, tone: 'danger' });
    } finally { setBusy(false); }
  }

  return (
    <div style={st.modalBackdrop} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={st.modal}>
        <div style={{ fontSize: 15, fontWeight: 800 }}>반납 처리</div>
        <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
          {contract.license_plate || contract.device_name} · {contract.renter_name}
        </div>
        <div style={{
          padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 8,
          fontSize: 12, color: 'var(--text-2)',
        }}>
          <div>계약 기본금 예상: <b>{baseEstimate.toLocaleString()}원</b> ({dur}일 × {contract.rate_amount_krw.toLocaleString()})</div>
          {contract.deposit_krw > 0 && <div>보증금: {contract.deposit_krw.toLocaleString()}원 (별도 반환)</div>}
        </div>

        <Labeled label="반납 오도미터 (km)">
          <input type="number" value={odometer} onChange={e => setOdometer(e.target.value)} placeholder="예: 12345" style={st.input} />
        </Labeled>
        <Labeled label="반납 장소">
          <input value={location} onChange={e => setLocation(e.target.value)} style={st.input} />
        </Labeled>
        <Labeled label="추가비 (청소·연료 등) 원">
          <input type="number" value={extraFee} onChange={e => setExtraFee(e.target.value)} placeholder="0" style={st.input} />
        </Labeled>
        <Labeled label="메모"><input value={note} onChange={e => setNote(e.target.value)} style={st.input} /></Labeled>

        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
          저장 시 정산액 = 기본금 + 초과 km 요금 + 추가비. status → returned.
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button onClick={onClose} disabled={busy} style={{ ...st.btnGhost, flex: 1 }}>취소</button>
          <button onClick={submit} disabled={busy} style={{ ...st.btnPrimary, flex: 2, padding: '12px' }}>
            {busy ? '반납 처리 중...' : '반납 · 정산'}
          </button>
        </div>
      </div>
    </div>
  );
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

function FleetTab({ devices }) {
  const s = useFleetStats(devices);
  const fmt = (n) => (n == null ? '–' : n.toLocaleString());
  // 렌트카 관점 임시 파생 지표 (실 데이터 도입 전):
  //  · 임대 가능 = 유휴 (전체 - 운행중). 임대 계약 도입 시 rental_contracts 로 대체.
  const idleCount = Math.max(0, s.totalCount - s.activeCount);

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <StatCardGrid>
        <StatCard icon="list"   label="전체 차량"     value={fmt(s.totalCount)}  unit="대"  tone="default" loading={s.loading} />
        <StatCard icon="route"  label="운행 중"       value={fmt(s.activeCount)} unit="대"  tone="success" loading={s.loading} />
        <StatCard icon="mapPin" label="임대 가능"     value={fmt(idleCount)}     unit="대"  tone="primary" loading={s.loading}
          hint="유휴 차량 (실 임대 계약 관리는 준비 중)" />
        <StatCard icon="bar"    label="이번달 주행"   value={fmt(s.monthKm)}     unit="km"  tone="default" loading={s.loading} />
      </StatCardGrid>

      <FleetTable devices={devices} />
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
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
  },
  modal: {
    background: 'var(--surface)', borderRadius: 14, padding: 20,
    width: '100%', maxWidth: 420, maxHeight: '90vh', overflowY: 'auto',
    display: 'flex', flexDirection: 'column', gap: 12,
  },
  modalWide: {
    background: 'var(--surface)', borderRadius: 14, padding: 20,
    width: '100%', maxWidth: 640, maxHeight: '90vh', overflowY: 'auto',
    display: 'flex', flexDirection: 'column', gap: 12,
  },
};
