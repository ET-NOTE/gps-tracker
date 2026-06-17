// 어제의 운행 요약 팝업 — B 스타일: indigo 배너 헤더 + 2열 stat 카드.
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

        {/* ── 컬러 배너 헤더 ── */}
        <div style={st.banner}>
          <button onClick={onClose} style={st.closeBtn} title="닫기">
            <Icon name="close" size={13} />
          </button>
          <div style={st.bannerIcon}>
            <Icon name="route" size={18} />
          </div>
          <div style={st.bannerTitle}>어제의 운행 요약</div>
          <div style={st.bannerSub}>
            {deviceName || '디바이스'}&nbsp;·&nbsp;{dateStr}
          </div>
        </div>

        {/* ── 본문 ── */}
        <div style={st.body}>
          {empty ? (
            <div style={st.empty}>
              어제 기록이 없습니다.<br />
              <span style={{ color: 'var(--text-3)' }}>운행이 없었거나 일별 집계가 아직 반영 전 (최대 5분).</span>
            </div>
          ) : (
            <div style={st.grid}>
              <Stat label="이동거리" value={km(stats.distance_m)} unit="km" />
              <Stat label="운행시간" value={fmtDur(stats.moving_s)} unit="" />
              <Stat label="정지구간" value={String(stats.stop_count)} unit="회" />
              <Stat label="최고속도" value={(stats.max_speed_kmh ?? 0).toFixed(1)} unit="km/h" />
            </div>
          )}

          <div style={st.footer}>
            <button onClick={onClose} style={st.cancelBtn}>닫기</button>
            <button onClick={onClose} style={st.okBtn}>확인</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, unit }) {
  return (
    <div style={st.statCell}>
      <div style={st.statLabel}>{label}</div>
      <div style={st.statValue}>
        {value}
        {unit && <span style={st.statUnit}> {unit}</span>}
      </div>
    </div>
  );
}

const BANNER = '#4f46e5';

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
    borderRadius: 16,
    overflow: 'hidden',
    boxShadow: '0 12px 36px rgba(0,0,0,0.3)',
  },
  banner: {
    background: BANNER,
    padding: '16px 16px 18px',
    position: 'relative',
  },
  closeBtn: {
    position: 'absolute', top: 10, right: 10,
    background: 'rgba(255,255,255,0.2)',
    border: 'none', borderRadius: 6,
    width: 24, height: 24,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    color: 'white', cursor: 'pointer',
  },
  bannerIcon: {
    width: 36, height: 36, borderRadius: 10,
    background: 'rgba(255,255,255,0.18)',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    color: 'white', marginBottom: 10,
  },
  bannerTitle: {
    fontSize: 15, fontWeight: 700, color: 'white', marginBottom: 4,
  },
  bannerSub: {
    fontSize: 12, color: 'rgba(255,255,255,0.72)',
  },
  body: {
    padding: 14,
  },
  grid: {
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
    marginBottom: 12,
  },
  statCell: {
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 10, padding: '10px 12px',
  },
  statLabel: {
    fontSize: 11, color: 'var(--text-3)', marginBottom: 4,
  },
  statValue: {
    fontSize: 18, fontWeight: 700, color: 'var(--text)',
    fontVariantNumeric: 'tabular-nums',
  },
  statUnit: {
    fontSize: 12, fontWeight: 400, color: 'var(--text-2)',
  },
  empty: {
    background: 'var(--surface-2)', borderRadius: 8, padding: 16,
    textAlign: 'center', fontSize: 12, color: 'var(--text-2)',
    border: '1px dashed var(--border)',
    marginBottom: 12, lineHeight: 1.6,
  },
  footer: {
    display: 'flex', gap: 8,
  },
  cancelBtn: {
    flex: 1, padding: '9px 0',
    background: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: 10, color: 'var(--text-2)',
    fontSize: 13, fontWeight: 500, cursor: 'pointer',
  },
  okBtn: {
    flex: 2, padding: '9px 0',
    background: BANNER, color: 'white',
    border: 'none', borderRadius: 10,
    fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
};
