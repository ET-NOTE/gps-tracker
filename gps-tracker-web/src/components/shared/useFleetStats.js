// (2026-07-28) 여러 대시보드에서 재사용 가능한 fleet 요약 지표 hook.
// listDevices 는 이미 Dashboard 가 하니 devices 를 prop 으로 받고,
// 오늘/이번달 km 만 병렬 listTrips 로 집계.
//
// 반환: { totalCount, activeCount, todayKm, monthKm, loading, error }
// KST 기준 (한국 사업자 환경 기본).

import { useEffect, useState } from 'react';
import { api } from '../../api';

function kstDateStr(d = new Date()) {
  // Asia/Seoul 로 강제. UTC+9 오프셋 계산.
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}
function kstMonthStartStr(d = new Date()) {
  return kstDateStr(d).slice(0, 7) + '-01';
}

export function useFleetStats(devices) {
  const [state, setState] = useState({
    totalCount: 0, activeCount: 0, todayKm: 0, monthKm: 0,
    loading: false, error: null,
  });

  useEffect(() => {
    let cancelled = false;
    if (!devices || devices.length === 0) {
      setState(s => ({ ...s, totalCount: 0, activeCount: 0, todayKm: 0, monthKm: 0, loading: false }));
      return;
    }
    setState(s => ({ ...s, loading: true, error: null }));

    const today = kstDateStr();
    const monthStart = kstMonthStartStr();
    const totalCount = devices.length;
    // "운행 중" 판정 — devices.rs 에서 반환하는 last_event_kind === 'wake'.
    // 배터리 device 는 sleep_enter 로 끝나지 않은 wake 를 계속 운행중으로 보임.
    const activeCount = devices.filter(d => d.last_event_kind === 'wake').length;

    // 이번달 trip 을 device 별 병렬 fetch — trip.distance_m 합산.
    // trip endpoint 는 이미 corporate 에서 쓰던 것 (구독 없어도 device owner 는 접근).
    Promise.all(devices.map(d =>
      api.listTrips(d.id, { from: monthStart, to: today }).catch(() => [])
    )).then(perDevice => {
      if (cancelled) return;
      let todayM = 0, monthM = 0;
      const todayPrefix = today;
      for (const trips of perDevice) {
        for (const t of trips) {
          const d = (t.started_at || '').slice(0, 10);
          const dist = t.distance_m || 0;
          if (d >= monthStart) monthM += dist;
          if (d === todayPrefix) todayM += dist;
        }
      }
      setState({
        totalCount, activeCount,
        todayKm: Math.round(todayM / 100) / 10,   // 소수 1자리 km
        monthKm: Math.round(monthM / 1000),        // 정수 km (많음)
        loading: false, error: null,
      });
    }).catch(e => {
      if (cancelled) return;
      setState(s => ({ ...s, loading: false, error: e.message || String(e) }));
    });

    return () => { cancelled = true; };
  }, [devices]);

  return state;
}
