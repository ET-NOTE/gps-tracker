// 좌표 시계열 enrichment — _speed (km/h), _isStop (cluster 멤버 여부) 채움.
// 시커 + 실시간 dot 마커가 같이 쓰는 정지(클러스터) 판정 로직.
//
// 정의: 인접 windowSize 이내 인덱스에서 자기 자신 포함 minCount 이상이
//      radiusM 안에 모여있으면 그 점은 cluster (= _isStop) 멤버.
//
// 이전 per-pair "직전 점과 50m 이내 + 5분 이상" 정의는 인접 단일 pair 만
// 검사해서 천천히 움직이는 구간을 못 잡았음. 새 정의는 count-based 라
// 실시간 30초 주기 POST 에서도 자연스럽게 detect.

const R_EARTH = 6371000;

export function haversineM(la1, lo1, la2, lo2) {
  const r = Math.PI / 180;
  const dLa = (la2 - la1) * r;
  const dLo = (lo2 - lo1) * r;
  const a = Math.sin(dLa / 2) ** 2
          + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

// 슬라이딩 윈도우로 cluster 멤버 인덱스 Set 계산. O(N · windowSize).
function findClusterIndices(points, minCount, radiusM, windowSize) {
  const flagged = new Set();
  const n = points.length;
  if (n < minCount) return flagged;

  for (let i = 0; i < n; i++) {
    let count = 1;   // 자기 자신 포함
    const lo = Math.max(0, i - windowSize);
    const hi = Math.min(n, i + windowSize + 1);
    for (let j = lo; j < hi; j++) {
      if (j === i) continue;
      const d = haversineM(points[i].lat, points[i].lng, points[j].lat, points[j].lng);
      if (d <= radiusM) {
        count++;
        if (count >= minCount) break;
      }
    }
    if (count >= minCount) flagged.add(i);
  }
  return flagged;
}

/**
 * @param points 시간 오름차순 fix 점들. {lat, lng, recorded_at} 필수.
 * @param opts.clusterMin 클러스터 인정 최소 점 수 (기본 5)
 * @param opts.clusterRadiusM 인접 점들이 모여있다고 볼 반경 (기본 150m — GPS 드리프트 + 도시 협곡 오차 감안)
 * @param opts.windowSize 클러스터 검사할 인접 인덱스 폭 ±N (기본 30)
 * @returns 각 점에 { ...p, _speed, _isStop } 추가된 새 배열.
 *
 * 알고리즘 — "각 점 i 가 자기 자신을 기준점으로 주변을 본다":
 *   1) 점 i 의 인접 시간순 ±windowSize 인덱스 점들과의 haversine 거리 계산
 *   2) 그 중 clusterRadiusM 안에 있는 점이 자기 포함 clusterMin 개 이상이면 i 를 cluster 로 mark
 *   3) cluster 안의 점들은 각자 자기 주변 보고 모두 동일하게 flag 됨
 *
 * 예) 점 A,B,C,D,E 가 모두 100m 반경 안 (radius=150m, min=5):
 *   - A: ±30 인덱스에서 B,C,D,E 4개가 150m 안 → count=5 ≥ 5 → flag ✓
 *   - 마찬가지로 B,C,D,E 도 각자 다 flag
 *
 * 예) 점 5개가 길게 늘어선 chain (각 인접 50m, 전체 200m):
 *   - 끝 점 A: B 50m, C 100m, D 150m, E 200m → 150m 안엔 B,C,D → count=4 < 5 → flag X
 *   - 의도된 동작: chain (이동 중) 은 cluster 아님, 모여있어야 cluster
 */
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
  const {
    clusterMin = 5,
    clusterRadiusM = 150,
    windowSize = 30,
  } = opts;
  if (!points || points.length === 0) return points || [];

  const stopIdx = findClusterIndices(points, clusterMin, clusterRadiusM, windowSize);

  return points.map((p, i) => {
    if (i === 0) {
      return { ...p, _speed: null, _isStop: stopIdx.has(0) };
    }
    const prev = points[i - 1];
    const dt = new Date(p.recorded_at) - new Date(prev.recorded_at);
    if (!(dt > 0)) {
      return { ...p, _speed: null, _isStop: stopIdx.has(i) };
    }
    const dM = haversineM(prev.lat, prev.lng, p.lat, p.lng);
    const speed = (dM / (dt / 1000)) * 3.6;   // km/h
    return { ...p, _speed: speed, _isStop: stopIdx.has(i) };
  });
}
