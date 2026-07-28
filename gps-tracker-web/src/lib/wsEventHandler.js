// (2026-07-28) Phase F6-a-2 — Dashboard 의 WS event handler 를 순수 factory 로 추출.
//
// 이전엔 Dashboard.jsx 안 100줄 함수. 6+개 ref 를 closure 로 캡처해 컴포넌트 렌더링과
// 얽혀 있어 test·재사용·추론 어려웠음. factory 로 뽑아 refs 명시 주입 → 파일 크기 감소
// + WS 처리 로직 단독 파악 가능.
//
// 사용:
//   const handleWsEvent = useMemo(() => makeWsEventHandler({
//     devRef, mapRef, lastMetaRef, wsDotAccRef, filterDeviceIdRef, trackLiveRef,
//     setDevices, setLiveSpeed,
//   }), []);   // deps 는 모두 refs 라 인자 자체 identity 안 바뀜 — useMemo 없이 인라인도 OK.

import { getDeviceColor } from '../colors';
import { haversineM } from './stops';
import { calcSpeedKmh, clickableIntervalM } from './speed';

export function makeWsEventHandler({
  devRef, mapRef, lastMetaRef, wsDotAccRef,
  filterDeviceIdRef, trackLiveRef,
  setDevices, setLiveSpeed,
}) {
  return function handleWsEvent(msg) {
    // (2026-07-16) fix 없는 POST 도 vbat/cbc/csq/reg/sat/uptime 메타는 최신값이 옴 —
    // 단말기 카드 배터리 realtime 갱신 위해 msg.type==='location' 이면 fix 유무와 무관하게
    // meta 갱신 + setDevices last_seen_at 통과. 마커/polyline 은 fix+lat+lng 조건에서만.
    if (msg.type === 'location' && !(msg.fix && msg.lat && msg.lng)) {
      const prevMetaNoFix = lastMetaRef.current[msg.device_id] || {};
      lastMetaRef.current[msg.device_id] = {
        ...prevMetaNoFix,
        recordedAt: msg.recorded_at,
        sat: msg.sat ?? prevMetaNoFix.sat,
        vbatMv: msg.vbat_mv ?? prevMetaNoFix.vbatMv,
        cbcMv: msg.cbc_mv ?? prevMetaNoFix.cbcMv,
        fix: false,
      };
      setDevices(prev => prev.map(d =>
        d.id === msg.device_id
          ? { ...d, last_seen_at: msg.recorded_at }
          : d
      ));
      return;
    }
    if (msg.type === 'location' && msg.fix && msg.lat && msg.lng) {
      const dev = devRef.current.find(d => d.id === msg.device_id);
      const label = dev?.display_name || dev?.device_uid || `#${msg.device_id}`;
      const color = getDeviceColor(dev || { id: msg.device_id });
      const prevMeta = lastMetaRef.current[msg.device_id];
      const speedKmh = msg.speed_kmh ?? msg.speedKmh ?? calcSpeedKmh(prevMeta, {
        lat: msg.lat, lng: msg.lng, recordedAt: msg.recorded_at,
      });
      const meta = {
        recordedAt: msg.recorded_at, sat: msg.sat, vbatMv: msg.vbat_mv, cbcMv: msg.cbc_mv,
        fix: msg.fix, stale: false, heading: msg.heading, speedKmh,
        lat: msg.lat, lng: msg.lng,
      };
      // (2026-07-03) msg.fixes (batch) 가 있으면 각 fix 마다 updateMarker + addPoint 호출.
      // 이전엔 top-level lat/lng 하나만 updateMarker → 폴리라인 30초에 좌표 하나만 append
      // → 자동차 500m 이동해도 직선 하나로 표시 = 사용자 관점 "순간이동".
      // Fix: 배치 안 fix 를 시간 순서로 순차 updateMarker → 실제 곡선 반영.
      const wsZoomLvl = mapRef.current?.getZoomLevel?.() ?? 3;
      const wsIntervalM = clickableIntervalM(wsZoomLvl);
      const addPoint = (lat, lng, recordedAt, sat, fixVal, speed) => {
        const acc = wsDotAccRef.current[msg.device_id];
        let skipMarker = true;
        if (!acc) {
          skipMarker = false;  // 첫 fix 는 항상 dot
        } else {
          acc.accM += haversineM(acc.lat, acc.lng, lat, lng);
          if (acc.accM >= wsIntervalM) {
            skipMarker = false;
            acc.accM = 0;
          }
        }
        wsDotAccRef.current[msg.device_id] = { lat, lng, accM: acc ? acc.accM : 0 };
        mapRef.current?.addHistoryPoint(msg.device_id, lat, lng, color, {
          recordedAt, sat, vbatMv: msg.vbat_mv, cbcMv: msg.cbc_mv, fix: fixVal,
          speedKmh: speed, isStop: false,
          deviceId: msg.device_id, deviceLabel: label,
          skipMarker,
        });
      };
      if (Array.isArray(msg.fixes) && msg.fixes.length > 0) {
        for (let i = 0; i < msg.fixes.length; i++) {
          const f = msg.fixes[i];
          if (f.lat == null || f.lng == null) continue;
          const isLast = (i === msg.fixes.length - 1);
          const fMeta = isLast ? meta : {
            recordedAt: f.recorded_at, sat: f.sat, fix: true, stale: false,
            deviceId: msg.device_id, deviceLabel: label,
          };
          mapRef.current?.updateMarker(msg.device_id, f.lat, f.lng, label, color, fMeta);
          addPoint(f.lat, f.lng, f.recorded_at, f.sat, true, null);
        }
      } else if (msg.lat != null && msg.lng != null) {
        // legacy: batch 없음 (구 firmware). top-level 하나만.
        // sleep_enter/geofence_out 등 fix 없는 이벤트는 lat/lng 없이 옴 → skip (Kakao LatLng 오염 방지).
        mapRef.current?.updateMarker(msg.device_id, msg.lat, msg.lng, label, color, meta);
        addPoint(msg.lat, msg.lng, msg.recorded_at, msg.sat, msg.fix, speedKmh);
      }
      lastMetaRef.current[msg.device_id] = meta;
      if (filterDeviceIdRef.current === msg.device_id) {
        setLiveSpeed({ deviceId: msg.device_id, label, color, speedKmh, recordedAt: msg.recorded_at });
      }
      setDevices(prev => prev.map(d =>
        d.id === msg.device_id
          ? { ...d, last_seen_at: msg.recorded_at, last_lat: msg.lat, last_lng: msg.lng }
          : d
      ));

      // 라이브 추적 — trackLive(=userTrackPref && !seekerPaused) 가 true 이고
      // 갱신된 디바이스가 현재 필터링된 디바이스일 때만 카메라 이동.
      // 필터 안 잡혔으면 어떤 디바이스를 따라야 할지 모호하므로 무동작.
      if (trackLiveRef.current && filterDeviceIdRef.current === msg.device_id) {
        mapRef.current?.panToCoord?.(msg.lat, msg.lng);
      }
    }
  };
}
