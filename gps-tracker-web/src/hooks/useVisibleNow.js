import { useEffect, useState } from 'react';

// Keep ageing UI local to its display; suspend it while the WebView is hidden.
export function useVisibleNow(enabled = true, intervalMs = 1000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    let timer;
    const resume = () => {
      clearInterval(timer);
      if (document.visibilityState === 'hidden') return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), intervalMs);
    };
    resume();
    document.addEventListener('visibilitychange', resume);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', resume); };
  }, [enabled, intervalMs]);
  return now;
}
