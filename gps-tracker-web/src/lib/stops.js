const R_EARTH = 6371000;

export function haversineM(la1, lo1, la2, lo2) {
  const r = Math.PI / 180;
  const dLa = (la2 - la1) * r;
  const dLo = (lo2 - lo1) * r;
  const a = Math.sin(dLa / 2) ** 2
          + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

// Match the server's sustained-stop rule. Sampling frequency must not turn
// slow travel into parking: remain within 50 m of a fixed anchor for 5 minutes.
export function analyzePath(points, { clusterRadiusM = 50, stopDurationS = 300 } = {}) {
  const stopped = new Set();
  let anchor = 0, distanceM = 0, clusterM = 0, observedS = 0, stoppedS = 0, stopCount = 0;
  const finish = end => {
    const seconds = (Date.parse(points[end]?.recorded_at) - Date.parse(points[anchor]?.recorded_at)) / 1000;
    if (seconds >= stopDurationS) {
      for (let j = anchor; j <= end; j++) stopped.add(j);
      distanceM -= clusterM;
      stoppedS += seconds; stopCount++;
    }
  };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const seconds = (Date.parse(b.recorded_at) - Date.parse(a.recorded_at)) / 1000;
    const metres = haversineM(a.lat, a.lng, b.lat, b.lng);
    if (!(seconds > 0) || seconds > 600 || !Number.isFinite(metres) || metres / seconds * 3.6 > 250) {
      finish(i - 1); anchor = i; clusterM = 0;
      continue;
    }
    observedS += seconds; distanceM += metres;
    const origin = points[anchor];
    if (haversineM(origin.lat, origin.lng, b.lat, b.lng) <= clusterRadiusM) clusterM += metres;
    else { finish(i - 1); anchor = i; clusterM = 0; }
  }
  if (points.length) finish(points.length - 1);
  return { stopped, stoppedS, stopCount, observedS, distanceM: Math.max(0, distanceM), movingS: Math.max(0, observedS - stoppedS) };
}

/**
 * 렌더 후보 인덱스 집합 (Set) 을 stop cluster 반경 안에서 뭉쳐 대표만 남김.
 * 흡수되지 않은 (첫/마지막/이동중/멀리 떨어진) 인덱스는 그대로 유지.
 * @returns { compacted: Set<number>, clusterMap: Map<repIdx, [absorbedIdxs]> }
 *   - clusterMap: 대표 인덱스 → 흡수된 원본 인덱스 배열 (자기 자신 포함).
 *     이 배열이 유일하면 cluster 아님 (단독 marker), 여럿이면 cluster.
 */
export function compactStopMarkerIndexes(pts, indexes, radiusM) {
  const total = pts.length;
  const clusterMap = new Map();
  if (total <= 2 || radiusM <= 0) {
    const compacted = new Set(indexes);
    compacted.forEach(i => clusterMap.set(i, [i]));
    return { compacted, clusterMap };
  }

  const sorted = Array.from(indexes).sort((a, b) => a - b);
  const compacted = new Set();
  let cluster = [];
  let center = null;

  const flushCluster = () => {
    if (cluster.length === 0) return;
    const rep = cluster[Math.floor(cluster.length / 2)];
    compacted.add(rep);
    clusterMap.set(rep, cluster);
    cluster = [];
    center = null;
  };

  sorted.forEach(idx => {
    const p = pts[idx];
    if (!p) return;
    if (idx === 0 || idx === total - 1 || !p._isStop) {
      flushCluster();
      compacted.add(idx);
      clusterMap.set(idx, [idx]);
      return;
    }
    if (!center || haversineM(center.lat, center.lng, p.lat, p.lng) > radiusM) {
      flushCluster();
      cluster = [idx];
      center = { lat: p.lat, lng: p.lng };
      return;
    }
    cluster.push(idx);
    center = {
      lat: (center.lat * (cluster.length - 1) + p.lat) / cluster.length,
      lng: (center.lng * (cluster.length - 1) + p.lng) / cluster.length,
    };
  });
  flushCluster();
  return { compacted, clusterMap };
}

/**
 * cluster 대표 인덱스에 tooltip 용 timestamp range + count 부여.
 * absorbed 는 시간 오름차순 인덱스 배열 (compactStopMarkerIndexes 결과).
 * @returns { clusterStartAt, clusterEndAt, clusterCount } — count=1 이면 null 반환.
 */
export function clusterMeta(pts, absorbed) {
  if (!absorbed || absorbed.length <= 1) return null;
  const startIdx = absorbed[0];
  const endIdx = absorbed[absorbed.length - 1];
  return {
    clusterStartAt: pts[startIdx]?.recorded_at,
    clusterEndAt:   pts[endIdx]?.recorded_at,
    clusterCount:   absorbed.length,
  };
}

export function enrichWithSpeedStops(points, opts = {}) {
  if (!points?.length) return points || [];
  const { stopped } = analyzePath(points, opts);
  return points.map((p, i) => {
    let speed = Number.isFinite(p.speed_kmh) && p.speed_kmh >= 0 && p.speed_kmh <= 250 ? p.speed_kmh : null;
    if (speed == null && i > 0) {
      const prev = points[i - 1];
      const seconds = (Date.parse(p.recorded_at) - Date.parse(prev.recorded_at)) / 1000;
      const calculated = haversineM(prev.lat, prev.lng, p.lat, p.lng) / seconds * 3.6;
      if (seconds > 0 && seconds <= 600 && calculated <= 250 && Number.isFinite(calculated)) speed = calculated;
    }
    return { ...p, _speed: stopped.has(i) ? 0 : speed, _isStop: stopped.has(i) };
  });
}
