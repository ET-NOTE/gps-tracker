// (2026-07-28) Phase F4-b — Fleet dashboard 상단 요약 chips.
// 참고 이미지 스타일: 운행 N대 | 대기 M대 | 오프라인 K대 (dropdown 필터 겸용).
//
// props:
//   devices: 전체 device 배열
//   filter: 'all' | 'active' | 'idle' | 'offline'
//   onChange: (next) => void

import { FLEET_GROUPS, fleetStatusGroup } from '../../lib/fleetStatus';

export default function SummaryChips({ devices = [], filter, onChange, now = Date.now() }) {
  const counts = Object.fromEntries(FLEET_GROUPS.map(group => [group.id, 0]));
  counts.all = devices.length;
  for (const d of devices) counts[fleetStatusGroup(d, now)]++;
  const chips = FLEET_GROUPS.map(group => ({...group, count: counts[group.id]}));
  return (
    <div style={{
      display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap',
      padding: 'var(--space-3) var(--space-4)',
      borderBottom: '1px solid var(--border)',
      background: 'var(--surface)',
    }}>
      {chips.map(c => {
        const active = filter === c.id;
        const toneColor = c.tone === 'success' ? 'var(--accent)' :
                          c.tone === 'primary' ? 'var(--primary)' :
                          c.tone === 'muted'   ? 'var(--text-3)' :
                          c.tone === 'warning' ? 'var(--status-warning-text)' :
                                                  'var(--text-2)';
        return (
          <button key={c.id} aria-pressed={active} onClick={() => onChange?.(c.id)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: 'var(--space-2) var(--space-3)',
              background: active ? toneColor : 'var(--surface-2)',
              color:      active ? '#FFF' : 'var(--text)',
              border: 'none', borderRadius: 'var(--radius-pill)',
              cursor: 'pointer', fontSize: 12, fontWeight: 700, minHeight: 44,
              transition: 'all .15s',
            }}>
            <span style={{ fontWeight: 600, opacity: active ? 0.9 : 0.7 }}>{c.label}</span>
            <span style={{
              fontSize: 11, padding: '1px 8px', borderRadius: 999,
              background: active ? 'rgba(255,255,255,0.25)' : 'var(--surface)',
              color: active ? '#FFF' : toneColor,
              fontWeight: 800,
            }}>{c.count}</span>
          </button>
        );
      })}
    </div>
  );
}
