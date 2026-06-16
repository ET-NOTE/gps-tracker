// 반응형 분기 훅 — 'mobile' | 'tablet' | 'desktop'.
// 사용처에서 layout/UX 자체를 바꾸기 위해 (단순 width 변화가 아닌).
import { useEffect, useState } from 'react';

const QUERY_TABLET  = '(min-width: 768px)';
const QUERY_DESKTOP = '(min-width: 1024px)';

function detect() {
  if (typeof window === 'undefined') return 'mobile';
  if (window.matchMedia(QUERY_DESKTOP).matches) return 'desktop';
  if (window.matchMedia(QUERY_TABLET ).matches) return 'tablet';
  return 'mobile';
}

export default function useBreakpoint() {
  const [bp, setBp] = useState(detect);
  useEffect(() => {
    const mqT = window.matchMedia(QUERY_TABLET);
    const mqD = window.matchMedia(QUERY_DESKTOP);
    const update = () => setBp(detect());
    mqT.addEventListener('change', update);
    mqD.addEventListener('change', update);
    return () => {
      mqT.removeEventListener('change', update);
      mqD.removeEventListener('change', update);
    };
  }, []);
  return bp;
}
