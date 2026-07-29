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
//
// 정책 (2026-07-29 v2):
//   - 오늘 fix 있음  → 오늘 KST 자정부터 (당일 전체 사이클)
//   - 오늘 fix 없음  → 마지막 fix 가 있는 날의 KST 자정부터 (그 날 전체 사이클)
//
// 이전 정책 히스토리:
//   - v1 (원본): 마지막 wake 이벤트부터 → 오래된 단말에서 노이즈 이벤트 50건 초과 시
//                wake 못 찾아 midnightISO fallback → 마지막 사이클 fix 안 보이던 버그 (PR #193)
//   - v1.1 (PR #193 fix): 서버 kinds=wake filter 로 wake 1건만 요청 → 대부분 케이스 해결.
//                          그러나 spurious wake (혼자 fix 1개 남기고 잠든 케이스, ccc 실사례)
//                          가 진짜 마지막 사이클 뒤에 존재하면 그 spurious wake 시각부터
//                          fetch → 1 fix 만 보이는 문제 재현.
//   - v2 (현재): "마지막 활동한 날 통째로" 보여주는 mental model 매칭. wake 이벤트 탐색
//                자체 폐기 → 노이즈/spurious 이벤트에 영향받지 않음. limit 2000 fix cap 이
//                하루치엔 충분 (30s 간격 = 2880 fix, 사이클 정지 시간 제외하면 여유).
export async function computeHomeSinceISO(device) {
  const midnightMs = localMidnightMs();
  const midnightISO = new Date(midnightMs).toISOString();
  const lastFixMs = device?.last_fix_at ? new Date(device.last_fix_at).getTime() : 0;
  if (!lastFixMs || lastFixMs >= midnightMs) return midnightISO;
  // 오래된 단말: 마지막 fix 가 있는 그 날의 KST 자정 (UTC 기준).
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const kstDate = new Date(lastFixMs + KST_OFFSET_MS);
  kstDate.setUTCHours(0, 0, 0, 0);        // KST 자정 (당일)
  const kstMidnightUtcMs = kstDate.getTime() - KST_OFFSET_MS;
  return new Date(kstMidnightUtcMs).toISOString();
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
    // (F9) 방어적 정렬 — api.flattenGrouped 는 DESC 유지 계약이지만 서버/네트워크
    // 재정렬/누락 가능성 방어. asc 로 명시 정렬해 gap / arrow bearing 계산의 chronological
    // 가정을 강제. 이전엔 reverse() 만 신뢰 → 배열 뒤섞이면 폴리라인 지그재그.
    const ordered = [...locs]
      .filter(l => l && l.recorded_at)
      .sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
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
    // (F10) 사이클 총 거리 기반 adaptive sampling — 이전엔 고정 clickableIntervalM (30m@z3) 로만
    // 후보 뽑아 200km 운행이 6000+ 후보 → MAX_HISTORY_POINTS=500 FIFO cap 로 오래된 것 evict
    // → "최근 20km 만 클릭 가능한 마커 몰림" 사용자 증상. 트립이 길어지면 interval 을 자동 확대해
    // TARGET_MARKER_COUNT 안에 균등 분포. 짧은 트립엔 zoom base interval 유지.
    // (F10-fix) gap 걸친 두 fix 간 haversine 은 실 이동 거리 아님 (예: 서울→부산 sleep 후 wake
    // = 400km 직선). totalM 에 포함하면 adaptive interval 이 과도하게 벌어져 클릭 마커 소멸.
    // gap > POLYLINE_GAP_THRESHOLD_S (60s) 인 인접 쌍은 skip.
    let totalM = 0;
    for (let i = 1; i < enriched.length; i++) {
      const p = enriched[i - 1], q = enriched[i];
      if (!p.lat || !q.lat) continue;
      if (p.recorded_at && q.recorded_at) {
        const gapS = (new Date(q.recorded_at).getTime() - new Date(p.recorded_at).getTime()) / 1000;
        if (gapS > POLYLINE_GAP_THRESHOLD_S) continue;
      }
      totalM += haversineM(p.lat, p.lng, q.lat, q.lng);
    }
    const TARGET_MARKER_COUNT = 300;
    const baseIntervalM = clickableIntervalM(zoomLvl);
    const adaptiveIntervalM = Math.max(baseIntervalM, totalM / TARGET_MARKER_COUNT);
    const { picked, gapEndpoints } = computeClickableIndices(enriched, gapMap, adaptiveIntervalM);
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
      devRef.current = list;
      wsRef.current?.subscribe(list.map(d => d.id));

      const sinces = await Promise.all(list.map(d => computeHomeSinceISO(d)));
      await Promise.all(list.map(async (d, li) => {
        const since = sinces[li];
        const groups = await api.listLocationsGrouped(d.id, { limit: 2000, fix_only: true, since });
        const locs = api.flattenGrouped(groups);
        renderDeviceFixes(d, locs);
      }));
      // (F12) setDevicesLoaded 를 Promise.all 이후로 이동 — 이전엔 devices state 만 세팅되고
      // renderDeviceFixes 미완료 상태에서도 true 였음. Dashboard 의 filter-restore useEffect
      // 가 이 시점에 filterToDevice(fit:true) 를 호출하면 pointsRef 비어 있어 bounds = 단일
      // main marker → 이상한 zoom 위치. 실 데이터 렌더링 완료 후 signal.
      setDevicesLoaded(true);
      if (!isNaN(targetId)) {
        mapRef.current?.focusDevice(targetId);
      } else {
        mapRef.current?.fitToAllMarkers(60);
      }
    } catch (e) { console.error('loadDevices', e); }
  }

  return { loadDevices, loadDevicesIncremental };
}
