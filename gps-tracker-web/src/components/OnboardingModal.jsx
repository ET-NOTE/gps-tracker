// Onboarding — 처음 방문한 사용자에게 1회만 표시.
// localStorage 'onboarding_v2' 키로 표시 여부 관리.
import { useState, useRef } from 'react';

const SLIDES = [
  {
    emoji: '👋',
    title: '시리얼링크에\n오신 것을 환영합니다!',
    desc: '단말기의 실시간 위치를 추적하고, 운행 기록을 확인하며, 지오펜스를 설정하세요.',
    color: '#3B82F6',
  },
  {
    emoji: '📡',
    title: '단말기를 등록하세요',
    desc: '"단말기" 탭에서 SIM 번호를 입력하면 몇 분 안에 위치가 표시됩니다.',
    color: '#10B981',
  },
  {
    emoji: '🗺️',
    title: '실시간 위치 추적',
    desc: '홈 화면에서 단말기의 현재 위치가 지도에 표시됩니다. 10초마다 자동 갱신됩니다.',
    color: '#8B5CF6',
  },
  {
    emoji: '📊',
    title: '운행 기록 확인',
    desc: '"운행" 탭에서 지난 날의 이동 경로, 속도 그래프, 정지 구간을 확인하세요.',
    color: '#F59E0B',
  },
];

export default function OnboardingModal({ onDone }) {
  const [idx, setIdx] = useState(0);
  const touchStartX = useRef(null);

  const slide = SLIDES[idx];
  const isLast = idx === SLIDES.length - 1;

  function next() {
    if (isLast) finish();
    else setIdx(i => i + 1);
  }
  function finish() {
    localStorage.setItem('onboarding_v2', '1');
    onDone?.();
  }

  function onTouchStart(e) {
    touchStartX.current = e.touches[0].clientX;
  }
  function onTouchEnd(e) {
    if (touchStartX.current == null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    if (dx < -50 && !isLast) setIdx(i => i + 1);
    if (dx > 50 && idx > 0)  setIdx(i => i - 1);
    touchStartX.current = null;
  }

  return (
    <div style={s.backdrop}>
      <div style={s.modal} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>

        {/* Skip */}
        <button onClick={finish} style={s.skip}>건너뛰기</button>

        {/* Emoji */}
        <div style={{ ...s.emojiWrap, background: slide.color + '18' }}>
          <span style={s.emoji}>{slide.emoji}</span>
        </div>

        {/* Text */}
        <div style={s.title}>{slide.title}</div>
        <div style={s.desc}>{slide.desc}</div>

        {/* Dots */}
        <div style={s.dots}>
          {SLIDES.map((_, i) => (
            <button key={i} onClick={() => setIdx(i)}
              style={{ ...s.dot, background: i === idx ? slide.color : 'var(--border)', width: i === idx ? 20 : 7 }} />
          ))}
        </div>

        {/* Next / Done */}
        <button onClick={next} style={{ ...s.btn, background: slide.color }}>
          {isLast ? '시작하기 🚀' : '다음 →'}
        </button>

      </div>
    </div>
  );
}

const s = {
  backdrop: {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 20,
  },
  modal: {
    background: 'var(--surface)',
    borderRadius: 20,
    padding: '28px 24px 24px',
    width: '100%', maxWidth: 360,
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    position: 'relative',
    userSelect: 'none',
  },
  skip: {
    position: 'absolute', top: 14, right: 16,
    background: 'none', border: 'none',
    fontSize: 13, color: 'var(--text-3)', cursor: 'pointer',
  },
  emojiWrap: {
    width: 88, height: 88, borderRadius: 24,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    marginBottom: 22,
  },
  emoji: {
    fontSize: 42, lineHeight: 1,
  },
  title: {
    fontSize: 20, fontWeight: 800, color: 'var(--text)',
    textAlign: 'center', whiteSpace: 'pre-line',
    letterSpacing: '-0.3px', marginBottom: 10,
  },
  desc: {
    fontSize: 14, color: 'var(--text-2)', textAlign: 'center',
    lineHeight: 1.6, marginBottom: 24,
  },
  dots: {
    display: 'flex', alignItems: 'center', gap: 6, marginBottom: 24,
  },
  dot: {
    height: 7, borderRadius: 4, border: 'none', cursor: 'pointer',
    padding: 0, transition: 'width 0.25s, background 0.25s',
  },
  btn: {
    width: '100%', padding: '14px 0',
    border: 'none', borderRadius: 12,
    fontSize: 15, fontWeight: 700, color: '#fff',
    cursor: 'pointer', letterSpacing: '-0.2px',
  },
};
