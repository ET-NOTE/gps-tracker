import { useEffect, useState } from 'react';
import { api } from './api';
import { authScope } from './authSession';

const EMPTY = [];

export default function useSeekerSummary(deviceId, refreshKey) {
  const key = JSON.stringify([authScope(), deviceId, refreshKey]);
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (deviceId == null) return;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    Promise.allSettled([
      api.getDailyStats(deviceId, { limit: 365 }, options),
      api.getActiveDates(deviceId, options),
    ]).then(([stats, dates]) => {
      if (controller.signal.aborted) return;
      const statsFailed = stats.status === 'rejected';
      const datesFailed = dates.status === 'rejected';
      setResult({ key, loading: false, statsFailed, datesFailed,
        dailyStats: statsFailed ? EMPTY : stats.value || EMPTY,
        activeDates: datesFailed ? EMPTY : dates.value || EMPTY,
        error: statsFailed && datesFailed ? '활동 날짜와 일별 통계를 불러오지 못했습니다.'
          : statsFailed ? '일별 통계를 불러오지 못했습니다. 활동 날짜와 경로는 계속 조회할 수 있습니다.'
          : datesFailed ? '활동 날짜를 불러오지 못했습니다. 집계된 통계가 있는 날짜만 표시합니다.' : null,
      });
    });
    return () => controller.abort();
  }, [key, deviceId]);
  return result?.key === key ? result : {
    dailyStats: EMPTY, activeDates: EMPTY, loading: deviceId != null,
    statsFailed: false, datesFailed: false, error: null,
  };
}
