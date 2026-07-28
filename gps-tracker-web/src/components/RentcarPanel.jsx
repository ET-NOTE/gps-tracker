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

import { useMemo, useState } from 'react';
import Icon from './Icon';
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
        {tab === 'rentals'  && <PlaceholderTab title="임대 계약" hint="임대 계약 관리 기능은 준비 중입니다. 곧 차량-임차인-기간 매핑 및 자동 반납 리마인더가 제공됩니다." />}
        {tab === 'schedule' && <PlaceholderTab title="반납 일정" hint="달력 뷰 + 임박한 반납 알림은 준비 중입니다." />}
      </div>
    </div>
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
};
