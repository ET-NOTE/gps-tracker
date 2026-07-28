// 법인차 운영 패널 — 4개 서브탭: 회사정보 / 직원 / 운행 리포트 / 구독.
// 운행 리포트는 디바이스 + 날짜 범위 선택 → 운행 목록 + 주석 편집 + 인쇄.
//
// 인쇄: 브라우저 window.print() 호출. @media print 로 nav/사이드 다 숨기고 리포트만.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import Icon from './Icon';
import { confirmDialog, alertDialog } from './Dialog';
import { StatCard, StatCardGrid } from './shared/StatCard';
import { useFleetStats } from './shared/useFleetStats';

const PURPOSE_LABEL = {
  commute:     '출퇴근',
  business:    '업무',
  other:       '기타',
  unspecified: '미지정',
};

export default function CorporatePanel({ devices }) {
  const [tab, setTab] = useState(() => localStorage.getItem('corporate_tab') || 'report');
  const setTabPersist = (t) => { setTab(t); try { localStorage.setItem('corporate_tab', t); } catch {} };

  const [sub, setSub] = useState(null);

  useEffect(() => {
    api.getCorporateSubscription().then(setSub).catch(() => {});
  }, []);

  const tabs = [
    { id: 'report',       label: '운행 리포트', icon: 'route' },
    { id: 'monthly',      label: '월간 리포트', icon: 'bar' },   // (2026-07-28) Stage-3A
    { id: 'vehicles',     label: '차량 관리',   icon: 'list' },  // (2026-07-28) Stage-4C-1
    { id: 'reservations', label: '차량 예약',   icon: 'clock' }, // (2026-07-28) Stage-4F-1
    { id: 'staff',        label: '직원',       icon: 'user' },
    { id: 'info',         label: '회사 정보',   icon: 'list' },
    { id: 'sub',          label: '구독',       icon: 'coin' },
  ];

  return (
    <div style={st.wrap}>
      <div style={st.tabBar} className="no-print">
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
        {tab === 'report'       && <ReportTab devices={devices} sub={sub} onSubChange={setSub} />}
        {tab === 'monthly'      && <MonthlyReportTab devices={devices} sub={sub} />}
        {tab === 'vehicles'     && <VehiclesTab devices={devices} />}
        {tab === 'reservations' && <ReservationsTab devices={devices} />}
        {tab === 'staff'        && <StaffTab />}
        {tab === 'info'         && <InfoTab />}
        {tab === 'sub'          && <SubTab sub={sub} onChange={setSub} />}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 회사 정보 — 국세청 운행기록부 헤더 정보. (2026-07-28 재디자인)
// 국세청 양식 (별지 제73호 서식) 헤더 필수: 사업자번호 · 상호 · 대표자.
// ════════════════════════════════════════════════════════
function InfoTab() {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.getCorporateInfo().then(setInfo).catch(() => {}); }, []);

  async function save() {
    setBusy(true);
    try {
      const r = await api.putCorporateInfo({
        business_number: info.business_number || null,
        company_name:    info.company_name    || null,
        address:         info.address         || null,
        representative:  info.representative   || null,
      });
      setInfo(r);
      await alertDialog({ title: '저장 완료', tone: 'success', body: '운행기록부 헤더에 반영됩니다.' });
    } catch (e) { await alertDialog({ title: '저장 실패', body: e.message, tone: 'danger' }); }
    finally { setBusy(false); }
  }

  if (!info) return <div style={st.muted}>로딩...</div>;
  const set = (k, v) => setInfo(prev => ({ ...prev, [k]: v }));
  const required = ['business_number', 'company_name', 'representative'];
  const missing = required.filter(k => !info[k]);
  const complete = missing.length === 0;

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 안내 배너 — 국세청 양식 매핑 안내 */}
      <div style={{
        background: complete
          ? 'color-mix(in srgb, var(--accent) 8%, transparent)'
          : 'color-mix(in srgb, var(--warning) 10%, transparent)',
        border: '1px solid var(--border)', borderRadius: 12,
        padding: 14, display: 'flex', gap: 12, alignItems: 'flex-start',
      }}>
        <div style={{
          width: 30, height: 30, borderRadius: 10,
          background: complete ? 'var(--accent)' : 'var(--warning)',
          color: 'var(--primary-fg)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Icon name={complete ? 'target' : 'warn'} size={16} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
            {complete ? '운행기록부 헤더 준비 완료' : `필수 정보 ${missing.length}개 남음`}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4, lineHeight: 1.5 }}>
            국세청 별지 제73호 (업무용승용차 운행기록부) 서식 헤더에 사용됩니다.
            사업자번호·상호·대표자 3개는 필수 (경비 인정 근거).
          </div>
        </div>
      </div>

      <div style={st.sectionCard}>
        <div style={st.sectionCardHeader}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="list" size={14} />
            <span>회사 정보</span>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, padding: 16 }}>
          <TrendyField label="사업자번호" required value={info.business_number || ''}
            placeholder="000-00-00000" onChange={v => set('business_number', v)} />
          <TrendyField label="상호 (회사명)" required value={info.company_name || ''}
            placeholder="○○ 주식회사" onChange={v => set('company_name', v)} />
          <TrendyField label="대표자" required value={info.representative || ''}
            placeholder="홍길동" onChange={v => set('representative', v)} />
          <TrendyField label="주소" value={info.address || ''}
            placeholder="서울특별시 ..." onChange={v => set('address', v)} />
        </div>
        <div style={{ padding: '0 16px 16px', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={save} disabled={busy} style={st.btnPrimary}>
            {busy ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}

// 트렌디 필드 — 라벨 우측에 필수 뱃지, 인풋에 hover 효과. 스타일은 st.input 재사용.
function TrendyField({ label, required, value, onChange, placeholder }) {
  return (
    <div>
      <div style={{
        fontSize: 11, fontWeight: 600, marginBottom: 6,
        display: 'flex', alignItems: 'center', gap: 6,
        color: 'var(--text-2)',
      }}>
        <span>{label}</span>
        {required && (
          <span style={{
            fontSize: 9, padding: '2px 6px', borderRadius: 4,
            background: 'color-mix(in srgb, var(--danger) 15%, transparent)',
            color: 'var(--danger)', fontWeight: 700,
          }}>필수</span>
        )}
      </div>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={st.input} />
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 직원 — 운전자 후보. (2026-07-28 재디자인 — 카드형 + stat + 검색 + 접힘 폼)
// ════════════════════════════════════════════════════════
function StaffTab() {
  const [list, setList] = useState(null);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    try { setList(await api.listStaff()); } catch {}
  }
  useEffect(() => { load(); }, []);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.createStaff({ name: name.trim(), role: role || null, phone: phone || null });
      setName(''); setRole(''); setPhone(''); setAdding(false);
      load();
    } catch (e) { await alertDialog({ title: '실패', body: e.message, tone: 'danger' }); }
    finally { setBusy(false); }
  }

  async function toggle(s) {
    try {
      await api.updateStaff(s.id, { name: s.name, role: s.role, phone: s.phone, active: !s.active });
      load();
    } catch (e) { await alertDialog({ title: '실패', body: e.message, tone: 'danger' }); }
  }

  async function remove(s) {
    const ok = await confirmDialog({
      title: '직원 비활성화',
      body: `${s.name} — 비활성화 합니다. 과거 운행일지 기록은 유지됩니다.`,
      danger: true,
    });
    if (!ok) return;
    try { await api.removeStaff(s.id); load(); }
    catch (e) { await alertDialog({ title: '실패', body: e.message, tone: 'danger' }); }
  }

  const totalCount    = list?.length ?? 0;
  const activeCount   = list?.filter(s => s.active).length ?? 0;
  const inactiveCount = totalCount - activeCount;
  const filtered = useMemo(() => {
    if (!list) return [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(s =>
      (s.name || '').toLowerCase().includes(q) ||
      (s.role || '').toLowerCase().includes(q) ||
      (s.phone || '').toLowerCase().includes(q));
  }, [list, query]);

  if (!list) return <div style={st.muted}>로딩...</div>;

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <StatCardGrid>
        <StatCard icon="user" label="전체 직원" value={totalCount}    unit="명" tone="default" />
        <StatCard icon="user" label="활성"     value={activeCount}    unit="명" tone="success" />
        <StatCard icon="user" label="비활성"   value={inactiveCount}  unit="명" tone="default" />
      </StatCardGrid>

      {/* 검색 + 추가 버튼 나란히 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <input value={query} onChange={e => setQuery(e.target.value)}
            placeholder="이름 · 역할 · 연락처 검색"
            style={{ ...st.input, paddingLeft: 34 }} />
          <div style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }}>
            <Icon name="filter" size={14} />
          </div>
        </div>
        <button onClick={() => setAdding(v => !v)} style={{
          ...st.btnPrimary, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <Icon name={adding ? 'close' : 'plus'} size={13} />
          {adding ? '닫기' : '직원 추가'}
        </button>
      </div>

      {/* 접힘 추가 폼 */}
      {adding && (
        <div style={st.sectionCard}>
          <div style={st.sectionCardHeader}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="plus" size={14} />
              <span>새 직원</span>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, padding: 16 }}>
            <TrendyField label="이름"   required value={name}  onChange={setName}  placeholder="이름" />
            <TrendyField label="역할"            value={role}  onChange={setRole}  placeholder="영업 / 사무 / 배차 ..." />
            <TrendyField label="연락처"          value={phone} onChange={setPhone} placeholder="010-..." />
          </div>
          <div style={{ padding: '0 16px 16px', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={() => { setAdding(false); setName(''); setRole(''); setPhone(''); }}
              style={st.btnGhost}>취소</button>
            <button onClick={add} disabled={busy || !name.trim()} style={st.btnPrimary}>
              {busy ? '...' : '추가'}
            </button>
          </div>
        </div>
      )}

      {/* 직원 카드 리스트 */}
      {filtered.length === 0 && (
        <div style={st.muted}>
          {list.length === 0 ? '아직 등록된 직원이 없습니다.' : '검색 결과가 없습니다.'}
        </div>
      )}
      {filtered.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 8 }}>
          {filtered.map(s => <StaffCard key={s.id} s={s} onToggle={() => toggle(s)} onRemove={() => remove(s)} />)}
        </div>
      )}
    </div>
  );
}

// 아바타 이니셜 색상 — 이름 해시로 6가지 팔레트 배정 (직원 간 시각 구분).
const AVATAR_PALETTE = ['#5B7CFF', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'];
function avatarColor(name) {
  let h = 0;
  for (const ch of name || '') h = (h * 31 + ch.charCodeAt(0)) | 0;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}
function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2);
  return (parts[0][0] || '') + (parts[parts.length - 1][0] || '');
}

function StaffCard({ s, onToggle, onRemove }) {
  const color = avatarColor(s.name);
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 14,
      display: 'flex', alignItems: 'center', gap: 12,
      opacity: s.active ? 1 : 0.55,
    }}>
      <div style={{
        width: 40, height: 40, borderRadius: '50%',
        background: color, color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 700, fontSize: 14, flexShrink: 0,
        letterSpacing: '-0.02em',
      }}>{initials(s.name)}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>{s.name}</span>
          {s.role && (
            <span style={{
              fontSize: 10, padding: '2px 6px', borderRadius: 4,
              background: 'var(--surface-2)', color: 'var(--text-2)', fontWeight: 600,
            }}>{s.role}</span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {s.phone || '연락처 없음'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        <button onClick={onToggle} style={{ ...st.btnGhost, padding: '6px 10px' }} title={s.active ? '비활성화' : '활성화'}>
          {s.active ? '비활성' : '활성'}
        </button>
        {s.active && (
          <button onClick={onRemove} style={{ ...st.btnGhost, padding: '6px 8px', color: 'var(--danger)' }} title="삭제">
            <Icon name="trash2" size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 운행 리포트 — 본 메인 기능
// ════════════════════════════════════════════════════════
function ReportTab({ devices, sub, onSubChange }) {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);

  const [deviceId, setDeviceId] = useState(devices[0]?.id || null);
  // hard refresh 시 useState 초기값은 첫 렌더의 devices(=[])를 캡처해서 deviceId=null 로 박힘.
  // devices 가 나중에 도착하면 deviceId 자동 채움 (사용자가 직접 안 골라도 첫 디바이스 선택).
  useEffect(() => {
    if (deviceId == null && devices.length > 0) setDeviceId(devices[0].id);
  }, [devices, deviceId]);
  const [from, setFrom] = useState(monthAgo);
  const [to,   setTo]   = useState(today);
  const [trips, setTrips] = useState(null);
  const [staff, setStaff] = useState([]);
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);   // 편집 중인 trip {trip, deviceId}
  const [downloading, setDownloading] = useState(false);
  // 추가 필터 — 운전자별 / 용무별 / 최소 운행 시간(시간). all/'' 이면 미적용. AND.
  const [driverFilter,  setDriverFilter]  = useState('all');
  const [purposeFilter, setPurposeFilter] = useState('all');
  const [minHours,      setMinHours]      = useState('');

  const device = devices.find(d => d.id === deviceId);

  useEffect(() => {
    api.listStaff().then(s => setStaff((s || []).filter(x => x.active))).catch(() => {});
    api.getCorporateInfo().then(setInfo).catch(() => {});
  }, []);

  async function load() {
    if (!deviceId) return;
    setLoading(true); setError(null);
    try {
      const t = await api.listTrips(deviceId, { from, to });
      setTrips(t || []);
    } catch (e) {
      setError(e.message);
      setTrips([]);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [deviceId, from, to]);  // eslint-disable-line

  // 추가 필터 적용된 trip 목록 — 운전자/용무/최소시간 AND.
  const filteredTrips = useMemo(() => {
    if (!trips) return null;
    const minH = parseFloat(minHours);
    const minMin = !isNaN(minH) && minH > 0 ? minH * 60 : 0;
    return trips.filter(t => {
      if (driverFilter !== 'all') {
        if (driverFilter === 'unassigned') {
          if (t.annotation?.driver_staff_id != null) return false;
        } else {
          if (t.annotation?.driver_staff_id !== Number(driverFilter)) return false;
        }
      }
      if (purposeFilter !== 'all') {
        const p = t.annotation?.purpose || 'unspecified';
        if (p !== purposeFilter) return false;
      }
      if (minMin > 0 && (t.duration_min || 0) < minMin) return false;
      return true;
    });
  }, [trips, driverFilter, purposeFilter, minHours]);

  // 일자별 누적거리 — 화면에 보이는(필터된) 운행 기준으로 계산.
  const dailyDistance = useMemo(() => {
    if (!filteredTrips) return new Map();
    const m = new Map();
    for (const t of filteredTrips) {
      const d = kstDate(t.started_at);
      m.set(d, (m.get(d) || 0) + (t.distance_m || 0));
    }
    return m;
  }, [filteredTrips]);

  const filterActive = driverFilter !== 'all' || purposeFilter !== 'all' || (parseFloat(minHours) > 0);
  function resetFilters() {
    setDriverFilter('all');
    setPurposeFilter('all');
    setMinHours('');
  }

  if (!sub) {
    return <div style={st.muted}>구독 상태 로딩 중...</div>;
  }
  if (!sub.active) {
    return (
      <Card title="법인운행 리포트 — 구독 필요">
        <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 12, lineHeight: 1.6 }}>
          법인운행 리포트는 월 구독제로 제공됩니다.<br/>
          포인트 <b>{sub.price_krw.toLocaleString()}원</b> 으로 30일간 이용 가능.<br/>
          <span style={{ color: 'var(--text-3)', fontSize: 11 }}>
            * 보유 포인트가 부족하면 내정보 → 포인트 탭에서 충전 요청을 먼저 진행하세요.
          </span>
        </div>
        <button onClick={async () => {
          const ok = await confirmDialog({
            title: '법인운행 리포트 구독',
            body: `30일 구독을 시작합니다. ${sub.price_krw.toLocaleString()}원이 포인트에서 차감됩니다.`,
            confirmLabel: `${sub.price_krw.toLocaleString()}원 결제`,
            tone: 'success',
          });
          if (!ok) return;
          try {
            const r = await api.buyCorporateSubscription();
            onSubChange(r);
            await alertDialog({ title: '구독 시작', body: `${new Date(r.expires_at).toLocaleDateString('ko-KR')} 까지 사용 가능합니다.`, tone: 'success' });
          } catch (e) { await alertDialog({ title: '결제 실패', body: e.message, tone: 'danger' }); }
        }} style={st.btnPrimary}>구독 시작</button>
      </Card>
    );
  }

  return (
    <>
      {/* (2026-07-28) Fleet 요약 — 상단 stat card 4개 (첨부 이미지 스타일).
          fleet-wide 지표 (총 차량 / 운행중 / 오늘 km / 이번달 km) 로 device drill-down 위에 배치.
          운행중 판정: devices.last_event_kind === 'wake'. km: 병렬 listTrips 집계. */}
      <FleetSummary devices={devices} />

      {/* 컨트롤 — 인쇄 시 숨김 */}
      <div className="no-print" style={st.controls}>
        <select value={deviceId || ''} onChange={e => setDeviceId(parseInt(e.target.value, 10) || null)}
          style={st.select}>
          {devices.map(d => (
            <option key={d.id} value={d.id}>
              {d.display_name || d.device_uid}
            </option>
          ))}
        </select>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={st.dateInput} />
        <span style={{ color: 'var(--text-3)' }}>~</span>
        <input type="date" value={to} onChange={e => setTo(e.target.value)} style={st.dateInput} />
        <button onClick={load} style={st.btnGhost} disabled={loading}>
          <Icon name="refresh" size={12} /> 새로고침
        </button>
        <button onClick={async () => {
          setDownloading(true);
          try {
            const { blob, filename } = await api.tripsCsv(deviceId, { from, to });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch (e) { await alertDialog({ title: '다운로드 실패', body: e.message, tone: 'danger' }); }
          finally { setDownloading(false); }
        }} style={st.btnGhost} disabled={downloading || !deviceId}>
          <Icon name="share" size={12} /> CSV (엑셀)
        </button>
        <button onClick={() => window.print()} style={st.btnPrimary}>
          <Icon name="share" size={12} /> 인쇄 / PDF
        </button>
      </div>

      {/* 추가 필터 row — 운전자 / 용무 / 최소시간. AND, 초기화 버튼. */}
      <div className="no-print" style={st.filters}>
        <select value={driverFilter} onChange={e => setDriverFilter(e.target.value)} style={st.select}>
          <option value="all">운전자 전체</option>
          <option value="unassigned">미지정</option>
          {staff.map(s => (
            <option key={s.id} value={String(s.id)}>{s.name}</option>
          ))}
        </select>
        <select value={purposeFilter} onChange={e => setPurposeFilter(e.target.value)} style={st.select}>
          <option value="all">용무 전체</option>
          <option value="commute">출퇴근</option>
          <option value="business">업무</option>
          <option value="other">기타</option>
          <option value="unspecified">미지정</option>
        </select>
        <input type="number" placeholder="최소 시간(h)"
          value={minHours} step="0.5" min="0"
          onChange={e => setMinHours(e.target.value)}
          style={{ ...st.dateInput, minWidth: 110 }} />
        {filterActive && (
          <button onClick={resetFilters} style={st.btnGhost}>
            <Icon name="close" size={12} /> 필터 초기화
          </button>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-3)' }}>
          {trips && filteredTrips
            ? (filterActive
                ? `${filteredTrips.length} / ${trips.length}건`
                : `${trips.length}건`)
            : ''}
        </span>
      </div>

      {/* 리포트 본문 — 인쇄 영역 */}
      <div className="report-area" style={st.reportArea}>
        <ReportHeader info={info} device={device} from={from} to={to} />
        {loading && <div style={st.muted}>운행 데이터 로딩 중...</div>}
        {error   && <div style={{ ...st.muted, color: 'var(--danger)' }}>{error}</div>}
        {trips && trips.length === 0 && !loading && (
          <div style={st.muted}>이 기간에 운행 기록이 없습니다.</div>
        )}
        {trips && trips.length > 0 && filteredTrips.length === 0 && (
          <div style={st.muted}>필터 조건에 맞는 운행이 없습니다.</div>
        )}
        {filteredTrips && filteredTrips.length > 0 && (
          <TripsTable trips={filteredTrips} dailyDistance={dailyDistance}
            onEdit={(t) => setEditing(t)} />
        )}
      </div>

      {editing && (
        <TripEditorModal trip={editing} staff={staff} deviceId={deviceId}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
    </>
  );
}

function ReportHeader({ info, device, from, to }) {
  const company = info?.company_name || '—';
  const biznum  = info?.business_number || '—';
  const dev     = device?.display_name || device?.device_uid || '—';
  return (
    <div style={st.reportHead}>
      <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>법인 차량 운행 일지</div>
      <table style={st.headerTable}>
        <tbody>
          <tr>
            <th style={st.th}>회사명</th><td style={st.td}>{company}</td>
            <th style={st.th}>사업자번호</th><td style={st.td}>{biznum}</td>
          </tr>
          <tr>
            <th style={st.th}>단말기</th><td style={st.td}>{dev}</td>
            <th style={st.th}>차량번호</th><td style={st.td}>{device?.display_name || '—'}</td>
          </tr>
          <tr>
            <th style={st.th}>기간</th>
            <td style={st.td} colSpan={3}>{from} ~ {to}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function TripsTable({ trips, dailyDistance, onEdit }) {
  return (
    // 모바일 — 9열 표가 좁은 폭을 넘김. 가로 스크롤 컨테이너로 감쌈.
    // 인쇄 시 @media print 가 nav/sidebar 만 숨기고 reportArea 는 그대로 노출, 인쇄 페이지 폭에 맞춤.
    <div style={st.tripsTableScroll}>
    <table style={st.tripsTable}>
      <thead>
        <tr>
          <th style={st.th}>날짜</th>
          <th style={st.th}>시간</th>
          <th style={st.th}>용무</th>
          <th style={st.th}>출발지</th>
          <th style={st.th}>도착지</th>
          <th style={st.th}>주행거리</th>
          <th style={st.th}>일별 누적</th>
          <th style={st.th}>유류</th>
          <th style={st.th}>운전자</th>
          <th style={{ ...st.th, width: 36 }} className="no-print"></th>
        </tr>
      </thead>
      <tbody>
        {trips.map((t, i) => {
          const d = kstDate(t.started_at);
          const dailyKm = ((dailyDistance.get(d) || 0) / 1000).toFixed(1);
          const firstOfDay = !trips.slice(0, i).some(x => kstDate(x.started_at) === d);
          return (
            <TripRow key={t.started_at} t={t}
              date={d} dailyKm={firstOfDay ? `${dailyKm} km` : ''}
              onEdit={() => onEdit(t)} />
          );
        })}
      </tbody>
    </table>
    </div>
  );
}

function TripRow({ t, date, dailyKm, onEdit }) {
  const ann = t.annotation || {};
  const purpose = ann.purpose || 'unspecified';
  const km = (t.distance_m / 1000).toFixed(1);
  const time = `${kstTime(t.started_at)}~${t.ended_at ? kstTime(t.ended_at) : '—'}`;

  return (
    <tr>
      <td style={st.td}>{date}</td>
      <td style={st.td}>{time}</td>
      <td style={st.td}>
        {PURPOSE_LABEL[purpose] || '미지정'}
        {purpose === 'other' && ann.purpose_note && (
          <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{ann.purpose_note}</div>
        )}
      </td>
      <td style={st.td}>
        <div>{t.start_address || '—'}</div>
        {t.start_lat != null && (
          <div style={{ fontSize: 9, color: 'var(--text-3)' }}>
            {t.start_lat.toFixed(5)}, {t.start_lng.toFixed(5)}
          </div>
        )}
      </td>
      <td style={st.td}>
        <div>{t.end_address || '—'}</div>
        {t.end_lat != null && (
          <div style={{ fontSize: 9, color: 'var(--text-3)' }}>
            {t.end_lat.toFixed(5)}, {t.end_lng.toFixed(5)}
          </div>
        )}
      </td>
      <td style={{ ...st.td, textAlign: 'right' }}>{km} km</td>
      <td style={{ ...st.td, textAlign: 'right' }}>{dailyKm}</td>
      <td style={st.td}>
        {ann.fuel_liters ? `${ann.fuel_liters}L` : '—'}
        {ann.fuel_cost ? ` / ${ann.fuel_cost.toLocaleString()}원` : ''}
      </td>
      <td style={st.td}>{ann.driver_name || '—'}</td>
      <td style={{ ...st.td, padding: 4 }} className="no-print">
        <button onClick={onEdit} style={{
          width: 26, height: 26, borderRadius: 6,
          background: 'var(--surface-2)', color: 'var(--text-2)',
          border: '1px solid var(--border)', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }} title="편집">
          <Icon name="edit" size={12} />
        </button>
      </td>
    </tr>
  );
}

// ─── 운행 편집 모달 — 한 화면에서 용무/운전자/유류 전부 입력 ──
function TripEditorModal({ trip, staff, deviceId, onClose, onSaved }) {
  const ann = trip.annotation || {};
  const [purpose, setPurpose]      = useState(ann.purpose || 'unspecified');
  const [purposeNote, setPurposeNote] = useState(ann.purpose_note || '');
  const [driverId, setDriverId]    = useState(ann.driver_staff_id || '');
  const [fuelLiters, setFuelLiters] = useState(ann.fuel_liters != null ? String(ann.fuel_liters) : '');
  const [fuelCost, setFuelCost]    = useState(ann.fuel_cost != null ? String(ann.fuel_cost) : '');
  const [note, setNote]            = useState(ann.note || '');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.upsertTripAnnotation(deviceId, {
        trip_started_at: trip.started_at,
        purpose,
        purpose_note: purpose === 'other' ? (purposeNote.trim() || null) : null,
        driver_staff_id: driverId ? parseInt(driverId, 10) : null,
        fuel_liters: fuelLiters.trim() ? parseFloat(fuelLiters) : null,
        fuel_cost:   fuelCost.trim()   ? parseInt(fuelCost, 10) : null,
        note: note.trim() || null,
      });
      onSaved?.();
    } catch (e) {
      await alertDialog({ title: '저장 실패', body: e.message, tone: 'danger' });
    } finally { setBusy(false); }
  }

  const km = (trip.distance_m / 1000).toFixed(1);

  return (
    // 외부 클릭으로 닫히지 않음 — 편집 중 데이터 손실 방지. X / 취소 버튼만 닫기.
    <div style={mst.backdrop}>
      <div style={mst.modal}>
        {/* 헤더 — 운행 요약 */}
        <div style={mst.header}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>
              {kstDate(trip.started_at)} · {kstTime(trip.started_at)}~{trip.ended_at ? kstTime(trip.ended_at) : '진행 중'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
              {trip.start_address || '—'} → {trip.end_address || '—'} · {km} km
            </div>
          </div>
          <button onClick={onClose} style={mst.closeBtn}><Icon name="close" size={14} /></button>
        </div>

        <div style={mst.body}>
          {/* 용무 */}
          <Field label="용무">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
              {[
                ['unspecified', '미지정'],
                ['commute',     '출퇴근'],
                ['business',    '업무'],
                ['other',       '기타'],
              ].map(([id, label]) => {
                const on = purpose === id;
                return (
                  <button key={id} onClick={() => setPurpose(id)}
                    style={{
                      padding: '8px 4px',
                      background: on ? 'var(--primary)' : 'var(--surface-2)',
                      color:      on ? 'white' : 'var(--text)',
                      border: '1px solid ' + (on ? 'var(--primary)' : 'var(--border)'),
                      borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: on ? 700 : 500,
                    }}>{label}</button>
                );
              })}
            </div>
            {purpose === 'other' && (
              <input value={purposeNote} onChange={e => setPurposeNote(e.target.value)}
                placeholder="예: 거래처 미팅, 외근, 출장..."
                style={{ ...mst.input, marginTop: 6 }} autoFocus />
            )}
          </Field>

          {/* 운전자 */}
          <Field label="운전자">
            {staff.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                직원 탭에서 운전자 후보를 먼저 등록하세요.
              </div>
            ) : (
              <select value={driverId} onChange={e => setDriverId(e.target.value)}
                style={mst.input}>
                <option value="">— 미지정 —</option>
                {staff.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name}{s.role ? ` (${s.role})` : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>

          {/* 유류 */}
          <Field label="유류">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <div>
                <input type="number" step="0.1" value={fuelLiters}
                  onChange={e => setFuelLiters(e.target.value)}
                  placeholder="리터 (L)" style={mst.input} />
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>리터</div>
              </div>
              <div>
                <input type="number" value={fuelCost}
                  onChange={e => setFuelCost(e.target.value)}
                  placeholder="비용 (원)" style={mst.input} />
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>원</div>
              </div>
            </div>
          </Field>

          {/* 비고 */}
          <Field label="비고 (선택)">
            <input value={note} onChange={e => setNote(e.target.value)}
              placeholder="메모"
              style={mst.input} />
          </Field>
        </div>

        <div style={mst.actions}>
          <button onClick={onClose} style={mst.btnSecondary}>취소</button>
          <button onClick={save} disabled={busy} style={mst.btnPrimary}>
            {busy ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 구독
// ════════════════════════════════════════════════════════
function SubTab({ sub, onChange }) {
  const [busy, setBusy] = useState(false);

  async function buy() {
    const ok = await confirmDialog({
      title: '구독 결제',
      body: `${sub.price_krw.toLocaleString()}원 — 포인트에서 차감되며 30일 추가됩니다.`,
      confirmLabel: '결제',
      tone: 'success',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.buyCorporateSubscription();
      onChange(r);
    } catch (e) { await alertDialog({ title: '결제 실패', body: e.message, tone: 'danger' }); }
    finally { setBusy(false); }
  }

  if (!sub) return <div style={st.muted}>로딩...</div>;

  const daysLeft = sub.expires_at
    ? Math.max(0, Math.ceil((new Date(sub.expires_at).getTime() - Date.now()) / 86400_000))
    : null;

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 상태 요약 카드 — 큰 뱃지 + 만료일 + 남은 일수 */}
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
          <div style={{ fontSize: 15, fontWeight: 700 }}>
            법인운행 리포트 구독
          </div>
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

      {/* 결제 액션 */}
      <button onClick={buy} disabled={busy} style={{
        ...st.btnPrimary, padding: '14px 20px', fontSize: 14, alignSelf: 'flex-start',
      }}>
        {busy ? '...' : (sub.active ? '30일 추가 결제' : '구독 시작')}
      </button>

      {/* 안내 — 구독으로 이용 가능한 기능 목록 */}
      <div style={st.sectionCard}>
        <div style={st.sectionCardHeader}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="info" size={14} />
            <span>구독으로 이용 가능한 기능</span>
          </div>
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[
            { icon: 'route',  title: '운행 리포트',     desc: '기간별 · 차량별 운행 목록 조회 · 용무 / 운전자 / 유류 주석' },
            { icon: 'bar',    title: '월간 리포트',     desc: '업무 / 개인 자동 분리 · 유류비 자동 추정 · 차량별 stacked bar' },
            { icon: 'share',  title: 'PDF / 엑셀 출력', desc: '국세청 별지 제73호 서식 헤더 · 인쇄 최적화 (Stage-4B 서버 PDF 준비 중)' },
            { icon: 'user',   title: '직원 관리',       desc: '운전자 후보 등록 · 운행별 배정 · 활성/비활성 토글' },
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
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// (2026-07-28 Stage-4C-1) 차량 관리 — cartax.biz 스타일 참조.
// 필터 chips + 검색 + 카드 리스트 + 상세 편집 (기존 VehicleInfoDialog 재사용).
// ═══════════════════════════════════════════════════════
function VehiclesTab({ devices }) {
  const [filter, setFilter] = useState('all');   // all | enabled | disabled
  const [query,  setQuery]  = useState('');
  const [editing, setEditing] = useState(null);
  const [tick, setTick] = useState(0);
  const stats = useFleetStats(devices);   // 이번달 km — device 별로는 라이브 계산 X (요약만)

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (devices || [])
      .filter(d => {
        // enabled 는 새 컬럼이라 옛 record 는 undefined → true 로 간주
        const active = d.enabled !== false;
        if (filter === 'enabled'  && !active) return false;
        if (filter === 'disabled' &&  active) return false;
        if (!q) return true;
        return [d.display_name, d.device_uid, d.license_plate, d.department]
          .some(v => (v || '').toLowerCase().includes(q));
      });
  }, [devices, filter, query, tick]);

  const enabledCount  = (devices || []).filter(d => d.enabled !== false).length;
  const disabledCount = (devices || []).length - enabledCount;

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <StatCardGrid>
        <StatCard icon="list"  label="전체 차량" value={devices?.length ?? 0} unit="대" tone="default" />
        <StatCard icon="route" label="사용가능"   value={enabledCount}         unit="대" tone="success" />
        <StatCard icon="warn"  label="사용정지"   value={disabledCount}        unit="대" tone={disabledCount > 0 ? 'warn' : 'default'} />
      </StatCardGrid>

      {/* 필터 chips + 검색 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <FilterChip active={filter==='all'}      onClick={() => setFilter('all')}      label="전체"     count={devices?.length ?? 0} />
        <FilterChip active={filter==='enabled'}  onClick={() => setFilter('enabled')}  label="사용가능" count={enabledCount} tone="success" />
        <FilterChip active={filter==='disabled'} onClick={() => setFilter('disabled')} label="사용정지" count={disabledCount} tone="warn" />
        <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
          <input value={query} onChange={e => setQuery(e.target.value)}
            placeholder="차량번호 · 차명 · 부서 검색"
            style={{ ...st.input, paddingLeft: 34 }} />
          <div style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }}>
            <Icon name="filter" size={14} />
          </div>
        </div>
      </div>

      {rows.length === 0 && (
        <div style={st.muted}>
          {devices?.length === 0 ? '아직 등록된 차량이 없습니다.' : '조건에 맞는 차량이 없습니다.'}
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 8 }}>
          {rows.map(d => <VehicleCard key={d.id} d={d} onEdit={() => setEditing(d)} />)}
        </div>
      )}

      {editing && (
        <FuelInfoDialog device={vehicleToRowShape(editing)}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); setTick(t => t + 1); }} />
      )}
    </div>
  );
}

// FuelInfoDialog 는 MonthlyReport 의 row shape (label 필드) 을 기대. device 를 그 shape 으로 변환.
function vehicleToRowShape(d) {
  return {
    id: d.id,
    label: d.display_name || d.device_uid,
    fuel_efficiency_kmpl: d.fuel_efficiency_kmpl,
    fuel_type: d.fuel_type,
    license_plate: d.license_plate,
    model_year: d.model_year,
    engine_cc: d.engine_cc,
    purchase_price_krw: d.purchase_price_krw,
    acquired_at: d.acquired_at,
    department: d.department,
    vehicle_type: d.vehicle_type,
    enabled: d.enabled,
    note: d.note,
  };
}

function FilterChip({ active, onClick, label, count, tone = 'default' }) {
  const c = tone === 'success' ? 'var(--accent)' : tone === 'warn' ? 'var(--warning)' : 'var(--primary)';
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
        color: active ? 'white' : 'var(--text-3)',
        fontWeight: 700,
      }}>{count}</span>
    </button>
  );
}

function VehicleCard({ d, onEdit }) {
  const active = d.enabled !== false;
  const km = d.last_fix_at ? '' : '';   // 개별 lifetime 은 별도 API 필요 — 지금은 skip
  return (
    <div onClick={onEdit} style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 14,
      display: 'flex', gap: 12, alignItems: 'center',
      cursor: 'pointer', transition: 'transform .1s, box-shadow .1s',
      opacity: active ? 1 : 0.6,
    }}
    onMouseEnter={e => e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.06)'}
    onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}>
      <div style={{
        width: 42, height: 42, borderRadius: 10,
        background: active
          ? 'color-mix(in srgb, var(--primary) 12%, transparent)'
          : 'var(--surface-2)',
        color: active ? 'var(--primary)' : 'var(--text-3)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Icon name="route" size={20} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 800, fontSize: 14, letterSpacing: '-0.01em' }}>
            {d.license_plate || <span style={{ color: 'var(--text-3)' }}>번호 미입력</span>}
          </span>
          <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
            {d.display_name || d.device_uid}
          </span>
          <StateBadge active={active} />
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {d.department && <span>👥 {d.department}</span>}
          {d.model_year && <span>{d.model_year}년식</span>}
          {d.fuel_type && <span>{FUEL_LABEL[d.fuel_type]}</span>}
          {d.fuel_efficiency_kmpl && <span>{d.fuel_efficiency_kmpl}km/L</span>}
        </div>
        {d.note && (
          <div style={{
            fontSize: 11, color: 'var(--text-2)', marginTop: 6,
            padding: '4px 8px', background: 'var(--surface-2)', borderRadius: 6,
          }}>
            📝 {d.note}
          </div>
        )}
      </div>
      <div style={{ flexShrink: 0, textAlign: 'right', color: 'var(--text-3)' }}>
        <Icon name="chevron-right" size={16} />
      </div>
    </div>
  );
}

function StateBadge({ active }) {
  return (
    <span style={{
      fontSize: 10, padding: '2px 8px', borderRadius: 999,
      background: active
        ? 'color-mix(in srgb, var(--accent) 15%, transparent)'
        : 'var(--surface-2)',
      color: active ? 'var(--accent)' : 'var(--text-3)',
      fontWeight: 700,
    }}>
      {active ? '사용가능' : '사용정지'}
    </span>
  );
}

// ═══════════════════════════════════════════════════════
// (2026-07-28 Stage-4F-1) 차량 예약 — cartax 스타일.
// 리스트 + 상태 chip 필터 + 생성/편집 다이얼로그.
// ═══════════════════════════════════════════════════════
const RESV_STATUS = {
  planned:     { label: '예정',   color: 'var(--primary)', bg: 'color-mix(in srgb, var(--primary) 12%, transparent)' },
  in_progress: { label: '진행중', color: 'var(--accent)',  bg: 'color-mix(in srgb, var(--accent) 15%, transparent)' },
  completed:   { label: '완료',   color: 'var(--text-3)',  bg: 'var(--surface-2)' },
  cancelled:   { label: '취소',   color: 'var(--danger)',  bg: 'color-mix(in srgb, var(--danger) 12%, transparent)' },
};

function ReservationsTab({ devices }) {
  const [list, setList] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [statusFilter, setStatusFilter] = useState('active');   // active | all | completed | cancelled
  const [editing, setEditing] = useState(null);   // null | 'new' | {id, ...} | {new: 'YYYY-MM-DD'}
  const [staff, setStaff] = useState([]);
  const [tick, setTick] = useState(0);
  // (2026-07-28) Stage-4F-2: 뷰 모드 (리스트 / 캘린더).
  const [viewMode, setViewMode] = useState(() => localStorage.getItem('resv_view') || 'list');
  const setViewPersist = (v) => { setViewMode(v); try { localStorage.setItem('resv_view', v); } catch {} };
  // 캘린더는 표시 월 별도. 리스트는 최근/향후 range 로.
  const [calYm, setCalYm] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

  useEffect(() => {
    api.listStaff().then(s => setStaff((s || []).filter(x => x.active))).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    let from, to;
    if (viewMode === 'calendar') {
      // 표시 월 ± 1주 (그리드에 걸치는 인접 월 데이터도 포함)
      const [y, m] = calYm.split('-').map(Number);
      const start = new Date(y, m - 1, 1);
      const end   = new Date(y, m, 1);
      from = new Date(start.getTime() - 7 * 86400_000).toISOString();
      to   = new Date(end.getTime()   + 7 * 86400_000).toISOString();
    } else {
      const now = new Date();
      from = new Date(now.getTime() - 7 * 86400_000).toISOString();
      to   = new Date(now.getTime() + 60 * 86400_000).toISOString();
    }
    const params = { from, to };
    if (viewMode !== 'calendar') {
      // 캘린더는 모든 status 를 색으로 구분해 보여줌 → filter 는 리스트뷰에서만.
      if (statusFilter === 'active') params.status = ['planned', 'in_progress'];
      else if (statusFilter !== 'all') params.status = [statusFilter];
    }
    api.listReservations(params).then(rs => {
      if (cancelled) return;
      setList(rs || []); setLoading(false);
    }).catch(e => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [statusFilter, tick, viewMode, calYm]);

  const activeCount    = (list || []).filter(r => r.status === 'planned' || r.status === 'in_progress').length;
  const completedCount = (list || []).filter(r => r.status === 'completed').length;
  const cancelledCount = (list || []).filter(r => r.status === 'cancelled').length;

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <StatCardGrid>
        <StatCard icon="clock" label="예정/진행중"  value={activeCount}    unit="건" tone="primary" />
        <StatCard icon="route" label="완료"         value={completedCount} unit="건" tone="success" />
        <StatCard icon="close" label="취소"         value={cancelledCount} unit="건" tone="default" />
        <StatCard icon="list"  label="전체 차량"    value={devices?.length ?? 0} unit="대" tone="default" />
      </StatCardGrid>

      {/* 뷰 mode 토글 + 필터/추가 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{
          display: 'flex', gap: 0, padding: 3,
          background: 'var(--surface-2)', borderRadius: 999,
        }}>
          <ViewToggleBtn active={viewMode==='list'}     onClick={() => setViewPersist('list')}     label="리스트" icon="list" />
          <ViewToggleBtn active={viewMode==='calendar'} onClick={() => setViewPersist('calendar')} label="캘린더" icon="clock" />
        </div>
        {viewMode === 'list' && (
          <>
            <FilterChip active={statusFilter==='active'}    onClick={() => setStatusFilter('active')}    label="예정+진행" count={activeCount} tone="primary" />
            <FilterChip active={statusFilter==='completed'} onClick={() => setStatusFilter('completed')} label="완료"     count={completedCount} tone="success" />
            <FilterChip active={statusFilter==='cancelled'} onClick={() => setStatusFilter('cancelled')} label="취소"     count={cancelledCount} tone="warn" />
            <FilterChip active={statusFilter==='all'}       onClick={() => setStatusFilter('all')}       label="전체"     count={(list || []).length} />
          </>
        )}
        {viewMode === 'calendar' && (
          <input type="month" value={calYm} onChange={e => setCalYm(e.target.value || calYm)}
            style={{ ...st.dateInput, minWidth: 130 }} />
        )}
        <button onClick={() => setEditing('new')} style={{
          marginLeft: 'auto', ...st.btnPrimary, display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <Icon name="plus" size={13} /> 새 예약
        </button>
      </div>

      {error && <div style={{ ...st.muted, color: 'var(--danger)' }}>{error}</div>}
      {loading && !list && <div style={st.muted}>예약 로딩 중...</div>}
      {list && list.length === 0 && viewMode === 'list' && <div style={st.muted}>예약이 없습니다.</div>}

      {viewMode === 'list' && list && list.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 8 }}>
          {list.map(r => (
            <ReservationCard key={r.id} r={r} onEdit={() => setEditing(r)}
              onDelete={async () => {
                const ok = await confirmDialog({ title: '예약 삭제', body: '삭제하시겠습니까? (되돌릴 수 없음)', danger: true });
                if (!ok) return;
                try { await api.deleteReservation(r.id); setTick(t => t + 1); }
                catch (e) { await alertDialog({ title: '삭제 실패', body: e.message, tone: 'danger' }); }
              }} />
          ))}
        </div>
      )}

      {viewMode === 'calendar' && (
        <ReservationCalendar ym={calYm} list={list || []}
          onDayClick={(dateStr) => setEditing({ new: dateStr })}
          onEventClick={(r) => setEditing(r)} />
      )}

      {editing && (
        <ReservationDialog init={editing === 'new' ? null : editing} devices={devices} staff={staff}
          presetDate={editing?.new || null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); setTick(t => t + 1); }} />
      )}
    </div>
  );
}

function ViewToggleBtn({ active, onClick, label, icon }) {
  return (
    <button onClick={onClick} style={{
      padding: '6px 12px', borderRadius: 999, border: 'none', cursor: 'pointer',
      background: active ? 'var(--surface)' : 'transparent',
      color: active ? 'var(--text)' : 'var(--text-3)',
      fontSize: 12, fontWeight: 700,
      boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
      display: 'flex', alignItems: 'center', gap: 5,
      transition: 'all .15s',
    }}>
      <Icon name={icon} size={12} /> {label}
    </button>
  );
}

// (2026-07-28) Stage-4F-2: 월 캘린더 뷰. 7x6 grid, 각 셀 = 하루.
// 예약은 그 날 시간대에 걸치는 것들 (status 색으로 구분). 최대 3개 표시 + "N+ more".
function ReservationCalendar({ ym, list, onDayClick, onEventClick }) {
  const [y, m] = ym.split('-').map(Number);
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd   = new Date(y, m, 0);   // 마지막날
  const startDay   = monthStart.getDay(); // 0=Sun
  const daysInMonth = monthEnd.getDate();
  const todayStr = new Date().toISOString().slice(0, 10);

  // 셀 구성 — 이전달 잔여 + 이번달 + 다음달 첫주 padding. 7x6 = 42 cells.
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

  function reservationsOn(date) {
    const dStr = date.toISOString().slice(0, 10);
    return (list || []).filter(r => {
      const s = new Date(r.starts_at).toISOString().slice(0, 10);
      const e = new Date(r.ends_at  ).toISOString().slice(0, 10);
      return dStr >= s && dStr <= e;
    });
  }

  const DOW = ['일', '월', '화', '수', '목', '금', '토'];

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 8,
    }}>
      {/* DoW header */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 4 }}>
        {DOW.map((d, i) => (
          <div key={d} style={{
            fontSize: 11, fontWeight: 700, padding: '6px 4px',
            textAlign: 'center',
            color: i === 0 ? 'var(--danger)' : i === 6 ? 'var(--primary)' : 'var(--text-2)',
          }}>{d}</div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
        {cells.map((c, i) => {
          const dStr = c.date.toISOString().slice(0, 10);
          const dayResv = reservationsOn(c.date);
          const isToday = dStr === todayStr;
          const dow = c.date.getDay();
          return (
            <div key={i} onClick={() => c.currentMonth && onDayClick(dStr)} style={{
              minHeight: 84,
              padding: 4,
              background: isToday
                ? 'color-mix(in srgb, var(--primary) 8%, transparent)'
                : c.currentMonth ? 'var(--surface)' : 'var(--surface-2)',
              border: '1px solid ' + (isToday ? 'var(--primary)' : 'var(--border)'),
              borderRadius: 6,
              opacity: c.currentMonth ? 1 : 0.4,
              cursor: c.currentMonth ? 'pointer' : 'default',
              display: 'flex', flexDirection: 'column', gap: 2,
              overflow: 'hidden',
            }}>
              <div style={{
                fontSize: 11, fontWeight: 700,
                color: !c.currentMonth ? 'var(--text-3)'
                     : isToday ? 'var(--primary)'
                     : dow === 0 ? 'var(--danger)'
                     : dow === 6 ? 'var(--primary)'
                     : 'var(--text)',
              }}>
                {c.date.getDate()}
              </div>
              {dayResv.slice(0, 3).map(r => {
                const s = RESV_STATUS[r.status] || RESV_STATUS.planned;
                return (
                  <div key={r.id} onClick={(e) => { e.stopPropagation(); onEventClick(r); }} style={{
                    fontSize: 10, fontWeight: 600,
                    padding: '2px 5px', borderRadius: 3,
                    background: s.bg, color: s.color,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    cursor: 'pointer',
                  }} title={`${r.license_plate || r.device_name || ''} · ${r.purpose || ''} · ${s.label}`}>
                    {r.license_plate || r.device_name || `#${r.device_id}`}
                  </div>
                );
              })}
              {dayResv.length > 3 && (
                <div style={{ fontSize: 9, color: 'var(--text-3)', textAlign: 'center' }}>
                  +{dayResv.length - 3}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReservationCard({ r, onEdit, onDelete }) {
  const s = RESV_STATUS[r.status] || RESV_STATUS.planned;
  const start = new Date(r.starts_at);
  const end   = new Date(r.ends_at);
  const fmtDT = d => d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const sameDay = start.toDateString() === end.toDateString();
  // (2026-07-28) Stage-4H-1/2: 임박 표시.
  const minsUntilStart = Math.round((start.getTime() - Date.now()) / 60_000);
  const minsUntilEnd   = Math.round((end.getTime()   - Date.now()) / 60_000);
  const isImminent  = r.status === 'planned'     && minsUntilStart >= 0 && minsUntilStart <= 60;
  const isReturning = r.status === 'in_progress' && minsUntilEnd   >= 0 && minsUntilEnd   <= 60;
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 10, padding: '3px 8px', borderRadius: 999,
          background: s.bg, color: s.color, fontWeight: 700,
        }}>{s.label}</span>
        {isImminent && (
          <span style={{
            fontSize: 10, padding: '3px 8px', borderRadius: 999,
            background: 'color-mix(in srgb, var(--warning) 20%, transparent)',
            color: 'var(--warning)', fontWeight: 800,
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }} title={`${minsUntilStart}분 후 시작 — 백엔드 워커가 30분 전 FCM 알림 발송`}>
            🔔 {minsUntilStart === 0 ? '지금 시작' : `${minsUntilStart}분 후 시작`}
          </span>
        )}
        {isReturning && (
          <span style={{
            fontSize: 10, padding: '3px 8px', borderRadius: 999,
            background: 'color-mix(in srgb, var(--danger) 20%, transparent)',
            color: 'var(--danger)', fontWeight: 800,
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }} title={`${minsUntilEnd}분 후 반납 — 30분 전 FCM 알림`}>
            🔔 {minsUntilEnd === 0 ? '지금 반납' : `${minsUntilEnd}분 후 반납`}
          </span>
        )}
        <span style={{ fontWeight: 700, fontSize: 14 }}>
          {r.license_plate || r.device_name || `#${r.device_id}`}
        </span>
        {r.driver_name && (
          <span style={{
            fontSize: 10, padding: '2px 8px', borderRadius: 4,
            background: 'var(--surface-2)', color: 'var(--text-2)', fontWeight: 600,
          }}>👤 {r.driver_name}</span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button onClick={onEdit} style={{ ...st.btnGhost, padding: '4px 8px' }} title="편집">
            <Icon name="edit" size={12} />
          </button>
          <button onClick={onDelete} style={{ ...st.btnGhost, padding: '4px 8px', color: 'var(--danger)' }} title="삭제">
            <Icon name="trash2" size={12} />
          </button>
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 4 }}>
        <Icon name="clock" size={12} />
        {sameDay
          ? `${start.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' })} ${start.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} ~ ${end.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`
          : `${fmtDT(start)} ~ ${fmtDT(end)}`}
      </div>
      {r.purpose && (
        <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
          <span style={{ color: 'var(--text-3)' }}>목적</span>
          <span style={{ marginLeft: 6 }}>{r.purpose}</span>
        </div>
      )}
      {r.note && (
        <div style={{
          fontSize: 11, color: 'var(--text-2)',
          padding: '6px 10px', background: 'var(--surface-2)', borderRadius: 6,
        }}>📝 {r.note}</div>
      )}
    </div>
  );
}

// datetime-local input value 는 'YYYY-MM-DDTHH:MM' 로컬 시간 문자열.
// ISO 로 변환 (Date 는 로컬 문자열을 로컬 시간으로 파싱 → toISOString 은 UTC).
function localToIso(v) { return v ? new Date(v).toISOString() : null; }
function isoToLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ReservationDialog({ init, presetDate, devices, staff, onClose, onSaved }) {
  // init null = 신규. presetDate 'YYYY-MM-DD' 있으면 그 날 09:00~10:00 기본.
  // 아니면 다음 정시부터 +1h.
  const defaultStart = () => {
    if (presetDate) return new Date(`${presetDate}T09:00:00`);
    const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d;
  };
  const [deviceId, setDeviceId] = useState(init?.device_id ?? devices?.[0]?.id ?? '');
  const [driverId, setDriverId] = useState(init?.driver_staff_id ?? '');
  const [startsAt, setStartsAt] = useState(init ? isoToLocal(init.starts_at) : isoToLocal(defaultStart().toISOString()));
  const [endsAt,   setEndsAt]   = useState(init ? isoToLocal(init.ends_at)   : isoToLocal(new Date(defaultStart().getTime() + 3600_000).toISOString()));
  const [purpose,  setPurpose]  = useState(init?.purpose ?? '');
  const [note,     setNote]     = useState(init?.note ?? '');
  const [status,   setStatus]   = useState(init?.status ?? 'planned');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!deviceId) { alertDialog({ title: '차량 선택 필요', body: '', tone: 'danger' }); return; }
    if (!startsAt || !endsAt) { alertDialog({ title: '시간 입력 필요', body: '', tone: 'danger' }); return; }
    const body = {
      device_id:       Number(deviceId),
      driver_staff_id: driverId ? Number(driverId) : null,
      starts_at:       localToIso(startsAt),
      ends_at:         localToIso(endsAt),
      purpose:         purpose.trim() || null,
      note:            note.trim() || null,
      status,
    };
    setBusy(true);
    try {
      if (init?.id) await api.updateReservation(init.id, body);
      else          await api.createReservation(body);
      onSaved();
    } catch (e) {
      alertDialog({ title: '저장 실패', body: e.message, tone: 'danger' });
    } finally { setBusy(false); }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 900,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--surface)', borderRadius: 14, padding: 20,
        width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <div style={{ fontSize: 15, fontWeight: 800 }}>
          {init?.id ? '예약 편집' : '새 예약'}
        </div>

        <div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>차량</div>
          <select value={deviceId} onChange={e => setDeviceId(e.target.value)} style={st.input}>
            {(devices || []).map(d => (
              <option key={d.id} value={d.id}>
                {d.license_plate ? `${d.license_plate} · ` : ''}{d.display_name || d.device_uid}
              </option>
            ))}
          </select>
        </div>

        <div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>운전자 (선택)</div>
          <select value={driverId} onChange={e => setDriverId(e.target.value)} style={st.input}>
            <option value="">— 미지정 —</option>
            {staff.map(s => <option key={s.id} value={s.id}>{s.name}{s.role ? ` (${s.role})` : ''}</option>)}
          </select>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>시작</div>
            <input type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)} style={st.input} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>종료</div>
            <input type="datetime-local" value={endsAt} onChange={e => setEndsAt(e.target.value)} style={st.input} />
          </div>
        </div>

        <div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>목적</div>
          <input value={purpose} onChange={e => setPurpose(e.target.value)}
            placeholder="거래처 방문, 외근..." style={st.input} />
        </div>

        <div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>메모 (선택)</div>
          <textarea value={note} onChange={e => setNote(e.target.value)}
            placeholder="..." style={{ ...st.input, minHeight: 50, resize: 'vertical', fontFamily: 'inherit' }} />
        </div>

        {init?.id && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>상태</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
              {Object.entries(RESV_STATUS).map(([id, meta]) => (
                <button key={id} onClick={() => setStatus(id)} style={{
                  padding: '8px 4px', fontSize: 11, borderRadius: 8, cursor: 'pointer',
                  background: status === id ? meta.color : 'var(--surface-2)',
                  color:      status === id ? 'white'    : 'var(--text)',
                  border: 'none', fontWeight: status === id ? 700 : 500,
                }}>{meta.label}</button>
              ))}
            </div>
          </div>
        )}

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

// ─── 월간 리포트 (2026-07-28 Stage-3A) ─────────────────
// 참조: 첨부 이미지 4 (월간 · 업무/개인 분리 · 유류비 추정 · 차량별 bar).
// 데이터: 병렬 listTrips + trip_annotations 로 client-side aggregate.
// 유류비 = km ÷ fuel_efficiency_kmpl × FUEL_PRICE[fuel_type]. 연비 미입력 device 는
// "연비 설정" pill 로 유도. Trip 별 fuel_cost 수기 입력값이 있으면 우선 (annotation.fuel_cost).
//
// 백엔드는 devices.fuel_efficiency_kmpl / fuel_type 컬럼 (migration 0044) + PATCH
// /devices/:id/fuel-info endpoint 만 제공. 유가 상수는 클라이언트 (환경 관계 없이).
// (2026-07-28) Stage-4D: 오피넷 서버 캐시 fetch. useFuelPrices 훅 실패 or 로딩 중이면 이 default.
const DEFAULT_FUEL_PRICE_KRW = {
  gasoline: 1700, diesel: 1600, lpg: 1000, ev: 0,
};
// mutable — useFuelPrices 훅이 채워넣음. estimateFuelCost 는 이걸 참조.
// eslint-disable-next-line prefer-const
let FUEL_PRICE_KRW = { ...DEFAULT_FUEL_PRICE_KRW };
const FUEL_LABEL = {
  gasoline: '휘발유', diesel: '경유', lpg: 'LPG', ev: '전기',
};
const BUSINESS_PURPOSES = new Set(['business']);

function ymKST(d = new Date()) {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 7);
}
function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  const from = `${ym}-01`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const to = `${ny}-${String(nm).padStart(2, '0')}-01`;
  return { from, to };
}

function MonthlyReportTab({ devices, sub }) {
  const [ym, setYm] = useState(ymKST());
  const [rows, setRows] = useState(null);   // per-device aggregate
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);   // 연비 편집 대상 device
  const [tick, setTick] = useState(0);
  const [dlOpen, setDlOpen] = useState(false);    // (2026-07-28) Stage-4C-2 다운로드 다이얼로그
  const [fuelPrices, setFuelPrices] = useState(null);  // (2026-07-28) Stage-4D 오피넷
  // (2026-07-28) Stage-4G 부서 필터. null = 전체. Set<string> = 선택한 부서명 (또는 '(부서없음)').
  const [depFilter, setDepFilter] = useState(null);

  // 오피넷 유가 fetch — mount 시 1회. 실패해도 default 로 fallback.
  // fetch 성공 시 모듈 전역 FUEL_PRICE_KRW 갱신 → estimateFuelCost 즉시 반영.
  useEffect(() => {
    api.getFuelPrices().then(p => {
      setFuelPrices(p);
      FUEL_PRICE_KRW = {
        gasoline: p.gasoline, diesel: p.diesel, lpg: p.lpg, ev: 0,
      };
      setTick(t => t + 1);   // 재계산 트리거
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!devices || devices.length === 0) { setRows([]); return; }
    setLoading(true); setError(null);
    const { from, to } = monthBounds(ym);
    Promise.all(devices.map(d =>
      api.listTrips(d.id, { from, to }).catch(() => [])
    )).then(perDevice => {
      if (cancelled) return;
      const out = devices.map((d, i) => {
        const trips = perDevice[i] || [];
        let totalM = 0, businessM = 0, personalM = 0;
        let annCostSum = 0, annCostCount = 0;
        for (const t of trips) {
          const dist = t.distance_m || 0;
          totalM += dist;
          const purpose = t.annotation?.purpose || 'unspecified';
          if (BUSINESS_PURPOSES.has(purpose)) businessM += dist;
          else personalM += dist;
          if (typeof t.annotation?.fuel_cost === 'number') {
            annCostSum += t.annotation.fuel_cost;
            annCostCount++;
          }
        }
        return {
          id: d.id,
          label: d.display_name || d.device_uid,
          fuel_efficiency_kmpl: d.fuel_efficiency_kmpl,
          fuel_type: d.fuel_type,
          // (2026-07-28) Stage-4B-1 국세청 + 우리 전용 필드 (편집 다이얼로그 전달용)
          license_plate:      d.license_plate,
          model_year:         d.model_year,
          engine_cc:          d.engine_cc,
          purchase_price_krw: d.purchase_price_krw,
          acquired_at:        d.acquired_at,
          department:         d.department,
          vehicle_type:       d.vehicle_type,
          totalKm:    totalM / 1000,
          businessKm: businessM / 1000,
          personalKm: personalM / 1000,
          annotationCost: annCostSum,           // 사용자가 직접 입력한 비용 합계 (있으면 우선)
          annotationCount: annCostCount,
        };
      });
      setRows(out); setLoading(false);
    }).catch(e => {
      if (cancelled) return;
      setError(e.message); setLoading(false);
    });
    return () => { cancelled = true; };
  }, [devices, ym, tick]);

  // (2026-07-28) Stage-4G 부서 목록 (rows 에서 자동 발견) + 부서 필터 적용된 row.
  const departments = useMemo(() => {
    if (!rows) return [];
    const s = new Set();
    for (const r of rows) s.add(r.department || '(부서없음)');
    return Array.from(s).sort();
  }, [rows]);
  const filteredRows = useMemo(() => {
    if (!rows || !depFilter || depFilter.size === 0) return rows;
    return rows.filter(r => depFilter.has(r.department || '(부서없음)'));
  }, [rows, depFilter]);

  // fleet 총계 — stat card 5개. (부서 필터 적용된 filteredRows 사용)
  const totals = useMemo(() => {
    const use = filteredRows || rows;
    if (!use) return { totalKm: 0, businessKm: 0, personalKm: 0, fuelCost: 0, depreciation: 0 };
    let totalKm = 0, businessKm = 0, personalKm = 0, fuelCost = 0, depreciation = 0;
    for (const r of use) {
      totalKm    += r.totalKm;
      businessKm += r.businessKm;
      personalKm += r.personalKm;
      fuelCost   += estimateFuelCost(r);
      depreciation += estimateDepreciation(r);
    }
    return { totalKm, businessKm, personalKm, fuelCost, depreciation };
  }, [rows, filteredRows]);

  if (!sub) return <div style={st.muted}>구독 상태 로딩 중...</div>;
  if (!sub.active) {
    return (
      <Card title="월간 리포트 — 구독 필요">
        <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6 }}>
          운행 리포트 구독을 활성화하면 월간 리포트도 함께 이용 가능합니다.
        </div>
      </Card>
    );
  }

  const fmtKm  = (n) => n < 1 ? '0' : n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString();
  const fmtWon = (n) => n.toLocaleString() + '원';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="no-print" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="month" value={ym} onChange={e => setYm(e.target.value || ymKST())}
          style={{ ...st.dateInput, minWidth: 130 }} />
        <button onClick={() => setDlOpen(true)} style={{
          ...st.btnPrimary, display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <Icon name="share" size={13} /> 운행일지 다운로드
        </button>
        <FuelPriceBadge prices={fuelPrices} />
      </div>

      <StatCardGrid>
        <StatCard icon="bar"    label="총 주행거리"   value={fmtKm(totals.totalKm)}    unit="km" tone="default" loading={loading} />
        <StatCard icon="route"  label="업무거리"     value={fmtKm(totals.businessKm)} unit="km" tone="primary" loading={loading} />
        <StatCard icon="mapPin" label="개인거리"     value={fmtKm(totals.personalKm)} unit="km" tone="default" loading={loading} />
        <StatCard icon="coin"   label="유류비 추정"   value={fmtWon(Math.round(totals.fuelCost))} tone="warn" loading={loading}
          hint="연비 미입력 차량은 제외" />
        <StatCard icon="bar"    label="감가상각 인정" value={fmtWon(Math.round(totals.depreciation))} tone="primary" loading={loading}
          hint="5년 정액법 × 업무비율 · 한도 800만/년" />
      </StatCardGrid>

      {/* (Stage-4G) 부서 필터 chips — 부서가 2개 이상일 때만 표시 */}
      {departments.length >= 2 && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 700, marginRight: 4 }}>부서</span>
          <FilterChip active={!depFilter || depFilter.size === 0} onClick={() => setDepFilter(null)}
            label="전체" count={rows?.length ?? 0} />
          {departments.map(dep => {
            const cnt = (rows || []).filter(r => (r.department || '(부서없음)') === dep).length;
            const on = depFilter?.has(dep);
            return (
              <FilterChip key={dep} active={on}
                onClick={() => setDepFilter(prev => {
                  const s = new Set(prev ?? []);
                  if (s.has(dep)) s.delete(dep); else s.add(dep);
                  return s.size === 0 ? null : s;
                })}
                label={dep} count={cnt} tone={on ? 'success' : 'default'} />
            );
          })}
        </div>
      )}

      {error && <div style={{ ...st.muted, color: 'var(--danger)' }}>{error}</div>}
      {loading && !rows && <div style={st.muted}>월간 데이터 로딩 중...</div>}
      {rows && rows.length === 0 && <div style={st.muted}>차량이 없습니다.</div>}

      {rows && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(filteredRows || rows).length === 0 && (
            <div style={st.muted}>선택한 부서에 차량이 없습니다.</div>
          )}
          {(filteredRows || rows).map(r => (
            <MonthlyDeviceRow key={r.id} row={r} onEdit={() => setEditing(r)} />
          ))}
        </div>
      )}

      {editing && (
        <FuelInfoDialog device={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); setTick(t => t + 1); }} />
      )}

      {dlOpen && (
        <DownloadDialog ym={ym} devices={devices}
          initialDepartments={depFilter ? Array.from(depFilter) : null}
          onClose={() => setDlOpen(false)} />
      )}
    </div>
  );
}

// (2026-07-28) Stage-4D: 유가 배지 — 오피넷 실 데이터 or fallback 표시.
function FuelPriceBadge({ prices }) {
  const isLive = prices?.source === 'opinet';
  const at = prices?.updated_at ? new Date(prices.updated_at).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' }) : '';
  return (
    <div style={{
      marginLeft: 'auto',
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '4px 10px', borderRadius: 8,
      background: isLive
        ? 'color-mix(in srgb, var(--accent) 10%, transparent)'
        : 'var(--surface-2)',
      fontSize: 10, color: 'var(--text-2)',
    }}
    title={isLive ? `오피넷 실시간 (${at})` : '오피넷 KEY 미설정 — 기본값 사용'}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: isLive ? 'var(--accent)' : 'var(--text-3)',
      }} />
      <span style={{ fontWeight: 700 }}>유가</span>
      {prices ? (
        <>
          <span>휘{Math.round(prices.gasoline).toLocaleString()}</span>
          <span>·경{Math.round(prices.diesel).toLocaleString()}</span>
          <span>·L{Math.round(prices.lpg).toLocaleString()}</span>
          {isLive && <span style={{ color: 'var(--accent)', fontWeight: 700 }}>실시간</span>}
        </>
      ) : (
        <span style={{ color: 'var(--text-3)' }}>로딩...</span>
      )}
    </div>
  );
}

// (2026-07-28) Stage-4C-2: 운행일지 다운로드 다이얼로그.
// 이미지 1 (cartax) 스타일: 양식 선택 + 차량 선택 + 기간 + 운행목적 필터.
// 백엔드 /corporate/report.xlsx?type=&month=&device_ids=&purposes= 로 전송.
const PURPOSE_ALL = [
  { id: 'business',    label: '업무' },
  { id: 'commute',     label: '출퇴근' },
  { id: 'other',       label: '기타' },
  { id: 'unspecified', label: '미지정' },
];

function DownloadDialog({ ym, devices, initialDepartments, onClose }) {
  const [kind, setKind] = useState('nts');
  // null = 전체. Set<number> = 선택 차량 id.
  const [selectedDevs, setSelectedDevs] = useState(null);
  // null = 전체. Set<string> = 선택 목적.
  const [selectedPurps, setSelectedPurps] = useState(null);
  // null = 전체. Set<string> = 선택 부서. (Stage-4G, MonthlyReport 부서 필터 초기값 승계)
  const [selectedDeps, setSelectedDeps] = useState(initialDepartments ? new Set(initialDepartments) : null);
  const [busy, setBusy] = useState(false);

  const departmentOptions = useMemo(() => {
    const s = new Set();
    for (const d of devices || []) s.add(d.department || '(부서없음)');
    return Array.from(s).sort();
  }, [devices]);

  const allDevIds = useMemo(() => new Set((devices || []).map(d => d.id)), [devices]);
  const isAllDev = !selectedDevs || selectedDevs.size === allDevIds.size;

  function toggleDev(id) {
    setSelectedDevs(prev => {
      const s = new Set(prev ?? []);
      if (s.has(id)) s.delete(id); else s.add(id);
      return s;
    });
  }
  function togglePurp(p) {
    setSelectedPurps(prev => {
      const s = new Set(prev ?? []);
      if (s.has(p)) s.delete(p); else s.add(p);
      return s;
    });
  }

  async function download() {
    setBusy(true);
    try {
      const params = { type: kind, month: ym };
      if (selectedDevs && !isAllDev) params.device_ids = Array.from(selectedDevs);
      if (selectedPurps && selectedPurps.size > 0 && selectedPurps.size < PURPOSE_ALL.length) {
        params.purposes = Array.from(selectedPurps);
      }
      if (selectedDeps && selectedDeps.size > 0 && selectedDeps.size < departmentOptions.length) {
        params.departments = Array.from(selectedDeps);
      }
      const { blob, filename } = await api.reportXlsx(params);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onClose();
    } catch (e) {
      alertDialog({ title: '다운로드 실패', body: e.message, tone: 'danger' });
    } finally { setBusy(false); }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 900,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--surface)', borderRadius: 14, padding: 20,
        width: '100%', maxWidth: 520, maxHeight: '90vh', overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800 }}>운행일지 다운로드</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>
            {ym} · {devices?.length || 0}대 차량 · XLSX
          </div>
        </div>

        {/* 양식 */}
        <FieldSection label="양식">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {[
              { id: 'nts',  title: '국세청 운행기록부', hint: '별지 제73호 · 세무 신고' },
              { id: 'ours', title: '우리 양식',         hint: '요약 + 차량별 상세 · 실무용' },
            ].map(o => {
              const on = kind === o.id;
              return (
                <button key={o.id} onClick={() => setKind(o.id)} style={{
                  padding: '12px', borderRadius: 10, cursor: 'pointer',
                  textAlign: 'left', border: '2px solid ' + (on ? 'var(--primary)' : 'var(--border)'),
                  background: on ? 'color-mix(in srgb, var(--primary) 8%, transparent)' : 'var(--surface)',
                }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: on ? 'var(--primary)' : 'var(--text)' }}>
                    {o.title}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>{o.hint}</div>
                </button>
              );
            })}
          </div>
        </FieldSection>

        {/* 차량 */}
        <FieldSection label="차량" trailing={
          <button onClick={() => setSelectedDevs(isAllDev ? new Set() : null)}
            style={{ ...st.btnGhost, fontSize: 11 }}>
            {isAllDev ? '개별 선택' : '전체'}
          </button>
        }>
          {isAllDev ? (
            <div style={{
              padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 8,
              fontSize: 12, color: 'var(--text-2)',
            }}>
              전체 {devices?.length || 0}대
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
              {(devices || []).map(d => {
                const on = selectedDevs?.has(d.id);
                return (
                  <label key={d.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
                    background: on ? 'color-mix(in srgb, var(--primary) 8%, transparent)' : 'var(--surface-2)',
                  }}>
                    <input type="checkbox" checked={!!on} onChange={() => toggleDev(d.id)} />
                    <span style={{ fontSize: 12, fontWeight: 600 }}>
                      {d.license_plate || d.display_name || d.device_uid}
                    </span>
                    {d.department && (
                      <span style={{ fontSize: 10, color: 'var(--text-3)' }}>· {d.department}</span>
                    )}
                  </label>
                );
              })}
              <div style={{ fontSize: 11, color: 'var(--text-3)', paddingLeft: 12 }}>
                {selectedDevs?.size || 0} / {devices?.length || 0} 선택
              </div>
            </div>
          )}
        </FieldSection>

        {/* 기간 (readonly, 상단 month picker 로 조정) */}
        <FieldSection label="기간">
          <div style={{
            padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 8,
            fontSize: 12, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <Icon name="clock" size={12} />
            {ym} (한 달)
            <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-3)' }}>
              다른 달은 리포트 상단 월 선택으로 변경
            </span>
          </div>
        </FieldSection>

        {/* (Stage-4G) 부서 — 부서 옵션이 2개 이상일 때만 표시 */}
        {departmentOptions.length >= 2 && (
          <FieldSection label="부서" trailing={
            <button onClick={() => setSelectedDeps(prev => prev == null ? new Set() : null)}
              style={{ ...st.btnGhost, fontSize: 11 }}>
              {selectedDeps == null ? '개별 선택' : '전체'}
            </button>
          }>
            {selectedDeps == null ? (
              <div style={{
                padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 8,
                fontSize: 12, color: 'var(--text-2)',
              }}>
                전체 {departmentOptions.length}개 부서
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 4 }}>
                {departmentOptions.map(dep => {
                  const on = selectedDeps?.has(dep);
                  return (
                    <label key={dep} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
                      background: on ? 'color-mix(in srgb, var(--primary) 8%, transparent)' : 'var(--surface-2)',
                      fontSize: 12, fontWeight: 600,
                    }}>
                      <input type="checkbox" checked={!!on} onChange={() => setSelectedDeps(prev => {
                        const s = new Set(prev ?? []);
                        if (s.has(dep)) s.delete(dep); else s.add(dep);
                        return s;
                      })} />
                      {dep}
                    </label>
                  );
                })}
              </div>
            )}
          </FieldSection>
        )}

        {/* 운행목적 */}
        <FieldSection label="운행목적" trailing={
          <button onClick={() => setSelectedPurps(prev => prev == null ? new Set() : null)}
            style={{ ...st.btnGhost, fontSize: 11 }}>
            {selectedPurps == null ? '개별 선택' : '전체'}
          </button>
        }>
          {selectedPurps == null ? (
            <div style={{
              padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 8,
              fontSize: 12, color: 'var(--text-2)',
            }}>
              전체 (업무·출퇴근·기타·미지정)
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4 }}>
              {PURPOSE_ALL.map(p => {
                const on = selectedPurps?.has(p.id);
                return (
                  <label key={p.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
                    background: on ? 'color-mix(in srgb, var(--primary) 8%, transparent)' : 'var(--surface-2)',
                    fontSize: 12, fontWeight: 600,
                  }}>
                    <input type="checkbox" checked={!!on} onChange={() => togglePurp(p.id)} />
                    {p.label}
                  </label>
                );
              })}
            </div>
          )}
        </FieldSection>

        {/* 액션 */}
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button onClick={onClose} disabled={busy} style={{ ...st.btnGhost, flex: 1 }}>취소</button>
          <button onClick={download} disabled={busy} style={{
            ...st.btnPrimary, flex: 2, padding: '12px', fontSize: 13, gap: 8,
          }}>
            <Icon name="share" size={14} />
            {busy ? '생성 중...' : 'XLSX 다운로드'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldSection({ label, trailing, children }) {
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontSize: 11, fontWeight: 700, color: 'var(--text-2)', marginBottom: 6,
        letterSpacing: '0.04em', textTransform: 'uppercase',
      }}>
        <span>{label}</span>
        {trailing}
      </div>
      {children}
    </div>
  );
}

function estimateFuelCost(r) {
  // 사용자가 직접 trip_annotations 에 입력한 비용이 있으면 그것 우선.
  if (r.annotationCost > 0) return r.annotationCost;
  if (!r.fuel_efficiency_kmpl || !r.fuel_type) return 0;
  const price = FUEL_PRICE_KRW[r.fuel_type] ?? 0;
  if (price === 0) return 0;
  return (r.totalKm / r.fuel_efficiency_kmpl) * price;
}

// (2026-07-28) Stage-4E: 감가상각 인정액 (월 · 업무비율 반영).
// 국세청 기준: 5년 정액법 (연 20%). 잔존가액 없음.
//   월 감가상각액 = 취득가액 / 5년 / 12월
//   인정 감가상각 = 월 감가상각 × 업무비율
// 참고: 800만원/년 한도 (2020년 세법 개정) 이월 규정은 복잡 → 하이라이트만 표시.
const YEARLY_BIZ_LIMIT_KRW = 8_000_000;   // 연 800만원 한도 (참고)
function estimateDepreciation(r) {
  if (!r.purchase_price_krw || r.purchase_price_krw <= 0) return 0;
  const monthlyDep = r.purchase_price_krw / 5 / 12;
  const total = r.totalKm || 0;
  const bizRate = total > 0 ? (r.businessKm / total) : 0;
  return monthlyDep * bizRate;
}

function MonthlyDeviceRow({ row, onEdit }) {
  const cost = estimateFuelCost(row);
  const dep  = estimateDepreciation(row);
  const total = row.totalKm || 1;   // divide-by-zero 방지
  const bizPct = Math.round((row.businessKm / total) * 100);
  const perPct = 100 - bizPct;
  const fmtKm = (n) => n < 1 ? '0' : n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString();
  // 감가상각 연 800만 한도 초과 여부 힌트 (월 66.7만 초과 = 연 800만 override)
  const overLimit = dep > (YEARLY_BIZ_LIMIT_KRW / 12);

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{row.label}</span>
            {row.license_plate && (
              <span style={{
                fontSize: 10, padding: '2px 6px', borderRadius: 4,
                background: 'var(--surface-2)', color: 'var(--text-2)', fontWeight: 700,
                letterSpacing: '0.02em',
              }}>{row.license_plate}</span>
            )}
            {row.department && (
              <span style={{
                fontSize: 10, padding: '2px 6px', borderRadius: 4,
                background: 'color-mix(in srgb, var(--primary) 12%, transparent)',
                color: 'var(--primary)', fontWeight: 600,
              }}>{row.department}</span>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
            {row.fuel_efficiency_kmpl
              ? `${FUEL_LABEL[row.fuel_type] || '?'} · ${row.fuel_efficiency_kmpl}km/L`
              : <span style={{ color: 'var(--warning)' }}>연비 미입력</span>}
            {row.model_year && ` · ${row.model_year}년식`}
            {row.engine_cc  && ` · ${row.engine_cc.toLocaleString()}cc`}
            {row.annotationCount > 0 && ' · 실 입력비 반영'}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontWeight: 700, fontSize: 15, fontVariantNumeric: 'tabular-nums' }}>
            {fmtKm(row.totalKm)}<span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 3 }}>km</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--primary)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            {cost > 0 ? Math.round(cost).toLocaleString() + '원' : '–'}
          </div>
        </div>
        <button onClick={onEdit} style={{
          fontSize: 11, padding: '6px 10px', borderRadius: 8,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          color: 'var(--text-2)', cursor: 'pointer', fontWeight: 600,
        }}>
          정보 편집
        </button>
      </div>

      {/* stacked bar: business (primary) + personal (accent muted) */}
      <div style={{ height: 8, borderRadius: 4, background: 'var(--surface-2)', overflow: 'hidden', display: 'flex' }}>
        {row.businessKm > 0 && (
          <div style={{ width: `${bizPct}%`, background: 'var(--primary)' }} title={`업무 ${fmtKm(row.businessKm)}km`} />
        )}
        {row.personalKm > 0 && (
          <div style={{ width: `${perPct}%`, background: 'var(--accent)', opacity: 0.6 }} title={`개인 ${fmtKm(row.personalKm)}km`} />
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-3)' }}>
        <span>업무 {fmtKm(row.businessKm)}km · {bizPct}%</span>
        <span>개인 {fmtKm(row.personalKm)}km · {perPct}%</span>
      </div>

      {/* (2026-07-28) Stage-4E 감가상각 인정액 (취득가액 입력된 경우만) */}
      {row.purchase_price_krw > 0 && (
        <div style={{
          fontSize: 11, color: 'var(--text-2)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '6px 10px', background: 'var(--surface-2)', borderRadius: 6, marginTop: 2,
        }}>
          <span>
            <span style={{ color: 'var(--text-3)' }}>감가상각 인정</span>
            <span style={{ marginLeft: 6, fontWeight: 700, color: 'var(--primary)' }}>
              {Math.round(dep).toLocaleString()}원
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-3)', marginLeft: 4 }}>
              (월 {Math.round(row.purchase_price_krw / 60).toLocaleString()} × {bizPct}%)
            </span>
          </span>
          {overLimit && (
            <span style={{
              fontSize: 10, padding: '2px 6px', borderRadius: 4,
              background: 'color-mix(in srgb, var(--warning) 15%, transparent)',
              color: 'var(--warning)', fontWeight: 700,
            }} title="연 800만원 한도 초과분은 이월 처리 (세법 개정 2020)">
              한도 초과
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// (2026-07-28) Stage-4B-1: FuelInfoDialog → VehicleInfoDialog 로 확장.
// 국세청 별지 제73호 헤더 필드 (번호판/연식/배기량/취득가액/취득일) + 우리 전용 (부서/차종)
// + 연비/연료 (Stage-3A) 을 한 화면에서 편집. 저장 시 두 endpoint (fuel-info, vehicle-info)
// 를 병렬 호출 (별개 트랜잭션이지만 UX 는 한 번의 저장).
const VEHICLE_TYPE_LABEL = { sedan: '승용', van: '승합', truck: '화물', special: '특수', ev: '전기' };

function FuelInfoDialog({ device, onClose, onSaved }) {
  // 연비/연료 (fuel-info)
  const [eff,  setEff]  = useState(device.fuel_efficiency_kmpl ?? '');
  const [type, setType] = useState(device.fuel_type ?? 'gasoline');
  // 국세청 헤더 (vehicle-info)
  const [plate,       setPlate]       = useState(device.license_plate      ?? '');
  const [modelYear,   setModelYear]   = useState(device.model_year         ?? '');
  const [engineCc,    setEngineCc]    = useState(device.engine_cc          ?? '');
  const [purchase,    setPurchase]    = useState(device.purchase_price_krw ?? '');
  const [acquiredAt,  setAcquiredAt]  = useState(device.acquired_at        ?? '');
  const [department,  setDepartment]  = useState(device.department         ?? '');
  const [vehicleType, setVehicleType] = useState(device.vehicle_type       ?? 'sedan');
  // (2026-07-28) Stage-4C-1: 사용가능 + 메모
  const [enabled,     setEnabled]     = useState(device.enabled !== false);
  const [note,        setNote]        = useState(device.note ?? '');
  const [busy, setBusy] = useState(false);

  async function save() {
    const eN = eff === '' ? null : Number(eff);
    if (eN !== null && (isNaN(eN) || eN < 1 || eN > 100)) {
      alertDialog({ title: '연비 범위 오류', body: '1 ~ 100 km/L 범위로 입력하세요.', tone: 'danger' });
      return;
    }
    const myN = modelYear === '' ? null : parseInt(modelYear, 10);
    if (myN !== null && (isNaN(myN) || myN < 1990 || myN > 2100)) {
      alertDialog({ title: '연식 범위 오류', body: '1990 ~ 2100 범위로 입력하세요.', tone: 'danger' });
      return;
    }
    const ccN = engineCc === '' ? null : parseInt(engineCc, 10);
    const pN  = purchase === '' ? null : parseInt(purchase, 10);
    setBusy(true);
    try {
      await Promise.all([
        api.setFuelInfo(device.id, {
          fuel_efficiency_kmpl: eN,
          fuel_type: eN === null ? null : type,
        }),
        api.setVehicleInfo(device.id, {
          license_plate:      plate.trim()      || null,
          model_year:         myN,
          engine_cc:          ccN,
          purchase_price_krw: pN,
          acquired_at:        acquiredAt || null,
          department:         department.trim() || null,
          vehicle_type:       vehicleType || null,
          enabled:            enabled,
          note:               note.trim() || null,
        }),
      ]);
      onSaved();
    } catch (e) {
      alertDialog({ title: '저장 실패', body: e.message, tone: 'danger' });
    } finally { setBusy(false); }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 900,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--surface)', borderRadius: 14, padding: 20,
        width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{device.label} — 차량 정보</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
            국세청 별지 제73호 헤더 + 우리 전용 필드. 미입력 항목은 비어둬도 됩니다.
          </div>
        </div>

        {/* ─── 국세청 헤더 ───────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--primary)', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            국세청 별지 제73호 헤더
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>차량번호</div>
              <input value={plate} onChange={e => setPlate(e.target.value)} placeholder="12가3456" style={st.input} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>연식</div>
              <input type="number" min="1990" max="2100" value={modelYear}
                onChange={e => setModelYear(e.target.value)} placeholder="예: 2023" style={st.input} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>배기량 (cc)</div>
              <input type="number" value={engineCc}
                onChange={e => setEngineCc(e.target.value)} placeholder="예: 1998" style={st.input} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>취득가액 (원)</div>
              <input type="number" value={purchase}
                onChange={e => setPurchase(e.target.value)} placeholder="예: 35000000" style={st.input} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>취득일</div>
              <input type="date" value={acquiredAt || ''}
                onChange={e => setAcquiredAt(e.target.value)} style={st.input} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>차량 유형</div>
              <select value={vehicleType} onChange={e => setVehicleType(e.target.value)} style={st.input}>
                {Object.entries(VEHICLE_TYPE_LABEL).map(([id, label]) => (
                  <option key={id} value={id}>{label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* ─── 우리 전용 ─────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            우리 전용
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>부서/그룹</div>
            <input value={department} onChange={e => setDepartment(e.target.value)}
              placeholder="영업 1팀, 본사 임원차..." style={st.input} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>메모</div>
            <textarea value={note} onChange={e => setNote(e.target.value)}
              placeholder="정비 이력·특이사항..." maxLength={500}
              style={{ ...st.input, minHeight: 60, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>
          {/* 사용가능 toggle (2026-07-28 Stage-4C-1) */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 8,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 700 }}>사용가능</div>
              <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                사용정지 시 차량 목록에서 흐리게 표시. 리포트에는 계속 반영 (과거 데이터 유지).
              </div>
            </div>
            <button onClick={() => setEnabled(v => !v)} style={{
              width: 44, height: 24, borderRadius: 999,
              background: enabled ? 'var(--accent)' : 'var(--text-3)',
              border: 'none', cursor: 'pointer', position: 'relative',
              transition: 'background .15s',
            }}>
              <div style={{
                position: 'absolute', top: 2, left: enabled ? 22 : 2,
                width: 20, height: 20, borderRadius: '50%', background: 'white',
                transition: 'left .15s',
              }} />
            </button>
          </div>
        </div>

        {/* ─── 연비 / 연료 ───────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--warning)', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            연비 · 유류비 추정
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>연료</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
              {['gasoline', 'diesel', 'lpg', 'ev'].map(f => (
                <button key={f} onClick={() => setType(f)} style={{
                  padding: '8px 4px', fontSize: 12, borderRadius: 8, cursor: 'pointer',
                  background: type === f ? 'var(--primary)' : 'var(--surface-2)',
                  color:      type === f ? 'var(--primary-fg)' : 'var(--text)',
                  border: 'none', fontWeight: type === f ? 700 : 500,
                }}>{FUEL_LABEL[f]}</button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>연비 (km/L)</div>
            <input type="number" step="0.1" min="1" max="100"
              value={eff} onChange={e => setEff(e.target.value)} placeholder="예: 12.5" style={st.input} />
            <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 4 }}>
              비워두면 유류비 자동 추정 skip.
            </div>
          </div>
        </div>

        {/* ─── 서류 (2026-07-28 Stage-4C-3) ─────────── */}
        {device.id && <DocumentsSection deviceId={device.id} />}

        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button onClick={onClose} disabled={busy} style={{ ...st.btnGhost, flex: 1 }}>취소</button>
          <button onClick={save} disabled={busy} style={{ ...st.btnPrimary, flex: 1 }}>
            {busy ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}

// (2026-07-28) Stage-4C-3: 차량 서류 (등록증/보험/정비영수증) 업로드 섹션.
// VehicleInfoDialog 내부. 리스트 + 파일 선택 (kind + optional note) + 다운로드/삭제.
const DOC_KIND_LABEL = {
  registration: '등록증',
  insurance:    '보험',
  inspection:   '검사',
  receipt:      '영수증',
  other:        '기타',
};

function DocumentsSection({ deviceId }) {
  const [docs, setDocs] = useState(null);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState('registration');
  const [note, setNote] = useState('');
  const fileRef = useRef(null);

  async function load() {
    try { setDocs(await api.listDocuments(deviceId)); }
    catch { setDocs([]); }
  }
  useEffect(() => { load(); }, [deviceId]);   // eslint-disable-line

  async function upload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      alertDialog({ title: '파일 크기 초과', body: '최대 10MB', tone: 'danger' });
      e.target.value = '';
      return;
    }
    setBusy(true);
    try {
      await api.uploadDocument(deviceId, { file, kind, note: note.trim() || null });
      setNote(''); e.target.value = '';
      load();
    } catch (err) {
      alertDialog({ title: '업로드 실패', body: err.message, tone: 'danger' });
    } finally { setBusy(false); }
  }

  async function download(d) {
    try {
      const { blob, filename } = await api.documentDownloadUrl(d.id)();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      alertDialog({ title: '다운로드 실패', body: e.message, tone: 'danger' });
    }
  }

  async function del(d) {
    const ok = await confirmDialog({ title: '서류 삭제', body: `${d.filename} 을(를) 삭제하시겠습니까?`, danger: true });
    if (!ok) return;
    try { await api.deleteDocument(d.id); load(); }
    catch (e) { await alertDialog({ title: '삭제 실패', body: e.message, tone: 'danger' }); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--danger)', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        서류 (PDF/이미지 · 10MB · 20개)
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 6 }}>
        <select value={kind} onChange={e => setKind(e.target.value)} style={st.input}>
          {Object.entries(DOC_KIND_LABEL).map(([id, label]) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
        <input value={note} onChange={e => setNote(e.target.value)}
          placeholder="메모 (선택)" style={st.input} />
      </div>
      <div>
        <input ref={fileRef} type="file" accept=".pdf,image/*" onChange={upload} disabled={busy}
          style={{ display: 'none' }} />
        <button onClick={() => fileRef.current?.click()} disabled={busy} style={{
          ...st.btnGhost, width: '100%', padding: '10px', fontSize: 12,
        }}>
          <Icon name="plus" size={12} /> {busy ? '업로드 중...' : '파일 선택'}
        </button>
      </div>

      {docs && docs.length === 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-3)', textAlign: 'center', padding: 8 }}>
          등록된 서류 없음
        </div>
      )}
      {docs && docs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {docs.map(d => (
            <div key={d.id} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 6,
              fontSize: 11,
            }}>
              <span style={{
                fontSize: 9, padding: '2px 6px', borderRadius: 3,
                background: 'var(--surface)', color: 'var(--text-2)', fontWeight: 700,
              }}>{DOC_KIND_LABEL[d.kind] || d.kind}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={d.filename}>{d.filename}</span>
              <span style={{ color: 'var(--text-3)', fontSize: 10 }}>{Math.round(d.size_bytes / 1024).toLocaleString()}KB</span>
              <button onClick={() => download(d)} style={{ ...st.btnGhost, padding: '4px 8px' }} title="다운로드">
                <Icon name="share" size={11} />
              </button>
              <button onClick={() => del(d)} style={{ ...st.btnGhost, padding: '4px 8px', color: 'var(--danger)' }} title="삭제">
                <Icon name="trash2" size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Fleet 요약 상단 (2026-07-28) ──────────────────────
// device drill-down 위에 얹는 4-card row. 첨부 이미지 스타일 (아이콘 + 큰 숫자).
// tone 은 정보 성격별 색 구분: 운행중=success (초록), km=primary (파랑).
function FleetSummary({ devices }) {
  const s = useFleetStats(devices);
  const fmt = (n) => (n == null ? '–' : n.toLocaleString());
  return (
    <div className="no-print">
      <StatCardGrid>
        <StatCard icon="list"   label="전체 차량"       value={fmt(s.totalCount)} unit="대" tone="default" loading={s.loading} />
        <StatCard icon="route"  label="운행 중"         value={fmt(s.activeCount)} unit="대" tone="success" loading={s.loading} />
        <StatCard icon="mapPin" label="오늘 운행거리"   value={fmt(s.todayKm)} unit="km" tone="primary" loading={s.loading} />
        <StatCard icon="bar"    label="이번달 운행거리" value={fmt(s.monthKm)} unit="km" tone="default" loading={s.loading} />
      </StatCardGrid>
    </div>
  );
}

// ─── 공용 sub-컴포넌트 ─────────────────────────────────
function Card({ title, children }) {
  return (
    <div style={st.card}>
      {title && <div style={st.cardTitle}>{title}</div>}
      {children}
    </div>
  );
}

// 사용처 두 군데:
//  1) value/onChange 받으면 단순 input (info/staff form 용)
//  2) children 받으면 children 그대로 (TripEditorModal 의 복합 필드용)
function Field({ label, value, onChange, placeholder, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>{label}</div>
      {children != null ? children : (
        <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
          style={st.input} />
      )}
    </div>
  );
}

// ─── TripEditorModal 전용 스타일 ─────────────────────
const mst = {
  backdrop: {
    position: 'fixed', inset: 0, zIndex: 900,
    background: 'rgba(0,0,0,0.5)',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16,
    animation: 'fadeInUp .15s ease-out',
  },
  modal: {
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 14,
    width: '100%', maxWidth: 460, overflow: 'hidden',
    boxShadow: '0 20px 60px rgba(0,0,0,.4)',
    animation: 'fadeInUp .18s ease-out',
    display: 'flex', flexDirection: 'column',
    maxHeight: '90vh',
  },
  header: {
    display: 'flex', alignItems: 'flex-start', gap: 8,
    padding: '14px 16px', borderBottom: '1px solid var(--border)',
  },
  closeBtn: {
    width: 28, height: 28, borderRadius: 6,
    background: 'transparent', color: 'var(--text-3)',
    border: 'none', cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  body: {
    padding: 16, overflowY: 'auto', flex: 1,
  },
  input: {
    display: 'block', width: '100%', padding: '8px 10px',
    background: 'var(--surface-2)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6,
    fontSize: 13, boxSizing: 'border-box', outline: 'none',
  },
  actions: {
    display: 'flex', gap: 8, padding: '12px 16px',
    borderTop: '1px solid var(--border)',
  },
  btnPrimary: {
    flex: 1, padding: '10px 16px',
    background: 'var(--primary)', color: 'white',
    border: 'none', borderRadius: 8,
    fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  btnSecondary: {
    flex: 1, padding: '10px 16px',
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 8,
    fontSize: 13, cursor: 'pointer',
  },
};

function kstDate(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function kstTime(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return d.toISOString().slice(11, 16);
}

const st = {
  wrap: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  tabBar: {
    display: 'flex', overflowX: 'auto', flexShrink: 0,
    background: 'var(--surface)', borderBottom: '1px solid var(--border)',
  },
  tabBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '10px 14px', fontSize: 12, cursor: 'pointer',
    background: 'transparent', border: 'none',
    whiteSpace: 'nowrap', flexShrink: 0,
  },
  body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 12 },
  card: {
    background: 'var(--surface-2)', border: '1px solid var(--border)',
    borderRadius: 10, padding: 12, marginBottom: 10,
  },
  cardTitle: {
    fontWeight: 700, fontSize: 11, color: 'var(--text-2)',
    textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8,
  },
  // (2026-07-28) 트렌디 리팩터 — 넓은 카드 + 헤더 (Staff/Info tab 등 재사용)
  sectionCard: {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 14, overflow: 'hidden',
  },
  sectionCardHeader: {
    padding: '12px 16px', borderBottom: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    fontSize: 13, fontWeight: 700, color: 'var(--text)',
    background: 'var(--surface-2)',
  },
  input: {
    display: 'block', width: '100%', padding: '8px 10px',
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 6, color: 'var(--text)', fontSize: 13, boxSizing: 'border-box',
  },
  controls: {
    display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
    marginBottom: 12, padding: '0 4px',
  },
  filters: {
    display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
    marginBottom: 12, padding: '0 4px',
  },
  select: {
    flex: 1, minWidth: 160, padding: '8px 10px',
    background: 'var(--surface-2)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6, fontSize: 13,
  },
  dateInput: {
    padding: '7px 10px', fontSize: 13,
    background: 'var(--surface-2)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6,
  },
  btnPrimary: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: '8px 14px',
    background: 'var(--primary)', color: 'white',
    border: 'none', borderRadius: 6, cursor: 'pointer',
    fontSize: 12, fontWeight: 600,
  },
  btnGhost: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '6px 10px', fontSize: 11,
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
  },
  reportArea: {
    background: 'var(--surface)', padding: 16,
    border: '1px solid var(--border)', borderRadius: 8,
  },
  reportHead: { marginBottom: 16 },
  headerTable: {
    width: '100%', borderCollapse: 'collapse', fontSize: 12,
  },
  tripsTableScroll: {
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
    marginTop: 8,
  },
  tripsTable: {
    width: '100%', minWidth: 720,
    borderCollapse: 'collapse', fontSize: 11,
  },
  th: {
    background: 'var(--surface-2)', fontWeight: 700,
    padding: '6px 8px', textAlign: 'left',
    border: '1px solid var(--border)', whiteSpace: 'nowrap',
  },
  td: {
    padding: '6px 8px', border: '1px solid var(--border)',
    verticalAlign: 'top',
  },
  muted: { color: 'var(--text-3)', fontSize: 12, padding: 16, textAlign: 'center' },
};
