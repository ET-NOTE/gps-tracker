// (2026-07-28) Phase F4-b — Fleet dashboard 상단 요약 chips.
// 참고 이미지 스타일: 운행 N대 | 대기 M대 | 오프라인 K대 (dropdown 필터 겸용).
//
// props:
//   devices: 전체 device 배열
//   filter: 'all' | 'active' | 'idle' | 'offline'
//   onChange: (next) => void

const OFFLINE_STALE_MS = 15 * 60_000;   // 15분 무통신 = offline

function classify(d) {
  if (d.last_event_kind === 'wake') return 'active';
  const t = d.last_seen_at ? new Date(d.last_seen_at).getTime() : 0;
  if (!t || Date.now() - t > OFFLINE_STALE_MS) return 'offline';
  return 'idle';
}

export default function SummaryChips({ devices = [], filter, onChange }) {
  const counts = { all: devices.length, active: 0, idle: 0, offline: 0 };
  for (const d of devices) counts[classify(d)]++;

  const chips = [
    { id: 'all',     label: '전체',    count: counts.all,     tone: 'default' },
    { id: 'active',  label: '운행',    count: counts.active,  tone: 'success' },
    { id: 'idle',    label: '대기',    count: counts.idle,    tone: 'primary' },
    { id: 'offline', label: '오프라인', count: counts.offline, tone: 'muted'   },
  ];
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
                                                  'var(--text-2)';
        return (
          <button key={c.id} onClick={() => onChange?.(c.id)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: 'var(--space-2) var(--space-3)',
              background: active ? toneColor : 'var(--surface-2)',
              color:      active ? '#FFF' : 'var(--text)',
              border: 'none', borderRadius: 'var(--radius-pill)',
              cursor: 'pointer', fontSize: 12, fontWeight: 700,
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

export { classify as classifyDevice };
