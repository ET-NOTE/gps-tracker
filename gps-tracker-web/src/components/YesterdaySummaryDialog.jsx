// 어제의 운행 요약 팝업 — 연구소 토글 ON 인 사용자에게 자정 이후 그 날 처음 디바이스를
// 필터하면 1회 노출. 통계 탭 (DeviceDetail StatsBody) 와 동일한 4종 KPI.
//
// 데이터 출처: api.getDailyStats(deviceId, { limit: 8 }) 의 어제 (date === yesterday).
// 없으면 (운행 없음 또는 daily_stats catchup 지연) "기록 없음" 안내.
import Icon from './Icon';

export default function YesterdaySummaryDialog({ deviceName, dateStr, stats, onClose }) {
  const km = (m) => (m / 1000).toFixed(2);
  const fmtDur = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const empty = !stats || stats.distance_m == null;

  return (
    <div style={st.overlay} onClick={onClose}>
      <div style={st.modal} onClick={(e) => e.stopPropagation()}>
        <div style={st.header}>
          <div style={{ minWidth: 0 }}>
            <div style={st.subtitle}>어제의 운행 요약</div>
            <div style={st.title}>
              <span style={st.deviceName}>{deviceName || '디바이스'}</span>
              <span style={st.date}>{dateStr}</span>
            </div>
          </div>
          <button onClick={onClose} style={st.closeBtn} title="닫기">
            <Icon name="close" size={14} />
          </button>
        </div>

        {empty ? (
          <div style={st.empty}>
            어제 기록이 없습니다.<br />
            <span style={{ color: 'var(--text-3)' }}>운행이 없었거나 일별 집계가 아직 반영 전 (최대 5분).</span>
          </div>
        ) : (
          <div style={st.grid}>
            <Stat label="이동거리" value={`${km(stats.distance_m)} km`} />
            <Stat label="운행시간" value={fmtDur(stats.moving_s)} />
            <Stat label="정지구간" value={`${stats.stop_count}회`} />
            <Stat label="최고속도" value={`${(stats.max_speed_kmh ?? 0).toFixed(1)} km/h`} />
          </div>
        )}

        <div style={st.footer}>
          <button onClick={onClose} style={st.okBtn}>확인</button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={st.statCell}>
      <div style={st.statLabel}>{label}</div>
      <div style={st.statValue}>{value}</div>
    </div>
  );
}

const st = {
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16, zIndex: 1100,
    animation: 'fadeInOnly .15s ease-out',
  },
  modal: {
    width: '100%', maxWidth: 360,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 14,
    boxShadow: '0 12px 36px rgba(0,0,0,0.3)',
    padding: 18,
  },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
    gap: 8, marginBottom: 14,
  },
  subtitle: {
    fontSize: 11, fontWeight: 700,
    color: 'var(--primary)',
    letterSpacing: '.04em',
    marginBottom: 4,
  },
  title: {
    display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
  },
  deviceName: {
    fontSize: 16, fontWeight: 700, color: 'var(--text)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    maxWidth: 200,
  },
  date: {
    fontSize: 12, color: 'var(--text-3)',
    fontVariantNumeric: 'tabular-nums',
  },
  closeBtn: {
    background: 'transparent', border: 'none', cursor: 'pointer',
    color: 'var(--text-2)',
    width: 28, height: 28, borderRadius: 6,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  grid: {
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
    marginBottom: 14,
  },
  statCell: {
    background: 'var(--surface-2)', borderRadius: 8, padding: '10px 12px',
    border: '1px solid var(--border)',
  },
  statLabel: {
    fontSize: 11, color: 'var(--text-3)', marginBottom: 3,
  },
  statValue: {
    fontSize: 18, fontWeight: 700, color: 'var(--text)',
    fontVariantNumeric: 'tabular-nums',
  },
  empty: {
    background: 'var(--surface-2)', borderRadius: 8, padding: 16,
    textAlign: 'center', fontSize: 12, color: 'var(--text-2)',
    border: '1px dashed var(--border)',
    marginBottom: 14, lineHeight: 1.6,
  },
  footer: {
    display: 'flex', justifyContent: 'flex-end',
  },
  okBtn: {
    padding: '8px 18px',
    background: 'var(--primary)', color: 'var(--primary-fg, white)',
    border: 'none', borderRadius: 6,
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
};
