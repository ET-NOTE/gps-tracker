import { useState, useRef } from 'react';

const THRESHOLD = 70;

export default function SwipeableCard({ onSwipeLeft, onSwipeRight, leftLabel, rightLabel, leftColor, rightColor, style, children }) {
  const [tx, setTx] = useState(0);
  const startX = useRef(null);
  const startY = useRef(null);
  const axis = useRef(null); // 'h' | 'v' | null

  function onTouchStart(e) {
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    axis.current = null;
  }

  function onTouchMove(e) {
    if (startX.current === null) return;
    const dx = e.touches[0].clientX - startX.current;
    const dy = e.touches[0].clientY - startY.current;

    if (axis.current === null) {
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
        axis.current = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      }
    }

    if (axis.current === 'h') {
      e.preventDefault();
      setTx(Math.max(-110, Math.min(110, dx)));
    }
  }

  function onTouchEnd() {
    if (axis.current === 'h') {
      if (tx < -THRESHOLD && onSwipeLeft)  onSwipeLeft();
      if (tx >  THRESHOLD && onSwipeRight) onSwipeRight();
    }
    setTx(0);
    startX.current = null;
    axis.current = null;
  }

  const leftOpacity  = Math.min(1, Math.max(0, tx / THRESHOLD));
  const rightOpacity = Math.min(1, Math.max(0, -tx / THRESHOLD));

  return (
    <div style={{ position: 'relative', marginBottom: 10, ...style }}>

      {/* Swipe action background — overflow hidden 은 이 레이어만 */}
      <div style={{ position: 'absolute', inset: 0, borderRadius: 14, overflow: 'hidden', zIndex: 0 }}>
        {onSwipeLeft && (
          <div style={{
            position: 'absolute', right: 0, top: 0, bottom: 0, width: 90,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
            background: leftColor || '#10B981',
            opacity: rightOpacity,
          }}>
            <span style={{ fontSize: 18 }}>🗺️</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff' }}>{leftLabel || '지도 보기'}</span>
          </div>
        )}
        {onSwipeRight && (
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, width: 90,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
            background: rightColor || '#6366f1',
            opacity: leftOpacity,
          }}>
            <span style={{ fontSize: 18 }}>📊</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff' }}>{rightLabel || '운행 기록'}</span>
          </div>
        )}
      </div>

      {/* Card content — shadow 자유롭게 */}
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{
          transform: `translateX(${tx}px)`,
          transition: tx === 0 ? 'transform 0.22s cubic-bezier(.4,0,.2,1)' : 'none',
          position: 'relative', zIndex: 1,
          willChange: 'transform',
        }}
      >
        {children}
      </div>
    </div>
  );
}
