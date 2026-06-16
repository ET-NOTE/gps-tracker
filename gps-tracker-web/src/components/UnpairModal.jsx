// 페어링 해제 모달 — 3-way 선택 (보관/완전삭제/취소).
//
// 기존 confirmDialog 2단계 플로우는 X 또는 외부 클릭 시 cancel 의도가 모호 (1단계는 cancel,
// 2단계 X 는 "보관" 으로 처리됨) → 사용자 혼란. 단일 모달로 통합 + X/외부클릭/닫기 모두
// 명시적 cancel.
//
// 백엔드 (devices.rs#unpair) 동작:
//   purge=false → owner_id NULL, share_tokens revoked. user_id stamped 데이터 (location_records,
//                 events, daily_stats, trip_annotations, geofences) 보존. 같은 계정 재페어링
//                 시 자동 복구.
//   purge=true  → 위 + 본인 user_id 의 모든 row 삭제. 단 결제 이력 (ai_analyses,
//                 sim_topup_requests) 은 자산이라 보존.
// 양쪽 모두 device row 자체와 SIM (1NCE) 정보는 보존.

import Icon from './Icon';

export default function UnpairModal({ deviceName, onClose, onKeep, onWipe, busy }) {
  return (
    // 외부 클릭으로 닫히지 않음 — 의도치 않은 cancel 방지. X / 닫기 버튼만 닫기.
    <div style={st.overlay}>
      <div style={st.modal}>
        <div style={st.header}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={st.title}>페어링 해제</div>
            <div style={st.sub}>
              {deviceName ? <>디바이스: <b>{deviceName}</b></> : '이 디바이스의 페어링을 해제합니다.'}
            </div>
          </div>
          <button onClick={onClose} disabled={busy} style={st.closeBtn} aria-label="닫기">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div style={st.notice}>
          ⓘ 두 옵션 중 하나를 명시적으로 선택해주세요. <b>X / 닫기 / 외부 클릭</b> 은 취소 (변경 없음).
        </div>

        <div style={st.optionsCol}>
          {/* 보관 (권장) */}
          <button onClick={onKeep} disabled={busy} style={{ ...st.optionCard, ...st.optionKeep }}>
            <div style={st.optionHead}>
              <span style={st.optionTitle}>📦 데이터 보관 후 해제</span>
              <span style={st.recommendBadge}>권장</span>
            </div>
            <div style={st.optionBody}>
              <Row tone="ok">위치 / 운행 / 이벤트 / 펜스 / 운행일지 보관</Row>
              <Row tone="ok">같은 계정으로 재페어링 시 <b>자동 복구</b></Row>
              <Row tone="warn">활성 공유 링크는 즉시 만료</Row>
              <Row tone="info">단말기 자체와 SIM 정보는 그대로 (다른 계정도 페어링 가능)</Row>
            </div>
          </button>

          {/* 완전 삭제 (위험) */}
          <button onClick={onWipe} disabled={busy} style={{ ...st.optionCard, ...st.optionWipe }}>
            <div style={st.optionHead}>
              <span style={st.optionTitle}>🗑 데이터까지 영구 삭제</span>
              <span style={st.dangerBadge}>위험</span>
            </div>
            <div style={st.optionBody}>
              <Row tone="bad">위치/운행/이벤트/펜스/운행일지 <b>전부 삭제</b></Row>
              <Row tone="bad"><b>복구 불가능</b></Row>
              <Row tone="ok">결제 이력 (포인트, SIM 충전, AI 분석) 은 자산이라 보존</Row>
              <Row tone="info">단말기와 SIM 정보는 보존 (다른 계정도 페어링 가능)</Row>
            </div>
          </button>
        </div>

        <div style={st.footer}>
          <button onClick={onClose} disabled={busy} style={st.btnGhost}>닫기 (취소)</button>
        </div>
      </div>
    </div>
  );
}

function Row({ tone, children }) {
  const c = tone === 'ok' ? 'var(--accent)'
          : tone === 'bad' ? 'var(--danger)'
          : tone === 'warn' ? 'var(--warning, #fbbf24)'
          : 'var(--text-3)';
  const sym = tone === 'ok' ? '✓' : tone === 'bad' ? '✕' : tone === 'warn' ? '⚠' : '·';
  return (
    <div style={{
      display: 'flex', gap: 8, alignItems: 'flex-start',
      fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5,
    }}>
      <span style={{ color: c, fontWeight: 700, flexShrink: 0, width: 12, textAlign: 'center' }}>{sym}</span>
      <span style={{ flex: 1 }}>{children}</span>
    </div>
  );
}

const st = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16, zIndex: 1100,
  },
  modal: {
    width: '100%', maxWidth: 460,
    background: 'var(--surface)', borderRadius: 14,
    padding: 20,
    boxShadow: '0 20px 50px rgba(0,0,0,0.3)',
    border: '1px solid var(--border)',
    maxHeight: '92vh', overflowY: 'auto',
  },
  header: {
    display: 'flex', alignItems: 'flex-start', gap: 8,
    marginBottom: 12,
  },
  title: { fontSize: 17, fontWeight: 700, color: 'var(--text)' },
  sub:   { fontSize: 12, color: 'var(--text-3)', marginTop: 4 },
  closeBtn: {
    background: 'transparent', border: 'none', cursor: 'pointer',
    color: 'var(--text-3)',
    width: 28, height: 28, borderRadius: 6,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  notice: {
    background: 'var(--surface-2)', border: '1px solid var(--border)',
    borderRadius: 8, padding: '8px 10px',
    fontSize: 11, color: 'var(--text-2)', lineHeight: 1.5,
    marginBottom: 12,
  },
  optionsCol: {
    display: 'flex', flexDirection: 'column', gap: 10,
  },
  optionCard: {
    textAlign: 'left',
    background: 'var(--surface-2)',
    border: '2px solid var(--border)',
    borderRadius: 10, padding: 12,
    cursor: 'pointer',
    transition: 'border-color .15s, transform .05s',
  },
  optionKeep: { borderColor: 'rgba(16,185,129,0.4)' },
  optionWipe: { borderColor: 'rgba(239,68,68,0.4)' },
  optionHead: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 8,
  },
  optionTitle: {
    fontSize: 14, fontWeight: 700, color: 'var(--text)',
  },
  optionBody: {
    display: 'flex', flexDirection: 'column', gap: 4,
  },
  recommendBadge: {
    fontSize: 10, fontWeight: 700,
    padding: '2px 6px', borderRadius: 8,
    background: 'var(--accent)', color: 'white',
  },
  dangerBadge: {
    fontSize: 10, fontWeight: 700,
    padding: '2px 6px', borderRadius: 8,
    background: 'var(--danger)', color: 'white',
  },
  footer: {
    marginTop: 12, display: 'flex', justifyContent: 'flex-end',
  },
  btnGhost: {
    padding: '8px 14px',
    background: 'transparent', color: 'var(--text-3)',
    border: '1px solid var(--border)', borderRadius: 8,
    fontSize: 12, cursor: 'pointer',
  },
};
