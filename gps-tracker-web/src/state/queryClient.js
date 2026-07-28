// (2026-07-28) Phase F2 — React Query 클라이언트 설정.
//
// 감사 결과:
//   - getMe 4곳, listDevices 3곳, listTrips N번 중복 fetch
//   - AbortController 사용처 0, StrictMode double-invoke 대비 안 됨
//   - setTick(t=>t+1) 강제 리프레시 24+ 곳
//
// 정책:
//   - staleTime 30s 기본 — GPS device 리스트/계약처럼 자주 안 변하는 것
//   - retry 1회 (기본 3회는 401/network 순간에 폭주)
//   - refetchOnWindowFocus true (모바일 앱 전환/브라우저 focus 시 새로고침)
//   - refetchOnReconnect true (오프라인 → 온라인 자동)
//   - throwOnError false (에러는 각 훅에서 처리)

import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,          // 30s — 이 안엔 캐시된 값 그대로 씀
      gcTime:    5 * 60_000,      // 5분 후 unmounted 캐시 gc
      retry: 1,
      retryDelay: (attempt) => Math.min(30_000, 1000 * Math.pow(2, attempt)),
      refetchOnWindowFocus: true,
      refetchOnReconnect:   true,
      // 401 은 api.js req() 가 자동 refresh 하므로 여기선 특별 처리 X.
    },
    mutations: {
      retry: 0,     // POST/PATCH/DELETE 는 사용자가 재시도
    },
  },
});
