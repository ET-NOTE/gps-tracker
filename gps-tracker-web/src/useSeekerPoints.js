import { useEffect, useState } from 'react';
import { api } from './api';
import { authScope } from './authSession';
import { dayWindow, monthWindow, normalizeAggregates, seekerBucket } from './lib/seeker';
import { enrichWithSpeedStops } from './lib/stops';

const EMPTY = [];
// Bind data to the exact selection. Old paths must disappear even before the
// new effect runs, and a failed refresh must not look like a successful result.
export default function useSeekerPoints(deviceId, mode, date, month, precision, refreshKey) {
  const bucket = seekerBucket(mode, precision);
  const period = mode === 'month' ? month : date;
  const scope = authScope();
  const key = JSON.stringify([scope, deviceId, mode, period, bucket, refreshKey]);
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (deviceId == null) return;
    const controller = new AbortController();
    const w = mode === 'month' ? monthWindow(period) : dayWindow(period);
    setResult({ key, loading: true, points: EMPTY, error: null });
    api.getDeviceLocationsAggregated(deviceId, bucket, w.since, w.until, { signal: controller.signal })
      .then(rows => {
        if (!controller.signal.aborted) setResult({ key, loading: false,
          points: enrichWithSpeedStops(normalizeAggregates(rows)), error: null });
      }).catch(e => {
        if (!controller.signal.aborted) setResult({ key, loading: false, points: EMPTY,
          error: e.message || '경로를 불러오지 못했습니다.' });
      });
    return () => controller.abort();
  }, [key, deviceId, mode, period, bucket]);
  return { ...(result?.key === key ? result : { points: EMPTY, loading: deviceId != null, error: null }), bucket };
}
