// (2026-07-28 F6-b) Fleet 요약 지표 hook.
//
// 이전 (F0~F3): devices.map(d => listTrips(d.id)) N+1. 100대면 100 request.
//               F3 에서 deps 안정화로 폭주는 stop, but 초회 로드는 여전 100 요청.
// 이제 (F6-b):  useFleetTripStats 한 번 → server 가 aggregate.
//               staleTime 60s · React Query dedup — 여러 panel 동시 마운트해도 1 request.
//
// 반환: { totalCount, activeCount, todayKm, monthKm, loading, error }
// KST 기준 (한국 사업자 환경).

import { useMemo } from 'react';
import { useFleetTripStats } from '../../state';

function kstDateStr(d = new Date()) {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}
function kstMonthStartStr(d = new Date()) {
  return kstDateStr(d).slice(0, 7) + '-01';
}

export function useFleetStats(devices) {
  const params = useMemo(() => ({
    from: new Date(kstMonthStartStr() + 'T00:00:00+09:00').toISOString(),
    to:   new Date().toISOString(),
  }), []);
  // devices 유무와 관계없이 항상 fetch — hook 규칙 (조건부 hook 금지).
  const { data, isLoading, error } = useFleetTripStats(params, {
    enabled: !!devices,   // devices 없으면 skip
  });

  return useMemo(() => {
    const totalCount = devices?.length ?? 0;
    const activeCount = (devices || []).filter(d => d.last_event_kind === 'wake').length;
    let todayM = 0, monthM = 0;
    for (const s of (data?.per_device || [])) {
      monthM += s.total_distance_m || 0;
      todayM += s.today_distance_m || 0;
    }
    return {
      totalCount, activeCount,
      todayKm: Math.round(todayM / 100) / 10,
      monthKm: Math.round(monthM / 1000),
      loading: isLoading,
      error: error?.message || null,
    };
  }, [devices, data, isLoading, error]);
}
