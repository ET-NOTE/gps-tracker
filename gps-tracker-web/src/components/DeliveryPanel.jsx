// (2026-07-28) 배달 계정 전용 대시보드 (Stage-2 shell).
// CorporatePanel/RentcarPanel 과 동일 톤 — shared StatCard.
//
// 지금은 device 만 있으니:
//  · 전체 차량      = devices.length
//  · 배송 중        = last_event_kind === 'wake' 차량 수
//  · 오늘 완료      = 0 (delivery_orders 없음)
//  · 오늘 주행거리   = 병렬 listTrips 로 오늘 km
// delivery_orders 도입 시 (Stage-3) 배송 건수/완료율 등 실 지표로 대체.

import { useMemo, useState } from 'react';
import Icon from './Icon';
import { StatCard, StatCardGrid } from './shared/StatCard';
import { useFleetStats } from './shared/useFleetStats';

export default function DeliveryPanel({ devices }) {
  const [tab, setTab] = useState(() => localStorage.getItem('delivery_tab') || 'today');
  const setTabPersist = (t) => { setTab(t); try { localStorage.setItem('delivery_tab', t); } catch {} };

  const tabs = [
    { id: 'today',   label: '오늘 배송', icon: 'mapPin' },
    { id: 'route',   label: '경로 이력', icon: 'route' },
    { id: 'perf',    label: '성과',     icon: 'bar' },
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
        {tab === 'today' && <TodayTab devices={devices} />}
        {tab === 'route' && <PlaceholderTab title="경로 이력"
          hint="지난 배송 경로를 지도 위에 겹쳐 재생하는 기능은 준비 중입니다." />}
        {tab === 'perf'  && <PlaceholderTab title="배송 성과"
          hint="일별/주별 배송 건수·완료율·평균 배송 시간 리포트는 준비 중입니다." />}
      </div>
    </div>
  );
}

function TodayTab({ devices }) {
  const s = useFleetStats(devices);
  const fmt = (n) => (n == null ? '–' : n.toLocaleString());

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <StatCardGrid>
        <StatCard icon="list"   label="전체 차량"     value={fmt(s.totalCount)}  unit="대"  tone="default" loading={s.loading} />
        <StatCard icon="route"  label="배송 중"       value={fmt(s.activeCount)} unit="대"  tone="success" loading={s.loading} />
        <StatCard icon="mapPin" label="오늘 주행"     value={fmt(s.todayKm)}     unit="km"  tone="primary" loading={s.loading} />
        <StatCard icon="bar"    label="이번달 주행"   value={fmt(s.monthKm)}     unit="km"  tone="default" loading={s.loading}
          hint="배송 건수/완료율은 준비 중" />
      </StatCardGrid>

      <ActiveList devices={devices} />
    </div>
  );
}

// 배송 중인 차량 우선 위 + 위치 요약.
function ActiveList({ devices }) {
  const rows = useMemo(() => (devices || []).map(d => ({
    id: d.id,
    label: d.display_name || d.device_uid,
    active: d.last_event_kind === 'wake',
    lastFixAt: d.last_fix_at,
  })).sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0)), [devices]);

  if (!rows.length) return <div style={st.muted}>차량이 없습니다.</div>;

  return (
    <div style={st.card}>
      <div style={st.cardTitle}>배송 차량 (실시간)</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map(r => (
          <div key={r.id} style={st.vehicleRow}>
            <div style={{
              ...st.vehicleIcon,
              background: r.active
                ? 'color-mix(in srgb, var(--accent) 15%, transparent)'
                : 'var(--surface)',
              color: r.active ? 'var(--accent)' : 'var(--text-3)',
            }}>
              <Icon name={r.active ? 'route' : 'clock'} size={16} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{r.label}</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                {r.lastFixAt ? formatAge(r.lastFixAt) : '위치 미확인'}
              </div>
            </div>
            <span style={{
              fontSize: 11, fontWeight: 700,
              padding: '4px 10px', borderRadius: 999,
              color: r.active ? 'var(--accent)' : 'var(--text-3)',
              background: r.active
                ? 'color-mix(in srgb, var(--accent) 15%, transparent)'
                : 'var(--surface-2)',
            }}>
              {r.active ? '배송중' : '대기'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
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
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
};
