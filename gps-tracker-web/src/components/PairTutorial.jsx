// 신규 사용자 페어링 가이드 — /devices/pair 진입 + (디바이스 0개 OR ?tutorial=1) 시 표시.
// localStorage 'pair_tutorial_seen' 으로 1회만 표시.
// 2 step: 환영 → 입력하기 (입력하기 누르면 닫고 페어링 모달 포커스).

import { useState } from 'react';

const STORAGE_KEY = 'pair_tutorial_seen';

export function shouldShowPairTutorial(deviceCount, forceQuery = false) {
  if (forceQuery) return true;
  try {
    if (localStorage.getItem(STORAGE_KEY) === '1') return false;
  } catch { /* noop */ }
  return deviceCount === 0;
}

export function markPairTutorialSeen() {
  try { localStorage.setItem(STORAGE_KEY, '1'); } catch { /* noop */ }
}

export default function PairTutorial({ onClose, onStart }) {
  const [step, setStep] = useState(1);

  function close() {
    markPairTutorialSeen();
    onClose?.();
  }
  function start() {
    markPairTutorialSeen();
    onStart?.();
  }

  return (
    <div onClick={close} style={st.overlay}>
      <div onClick={e => e.stopPropagation()} style={st.card}>
        {/* Step 1 — 환영 */}
        {step === 1 && (
          <>
            <div style={st.iconWrap}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="white"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                <circle cx="12" cy="10" r="3"/>
              </svg>
            </div>
            <div style={st.title}>환영합니다 👋</div>
            <div style={st.body}>
              시리얼링크 위치추적기에 가입해주셔서 감사합니다.<br/>
              지금 바로 단말기를 등록하고 실시간 위치 추적을 시작해보세요.
            </div>
            <ul style={st.bullets}>
              <li>📍 실시간 GPS 위치 조회</li>
              <li>📝 운행 기록 자동 저장 (운전자 · 용무 · 메모)</li>
              <li>🔔 지오펜스 진입/이탈 알림</li>
              <li>🔗 위치 공유 링크 발급</li>
            </ul>
            <div style={st.footer}>
              <button onClick={close} style={st.btnGhost}>건너뛰기</button>
              <button onClick={() => setStep(2)} style={st.btnPrimary}>
                다음 →
              </button>
            </div>
            <div style={st.dots}>
              <span style={{ ...st.dot, ...st.dotOn }} />
              <span style={st.dot} />
            </div>
          </>
        )}

        {/* Step 2 — 입력하기 */}
        {step === 2 && (
          <>
            <div style={st.iconWrap}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="white"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="6" width="18" height="13" rx="2"/>
                <path d="M7 10h10M7 14h6"/>
              </svg>
            </div>
            <div style={st.title}>단말기 정보를 입력하세요</div>
            <div style={st.body}>
              <b>SIM 번호</b> 또는 <b>device_uid</b> 중 하나로 등록할 수 있습니다.
            </div>
            <div style={st.tipBox}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                💡 SIM 번호로 등록 (권장)
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>
                단말기 OLED 첫 줄 「SIM ...12345678」 의 끝 8자리 (또는 전체 ICCID).
                전원만 켜져있으면 OLED 에 표시됩니다.
              </div>
            </div>
            <div style={st.tipBox}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                또는 device_uid
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>
                단말기 라벨에 적힌 <code style={{ fontSize: 11 }}>esp-XXXXXXXXXXXX</code> 형식.
              </div>
            </div>
            <div style={st.footer}>
              <button onClick={() => setStep(1)} style={st.btnGhost}>← 이전</button>
              <button onClick={start} style={st.btnPrimary}>
                지금 등록하기
              </button>
            </div>
            <div style={st.dots}>
              <span style={st.dot} />
              <span style={{ ...st.dot, ...st.dotOn }} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const st = {
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16, zIndex: 1100,
    animation: 'fadeIn .15s ease-out',
  },
  card: {
    width: '100%', maxWidth: 420,
    background: 'var(--surface)', borderRadius: 16,
    padding: '28px 24px 20px',
    boxShadow: '0 24px 60px rgba(0,0,0,0.3)',
    border: '1px solid var(--border)',
    maxHeight: '90vh', overflowY: 'auto',
  },
  iconWrap: {
    width: 72, height: 72, borderRadius: 18,
    margin: '0 auto 16px',
    background: 'linear-gradient(135deg, var(--primary) 0%, #8B5CF6 100%)',
    color: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 8px 24px rgba(59,130,246,0.35)',
  },
  title: {
    fontSize: 20, fontWeight: 700, color: 'var(--text)',
    textAlign: 'center', marginBottom: 10, letterSpacing: -0.4,
  },
  body: {
    fontSize: 14, color: 'var(--text-2)', textAlign: 'center',
    lineHeight: 1.6, marginBottom: 16,
  },
  bullets: {
    listStyle: 'none', padding: 0, margin: '0 0 20px',
    display: 'flex', flexDirection: 'column', gap: 8,
    fontSize: 13, color: 'var(--text)',
  },
  tipBox: {
    background: 'var(--surface-2)', borderRadius: 10,
    padding: '12px 14px', marginBottom: 10,
    fontSize: 13, color: 'var(--text)',
    border: '1px solid var(--border)',
  },
  footer: {
    display: 'flex', gap: 8, marginTop: 18,
  },
  btnPrimary: {
    flex: 1, padding: 12,
    background: 'var(--primary)', color: 'var(--primary-fg)',
    border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 14,
    cursor: 'pointer',
  },
  btnGhost: {
    padding: '12px 16px',
    background: 'transparent', color: 'var(--text-3)',
    border: '1px solid var(--border)', borderRadius: 10,
    fontWeight: 500, fontSize: 13, cursor: 'pointer',
  },
  dots: {
    display: 'flex', justifyContent: 'center', gap: 6, marginTop: 14,
  },
  dot: {
    width: 6, height: 6, borderRadius: 3,
    background: 'var(--border)',
  },
  dotOn: {
    background: 'var(--primary)', width: 18,
  },
};
