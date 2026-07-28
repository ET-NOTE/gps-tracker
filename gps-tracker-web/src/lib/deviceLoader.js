// (2026-07-28) Phase F6-a-3 — Dashboard 의 loadDevices / loadDevicesIncremental 을
// factory 로 추출. 이전엔 Dashboard.jsx 안 220+줄로 handleWsEvent 다음으로 큰 concern.
//
// 사용 (Dashboard 내):
//   const { loadDevices, loadDevicesIncremental } = useMemo(
//     () => makeDeviceLoaders({ mapRef, devRef, lastMetaRef, lastLoadedFixAtRef,
//                                wsRef, setDevices, setDevicesLoaded }),
//     [],
//   );

import { api } from '../api';
import { enrichWithSpeedStops, haversineM, compactStopMarkerIndexes } from './stops';
import { getDeviceColor, isStale } from '../colors';
// (F6-c) calcSpeedKmh / clickableIntervalM 중복 → lib/speed.js 로 통합.
// Re-export 로 기존 import 경로 유지.
import { calcSpeedKmh, clickableIntervalM } from './speed';
export { calcSpeedKmh, clickableIntervalM };

// Home view stop cluster 흡수 반경 — seeker 기본 (35m) 과 통일.
export const HOME_STOP_MERGE_RADIUS_M = 35;
// 폴리라인 dashed gap 기준 (KakaoMap.POLYLINE_GAP_THRESHOLD_S 와 동일).
export const POLYLINE_GAP_THRESHOLD_S = 60;

function localMidnightMs() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

// (한국 사용자 시간대 기준) 홈 뷰 fetch 창의 since 산출.
// 당일 fix 있으면 자정부터, 없으면 마지막 wake 이벤트부터 (자정 걸친 운행 carry-over).
//
// (2026-07-29) 이전엔 `getDeviceEvents(id, { limit: 50 })` 로 모든 kind 최근 50개
// 받아서 client 필터. 10일 오래된 단말이 offline/online/signal_loss/geofence_* 등으로
// 50개 노이즈 이벤트 쌓이면 wake 가 밀려나 못 찾음 → midnightISO fallback → 오늘 fix 0건
// → 마지막 사이클 fix 안 그려지고 last_lat/lng 마커 1개만 보이는 버그.
// Fix: 서버 kind 필터로 wake 1건만 요청 (backend F7-d).
export async function computeHomeSinceISO(device) {
  const midnightMs = localMidnightMs();
  const midnightISO = new Date(midnightMs).toISOString();
  const lastFixMs = device?.last_fix_at ? new Date(device.last_fix_at).getTime() : 0;
  if (lastFixMs >= midnightMs) return midnightISO;
  try {
    const events = await api.getDeviceEvents(device.id, { kinds: ['wake'], limit: 1 });
    if (events && events.length > 0) {
      return new Date(events[0].occurred_at).toISOString();
    }
    return midnightISO;
  } catch {
    return midnightISO;
  }
}

export function computeGapMap(ordered) {
  const map = {};
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1], b = ordered[i];
    if (!a.recorded_at || !b.recorded_at) continue;
    const gapS = (new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime()) / 1000;
    if (gapS <= POLYLINE_GAP_THRESHOLD_S) continue;
    const aPeer = { gapS, peerTs: b.recorded_at, peerLat: b.lat, peerLng: b.lng };
    const bPeer = { gapS, peerTs: a.recorded_at, peerLat: a.lat, peerLng: a.lng };
    (map[i - 1] ??= {}).gapAfter  = aPeer;
    (map[i]     ??= {}).gapBefore = bPeer;
  }
  return map;
}

export function computeClickableIndices(enriched, gapMap, intervalM = 30) {
  const picked = new Set();
  const gapEndpoints = new Set();
  const n = enriched.length;
  if (n === 0) return { picked, gapEndpoints };

  for (const k in gapMap) {
    const i = +k;
    picked.add(i);
    gapEndpoints.add(i);
  }

  let prevWasStop = false;
  for (let i = 0; i < n; i++) {
    const isStop = enriched[i]._isStop;
    if (isStop && !prevWasStop) picked.add(i);
    prevWasStop = isStop;
  }

  let acc = 0;
  for (let i = 1; i < n; i++) {
    const p = enriched[i - 1], q = enriched[i];
    if (p.lat && p.lng && q.lat && q.lng) {
      acc += haversineM(p.lat, p.lng, q.lat, q.lng);
    }
    if (picked.has(i)) { acc = 0; continue; }
    if (acc >= intervalM) {
      picked.add(i);
      acc = 0;
    }
  }
  if (n > 0) picked.add(0);

  return { picked, gapEndpoints };
}

// ── 팩토리 ──────────────────────────────
// 두 loadDevices* 가 공유하는 per-device 렌더 로직을 renderDeviceFixes 로 흡수.
// force 는 loadDevicesIncremental 전용 (기존 device 도 재렌더 강제).
export function makeDeviceLoaders({
  mapRef, devRef, lastMetaRef, lastLoadedFixAtRef, wsRef,
  setDevices, setDevicesLoaded,
}) {
  function renderDeviceFixes(d, locs, opts = {}) {
    const { force = false } = opts;
    const label = d.display_name || d.device_uid;
    const color = getDeviceColor(d);
    const stale = isStale(d.last_seen_at);
    if (!locs?.length) {
      if (d.last_lat != null && d.last_lng != null) {
        const meta = { recordedAt: d.last_fix_at || d.last_seen_at, stale };
        mapRef.current?.updateMarker(d.id, d.last_lat, d.last_lng, label, color, meta);
        lastMetaRef.current[d.id] = meta;
      }
      return;
    }
    const ordered = [...locs].reverse();
    const gapMap = computeGapMap(ordered);
    if (force) mapRef.current?.clearLiveTrail?.(d.id);
    // bulk 로드 — polyline setPath 는 마지막에 한 번만.
    ordered.forEach((loc, i) => {
      if (!loc.lat || !loc.lng) return;
      const isLast = (i === ordered.length - 1);
      const g = gapMap[i];
      const meta = isLast
        ? {
            recordedAt: loc.recorded_at, sat: loc.sat, vbatMv: loc.vbat_mv, cbcMv: loc.cbc_mv,
            fix: loc.fix, stale, heading: loc.heading, lat: loc.lat, lng: loc.lng,
            speedKmh: calcSpeedKmh(
              i > 0
                ? { lat: ordered[i - 1].lat, lng: ordered[i - 1].lng, recordedAt: ordered[i - 1].recorded_at }
                : null,
              { lat: loc.lat, lng: loc.lng, recordedAt: loc.recorded_at },
            ),
            deviceId: d.id, deviceLabel: label, ...(g || {}),
          }
        : { stale, recordedAt: loc.recorded_at };
      mapRef.current?.updateMarker(d.id, loc.lat, loc.lng, label, color, meta, { deferPolyline: !isLast });
      if (isLast) lastMetaRef.current[d.id] = meta;
    });
    mapRef.current?.flushLiveTrail?.(d.id);
    mapRef.current?.clearHistoryPoints(d.id);
    const enriched = enrichWithSpeedStops(ordered);
    const zoomLvl = mapRef.current?.getZoomLevel?.() ?? 3;
    const { picked, gapEndpoints } = computeClickableIndices(enriched, gapMap, clickableIntervalM(zoomLvl));
    const { compacted } = compactStopMarkerIndexes(enriched, picked, HOME_STOP_MERGE_RADIUS_M);
    enriched.slice(0, -1).forEach((loc, i) => {
      if (!loc.lat || !loc.lng) return;
      const g = gapMap[i];
      mapRef.current?.addHistoryPoint(d.id, loc.lat, loc.lng, color, {
        recordedAt: loc.recorded_at, sat: loc.sat, vbatMv: loc.vbat_mv, cbcMv: loc.cbc_mv, fix: loc.fix,
        speedKmh: loc._speed, isStop: loc._isStop,
        deviceId: d.id, deviceLabel: label,
        skipMarker: !compacted.has(i),
        isGapEndpoint: gapEndpoints.has(i),
        ...(g || {}),
      });
    });
  }

  async function loadDevicesIncremental(force = false) {
    try {
      const list = await api.listDevices();
      const oldIds = new Set(devRef.current.map(d => d.id));
      const newIds = new Set(list.map(d => d.id));
      oldIds.forEach(id => {
        if (!newIds.has(id)) {
          mapRef.current?.removeMarker(id);
          delete lastMetaRef.current[id];
          delete lastLoadedFixAtRef.current[id];
        }
      });
      setDevices(list);
      devRef.current = list;
      wsRef.current?.subscribe(list.map(d => d.id));
      await Promise.all(list.map(async d => {
        if (!force && oldIds.has(d.id)) return;
        // (2026-07-28) 깜빡임 fix — 마지막 fix 시각이 이전 로드와 동일하면 clear+rebuild skip.
        if (force && oldIds.has(d.id)) {
          const prevAt = lastLoadedFixAtRef.current[d.id];
          const curAt  = d.last_fix_at || d.last_seen_at || null;
          if (prevAt && curAt && prevAt === curAt) return;
        }
        const since = await computeHomeSinceISO(d);
        const groups = await api.listLocationsGrouped(d.id, { limit: 2000, fix_only: true, since });
        const locs = api.flattenGrouped(groups);
        renderDeviceFixes(d, locs, { force });
        lastLoadedFixAtRef.current[d.id] = d.last_fix_at || d.last_seen_at || null;
      }));
    } catch (e) { console.error('refresh', e); }
  }

  async function loadDevices() {
    try {
      const targetIdRaw = new URLSearchParams(window.location.search).get('device');
      const targetId = targetIdRaw ? parseInt(targetIdRaw, 10) : NaN;

      const list = await api.listDevices();
      setDevices(list);
      setDevicesLoaded(true);
      devRef.current = list;
      wsRef.current?.subscribe(list.map(d => d.id));

      const sinces = await Promise.all(list.map(d => computeHomeSinceISO(d)));
      await Promise.all(list.map(async (d, li) => {
        const since = sinces[li];
        const groups = await api.listLocationsGrouped(d.id, { limit: 2000, fix_only: true, since });
        const locs = api.flattenGrouped(groups);
        renderDeviceFixes(d, locs);
      }));
      if (!isNaN(targetId)) {
        mapRef.current?.focusDevice(targetId);
      } else {
        mapRef.current?.fitToAllMarkers(60);
      }
    } catch (e) { console.error('loadDevices', e); }
  }

  return { loadDevices, loadDevicesIncremental };
}
