// (2026-07-28) Phase F6-a-1 — 주기적 refresh + focus/visibility 트리거 slice hook.
//
// Dashboard.jsx 에 있던 30s tick + focus + visibility 트리거 로직을 재사용 가능하게 분리.
// FleetDashboard 등 다른 뷰에서도 활용 가능.
//
// 사용:
//   const refresh = useAutoRefresh(async (force) => { ... }, {
//     intervalMs: 30_000,
//     minIntervalMs: 8_000,  // 여러 트리거 겹쳐도 이 간격 안엔 skip
//   });
//   // 수동 강제: refresh(true)

import { useCallback, useEffect, useRef } from 'react';

export function useAutoRefresh(fn, opts = {}) {
  const { intervalMs = 30_000, minIntervalMs = 8_000, enabled = true } = opts;
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; }, [fn]);
  const lastAtRef = useRef(0);
  const flightRef = useRef(null);
  const generationRef = useRef(0);

  const trigger = useCallback((force = false) => {
    const now = Date.now();
    if (!force && now - lastAtRef.current < minIntervalMs) return;
    if (flightRef.current) {
      // A forced resync during a slow read needs one follow-up, not parallel reads.
      flightRef.current.queued ||= force;
      return flightRef.current.promise;
    }
    lastAtRef.current = now;
    const generation = generationRef.current;
    const flight = { queued: false, promise: null };
    flightRef.current = flight;
    flight.promise = Promise.resolve().then(async () => {
      let refreshForce = force;
      do {
        if (generation !== generationRef.current) return;
        flight.queued = false;
        lastAtRef.current = Date.now();
        try { await fnRef.current?.(refreshForce); }
        catch (e) { if (e.name !== 'AbortError') console.error('useAutoRefresh', e); }
        refreshForce = true;
      } while (flight.queued && generation === generationRef.current);
    }).finally(() => { if (flightRef.current === flight) flightRef.current = null; });
    return flight.promise;
  }, [minIntervalMs]);

  useEffect(() => {
    if (!enabled) return;
    const iv = setInterval(() => {
      if (document.visibilityState !== 'hidden') trigger(true);
    }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') trigger();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      generationRef.current++;
      flightRef.current = null;
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [enabled, intervalMs, trigger]);

  return trigger;
}
