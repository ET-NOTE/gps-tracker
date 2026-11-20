import { useMemo } from 'react';
import Icon from '../Icon';
import { StatCard, StatCardGrid } from '../shared/StatCard';
import { useFleetStats } from '../shared/useFleetStats';

export default function FreightTelemetry({ devices }) {
  const s = useFleetStats(devices);
  const fmt = (n) => (n == null ? '–' : n.toLocaleString());

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <StatCardGrid>
        <StatCard icon="list"   label="연결 단말기"     value={fmt(s.totalCount)}  unit="대"  tone="default" loading={s.loading} />
        <StatCard icon="route"  label="활성 단말기"       value={fmt(s.activeCount)} unit="대"  tone="success" loading={s.loading} />
        <StatCard icon="mapPin" label="오늘 주행"     value={fmt(s.todayKm)}     unit="km"  tone="primary" loading={s.loading} />
        <StatCard icon="bar"    label="이번달 주행"   value={fmt(s.monthKm)}     unit="km"  tone="default" loading={s.loading} />
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
      <div style={st.cardTitle}>단말기 수신 내역</div>
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
              <div title={r.label} style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                {r.lastFixAt ? formatAge(r.lastFixAt) : '위치 미확인'}
              </div>
            </div>
            <span style={{
              fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0,
              padding: '4px 10px', borderRadius: 999,
              color: r.active ? 'var(--accent)' : 'var(--text-3)',
              background: r.active
                ? 'color-mix(in srgb, var(--accent) 15%, transparent)'
                : 'var(--surface-2)',
            }}>
              {r.active ? '활성' : '대기'}
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

const st = {
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
