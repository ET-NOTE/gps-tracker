// 모바일 bottom-sheet 헤더에 부착해 아래로 스와이프하면 onClose 호출.
// 사용:
//   const swipe = useSwipeDownClose(onClose, { enabled: !isDesktop });
//   <header {...swipe}>...</header>
// 임계: 60px 이상 + 아래방향 + 좌우 흔들림 작을 때만.
import { useRef } from 'react';

const THRESHOLD = 60;
const HORIZONTAL_TOL = 50;

export default function useSwipeDownClose(onClose, { enabled = true } = {}) {
  const startRef = useRef(null);

  if (!enabled) return {};

  function onTouchStart(e) {
    const t = e.touches[0];
    if (!t) return;
    startRef.current = { x: t.clientX, y: t.clientY };
  }
  function onTouchMove(e) {
    // 헤더 영역에서 시작한 down-swipe 가 페이지 스크롤과 충돌 안 하도록 default 차단.
    if (!startRef.current) return;
    const t = e.touches[0];
    if (!t) return;
    const dy = t.clientY - startRef.current.y;
    const dx = t.clientX - startRef.current.x;
    if (dy > 8 && Math.abs(dx) < HORIZONTAL_TOL) {
      // passive listener 가 아닐 때만 효과 — 보통 React touch handler 는 non-passive
      if (e.cancelable) e.preventDefault();
    }
  }
  function onTouchEnd(e) {
    if (!startRef.current) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dy = t.clientY - startRef.current.y;
    const dx = t.clientX - startRef.current.x;
    startRef.current = null;
    if (dy >= THRESHOLD && Math.abs(dx) < HORIZONTAL_TOL) {
      onClose?.();
    }
  }
  return { onTouchStart, onTouchMove, onTouchEnd };
}
