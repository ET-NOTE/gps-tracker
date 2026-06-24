import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';

const DEFAULT_CENTER = { lat: 37.5665, lng: 126.978 };
const MAX_HISTORY_POINTS = 500;
// 좌표 사이 timestamp gap 이 이 시간 넘으면 segment 분리 + gap 구간은 점선 polyline.
// 운영 흐름: 일반 POST 간격 15s. sleep/reset/통신두절 시 갭 수십s~분 → split 정확히 감지.
const POLYLINE_GAP_THRESHOLD_S = 60;

// 카카오 zoom level 기반 두께 — 숫자가 클수록 더 축소(넓게)된 상태.
// 축소되면 굵게, 확대되면 얇게.
function strokeWeightForLevel(level) {
  if (level <= 3)  return 3;       // very zoomed in
  if (level <= 5)  return 4;
  if (level <= 7)  return 5;
  if (level <= 9)  return 6;
  if (level <= 11) return 7;
  return 8;                         // very zoomed out
}
function dotSizeForLevel(level) {
  if (level <= 3)  return 10;
  if (level <= 5)  return 12;
  if (level <= 7)  return 14;
  if (level <= 9)  return 16;
  if (level <= 11) return 18;
  return 20;
}
// Seeker 라인 속도 버킷 — 빨강 (정지/매우 느림) / 노랑 / 녹 / 청 / 자 (고속)
const KAKAO_MAP_SDK_SRC = 'https://dapi.kakao.com/v2/maps/sdk.js?appkey=760ec0841163d1ee2cc5fef220a9df0b&libraries=services,clusterer&autoload=false';

function ensureKakaoMapSdk() {
  if (typeof window === 'undefined') return Promise.reject(new Error('window is unavailable'));
  if (window.kakao?.maps) return Promise.resolve(window.kakao);
  const existing = document.querySelector('script[data-kakao-map-sdk="true"], script[src*="dapi.kakao.com/v2/maps/sdk.js"]');
  if (existing) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (window.kakao?.maps) {
          clearInterval(timer);
          resolve(window.kakao);
        } else if (Date.now() - startedAt > 8000) {
          clearInterval(timer);
          reject(new Error('Kakao Maps SDK did not become available'));
        }
      }, 100);
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.async = true;
    script.dataset.kakaoMapSdk = 'true';
    script.src = KAKAO_MAP_SDK_SRC;
    script.onload = () => (window.kakao?.maps ? resolve(window.kakao) : reject(new Error('Kakao Maps SDK loaded without maps')));
    script.onerror = () => reject(new Error('Failed to load Kakao Maps SDK'));
    document.head.appendChild(script);
  });
}
const BUCKET_COLORS = ['#EF4444', '#F59E0B', '#10B981', '#3B82F6', '#8B5CF6'];
const TIME_SEGMENT_COLORS = ['#2563EB', '#06B6D4', '#10B981', '#F59E0B', '#EF4444'];
function speedBucket(p) {
  if (p._isStop || p._speed == null || p._speed < 5) return 0;       // 정지/도보 미만
  if (p._speed < 30)  return 1;                                       // 시내 저속
  if (p._speed < 60)  return 2;                                       // 일반 시내
  if (p._speed < 100) return 3;                                       // 고속도로
  return 4;                                                            // 초고속
}
function timeSegmentIndex(idx, total, segmentCount) {
  if (total <= 1) return 0;
  return Math.min(segmentCount - 1, Math.floor((idx / (total - 1)) * segmentCount));
}
function distanceM(a, b) {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLng = (b.lng - a.lng) * r;
  const lat1 = a.lat * r;
  const lat2 = b.lat * r;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
}

function compactStopMarkerIndexes(pts, indexes, radiusM) {
  const total = pts.length;
  if (total <= 2 || radiusM <= 0) return indexes;

  const sorted = Array.from(indexes).sort((a, b) => a - b);
  const compacted = new Set();
  let cluster = [];
  let center = null;

  const flushCluster = () => {
    if (cluster.length === 0) return;
    compacted.add(cluster[Math.floor(cluster.length / 2)]);
    cluster = [];
    center = null;
  };

  sorted.forEach(idx => {
    const p = pts[idx];
    if (!p) return;

    if (idx === 0 || idx === total - 1 || !p._isStop) {
      flushCluster();
      compacted.add(idx);
      return;
    }

    if (!center || distanceM(center, p) > radiusM) {
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
  return compacted;
}

// ─── 진행 방향 화살표 (dev-gps 의 usman 작업물 흡수) ────────────────────
// 두 좌표 사이 누적 거리 ARROW_INTERVAL_M (200m) 마다 진행 방향 화살표 1개 표시.
// 펌웨어 GPS course 의존 없이 client 가 atan2 로 bearing 계산 → 정지 시에도 정확.
// Canvas PNG 방식 (SVG data URL 은 Kakao MarkerImage 에서 불안정), 5° bucket 캐시.
const ARROW_INTERVAL_M = 200;

function calcBearing(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const dLng = toRad(lng2 - lng1);
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const y = Math.sin(dLng) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// 모듈 레벨 캐시 — 같은 (각도 bucket, 색상) 조합 재사용.
const _arrowImageCache = {};

function makeArrowImage(angleDeg, arrowColor) {
  const r = Math.round(angleDeg / 5) * 5;
  const key = `${r}_${arrowColor}`;
  if (_arrowImageCache[key]) return _arrowImageCache[key];
  const c = document.createElement('canvas');
  c.width = 20; c.height = 20;
  const ctx = c.getContext('2d');
  ctx.save();
  ctx.translate(10, 10);
  ctx.rotate(r * Math.PI / 180);
  ctx.translate(-10, -10);
  ctx.beginPath();
  ctx.moveTo(10, 2);   // 위 꼭짓점 (진행 방향 끝)
  ctx.lineTo(16, 18);  // 오른쪽 아래
  ctx.lineTo(10, 13);  // 중간 오목
  ctx.lineTo(4, 18);   // 왼쪽 아래
  ctx.closePath();
  ctx.fillStyle = arrowColor;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
  const url = c.toDataURL('image/png');
  _arrowImageCache[key] = new window.kakao.maps.MarkerImage(
    url,
    new window.kakao.maps.Size(20, 20),
    { offset: new window.kakao.maps.Point(10, 10) }
  );
  return _arrowImageCache[key];
}

function cursorImage(color) {
  const sz = 18;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sz}" height="${sz}" viewBox="0 0 ${sz} ${sz}">
    <circle cx="${sz/2}" cy="${sz/2}" r="${sz/2 - 2}" fill="${color}" stroke="white" stroke-width="3"/>
  </svg>`;
  return new window.kakao.maps.MarkerImage(
    'data:image/svg+xml;base64,' + btoa(svg),
    new window.kakao.maps.Size(sz, sz),
    { offset: new window.kakao.maps.Point(sz/2, sz/2) },
  );
}

// Drop-pin (위치 핀) — 라이브 마커 + 시커 선택 표시 공용. 32×40, 그림자 + 흰 테두리.
// 진행 방향 표기는 별도 (200m 누적 화살표 마커) 가 담당 — 핀 자체엔 원형 indicator 만.
const pinImageCache = new Map();
function pinImage(color) {
  const c = color || '#5B7CFF';
  let img = pinImageCache.get(c);
  if (img) return img;
  const w = 32, h = 40;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="2" stdDeviation="1.5" flood-opacity="0.35"/>
      </filter>
    </defs>
    <path filter="url(#sh)"
          d="M16 1c-7.18 0-13 5.82-13 13 0 9.5 13 25 13 25s13-15.5 13-25C29 6.82 23.18 1 16 1z"
          fill="${c}" stroke="white" stroke-width="2"/>
    <circle cx="16" cy="14" r="5" fill="white"/>
  </svg>`;
  img = new window.kakao.maps.MarkerImage(
    'data:image/svg+xml;base64,' + btoa(svg),
    new window.kakao.maps.Size(w, h),
    { offset: new window.kakao.maps.Point(w / 2, h - 1) },   // 핀 끝(아래)이 위치점
  );
  pinImageCache.set(c, img);
  return img;
}

// 새 이미지 만들 필요 있는지 — 동일 size+isStop+color 캐시
const dotImageCache = new Map();
function dotImageCached(color, isStop, size, isGapEndpoint = false) {
  const key = `${color}|${isStop ? 1 : 0}|${size}|${isGapEndpoint ? 'g' : ''}`;
  let img = dotImageCache.get(key);
  if (img) return img;
  // gap 양끝 점은 약간 크게 + 주황 ring → 통신두절 시각 강조 (그리고 클릭 hit-area 도 자연히 커짐).
  const realSize = isGapEndpoint ? size + 6 : size;
  const half = realSize / 2;
  const r    = Math.max(3, half - 2);
  const svg = isStop
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${realSize}" height="${realSize}">
        <rect x="2" y="2" width="${realSize-4}" height="${realSize-4}" rx="2" fill="${color}" stroke="white" stroke-width="1.5"/>
        <circle cx="${half}" cy="${half}" r="${Math.max(2, r/3)}" fill="white"/>
      </svg>`
    : isGapEndpoint
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${realSize}" height="${realSize}">
        <circle cx="${half}" cy="${half}" r="${r}" fill="${color}" stroke="#fb923c" stroke-width="2.5"/>
        <circle cx="${half}" cy="${half}" r="${Math.max(1, r/3)}" fill="white"/>
      </svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="${realSize}" height="${realSize}">
        <circle cx="${half}" cy="${half}" r="${r}" fill="${color}" stroke="white" stroke-width="1.5"/>
      </svg>`;
  const url = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  img = new window.kakao.maps.MarkerImage(
    url, new window.kakao.maps.Size(realSize, realSize),
    { offset: new window.kakao.maps.Point(half, half) },
  );
  dotImageCache.set(key, img);
  return img;
}

const KakaoMap = forwardRef(function KakaoMap({ onReady, onRoadview, onPointInfo, onUserPan, onViewChange }, ref) {
  // onPointInfo 가 제공되면 마커 클릭 시 kakao InfoWindow 대신 그 콜백을 호출.
  // 부모(Dashboard) 가 React 기반 bottom-sheet 으로 표시 (모바일 친화적).
  // 콜백 시그니처: ({ kind: 'main'|'point', label, color, meta, addr, lat, lng }) => void
  // — addr 가 null 인 첫 호출 후 비동기 resolve 되면 동일 시그니처로 한 번 더 호출.
  const onPointInfoRef = useRef(onPointInfo);
  // onUserPan: 사용자가 직접 지도를 드래그(또는 더블탭/핀치)했을 때 호출.
  // 라이브 추적 토글을 끄는 데 사용. panTo (프로그램적) 는 dragend 안 발생시키므로 안전.
  const onUserPanRef = useRef(onUserPan);
  // onViewChange: 사용자 조작에 의한 view (center+level) 변경. 새로고침 후 복원에 사용.
  // 시그니처: ({ lat, lng, level }) => void. 디바운스 600ms.
  // 프로그램적 setBounds/setLevel 직후 1s 안에 발생한 변경은 skip (자동 fit 결과를 user pref 로 잘못 저장 방지).
  const onViewChangeRef = useRef(onViewChange);
  const lastProgrammaticAtRef = useRef(0);
  const viewChangeTimerRef    = useRef(null);
  const containerRef = useRef(null);
  const mapRef       = useRef(null);
  const markersRef   = useRef({});   // deviceId → { marker, color, meta }
  // deviceId → { segments: [{ coords: LatLng[], poly: Polyline }], gaps: Polyline[] }
  // segments: 연속된 좌표 묶음 (solid polyline). gaps: segment 끝-시작 잇는 dashed polyline.
  // timestamp gap > POLYLINE_GAP_THRESHOLD_S 시 새 segment + dashed.
  const polyRef      = useRef({});
  const lastRecordedAtRef = useRef({});   // deviceId → 직전 좌표 recordedAt (ms epoch)
  const pointsRef    = useRef({});   // deviceId → [{ marker, color, isStop }]
  // live history 의 진행 방향 화살표 — 누적 ARROW_INTERVAL_M (200m) 마다 1개.
  // 화살표 marker 자체는 arrowsRef, 누적 distance / 직전 lat,lng 는 arrowStateRef 에.
  const arrowsRef      = useRef({});  // deviceId → Marker[]
  const arrowStateRef  = useRef({});  // deviceId → { lastPos:{lat,lng}, distAcc }
  const fenceRef     = useRef({});   // geofenceId → { circle, name }
  // 현재 단말기 필터 — null = 전체. updateMarker/addHistoryPoint 가 새 마커/폴리라인 생성 시 이걸 참조해
  // 필터에 안 맞는 디바이스 데이터는 map=null 로 숨겨둠 (filterToDevice 가 명시 호출되지 않아도).
  const currentFilterIdRef = useRef(null);
  const sharedIwRef  = useRef(null); // single InfoWindow shared by all markers/points
  const onRoadviewRef= useRef(onRoadview);
  const zoomLevelRef = useRef(10);   // 현재 zoom level — 마커/라인 두께 계산용
  const geocoderRef  = useRef(null); // kakao.maps.services.Geocoder (lazy)
  const addrCacheRef = useRef(new Map());   // "lat,lng(5dp)" → {road, building, jibun} | null
  const iwReqIdRef   = useRef(0);    // InfoWindow 비동기 갱신용 시퀀스
  const seekerRef    = useRef({ poly: [], pts: [], cursor: null });   // history seeker 임시 렌더링
  const seekerPinRef = useRef(null);   // 시커 슬롯 선택 표시용 단일 핀 마커

  useEffect(() => { onRoadviewRef.current = onRoadview; }, [onRoadview]);
  useEffect(() => { onPointInfoRef.current = onPointInfo; }, [onPointInfo]);
  useEffect(() => { onUserPanRef.current = onUserPan; }, [onUserPan]);
  useEffect(() => { onViewChangeRef.current = onViewChange; }, [onViewChange]);

  // 프로그램적 setBounds/setLevel 직전에 호출 — onViewChange 가드 트리거.
  const markProgrammatic = () => { lastProgrammaticAtRef.current = Date.now(); };
  // 디바운스된 view-change 통지. 최근 1s 안에 markProgrammatic() 호출이 있었으면 skip.
  const fireViewChange = () => {
    clearTimeout(viewChangeTimerRef.current);
    viewChangeTimerRef.current = setTimeout(() => {
      if (!mapRef.current || !onViewChangeRef.current) return;
      if (Date.now() - lastProgrammaticAtRef.current < 1000) return;   // 자동 fit 영향 제외
      const c = mapRef.current.getCenter();
      onViewChangeRef.current({
        lat: c.getLat(),
        lng: c.getLng(),
        level: mapRef.current.getLevel(),
      });
    }, 600);
  };

  // 글로벌 콜백 — InfoWindow 안의 onclick에서 호출.
  useEffect(() => {
    window.__btw_openRoadview = (lat, lng) => onRoadviewRef.current?.({ lat, lng });
    // gap 정보 복사 — 큰 텍스트를 onclick attribute 에 넣으면 따옴표 escape 가 깨져서
    // (Unexpected end of input) 별도 전역 store 에 보관 후 id 로 lookup.
    window.__btw_gapTexts = window.__btw_gapTexts || {};
    window.__btw_copyGap = (id, btn) => {
      const txt = window.__btw_gapTexts[id];
      if (!txt || !btn) return;
      navigator.clipboard.writeText(txt).then(() => {
        btn.textContent = '✅ 복사됨';
        setTimeout(() => { btn.textContent = '📋 보고 정보 복사'; }, 1500);
      });
    };
    return () => {
      delete window.__btw_openRoadview;
      delete window.__btw_copyGap;
      delete window.__btw_gapTexts;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const initMap = () => {
      window.kakao.maps.load(() => {
        if (cancelled || !containerRef.current) return;
        mapRef.current = new window.kakao.maps.Map(containerRef.current, {
          center: new window.kakao.maps.LatLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng),
          level: 10,
        });
        zoomLevelRef.current = mapRef.current.getLevel();
        sharedIwRef.current = new window.kakao.maps.InfoWindow({
          content: '<div></div>',
          removable: true,
          // 툴팁이 다른 마커(zIndex 1~99) 에 가리지 않게 충분히 높게.
          zIndex: 10000,
        });
        // 줌 변경 — 라인 두께 + dot 마커 이미지 재계산.
        window.kakao.maps.event.addListener(mapRef.current, 'zoom_changed', () => {
          const lvl = mapRef.current.getLevel();
          if (lvl !== zoomLevelRef.current) {
            zoomLevelRef.current = lvl;
            applyZoomStyles();
          }
          fireViewChange();
        });
        // 사용자 직접 드래그 (panTo 같은 프로그램적 이동에는 발생 안 함) → 라이브 추적 종료 신호.
        window.kakao.maps.event.addListener(mapRef.current, 'dragend', () => {
          onUserPanRef.current?.();
          fireViewChange();
        });
        onReady?.();
      });
    };
    ensureKakaoMapSdk()
      .then(() => { if (!cancelled) initMap(); })
      .catch(error => console.error('Kakao Maps SDK load failed', error));
    return () => { cancelled = true; };
  }, []);

  // zoom 변경 시 — 모든 polylines + dot markers 일괄 갱신.
  function applyZoomStyles() {
    const lvl = zoomLevelRef.current;
    const sw  = strokeWeightForLevel(lvl);
    const sz  = dotSizeForLevel(lvl);
    Object.values(polyRef.current).forEach(entry => {
      entry.segments.forEach(s => s.poly.setOptions({ strokeWeight: sw }));
      entry.gaps.forEach(g => g.setOptions({ strokeWeight: Math.max(1, sw - 1) }));
    });
    Object.values(pointsRef.current).forEach(arr => {
      arr.forEach(({ marker, color, isStop }) => {
        const dotColor = isStop ? '#EF4444' : (color || '#888');
        marker.setImage(dotImageCached(dotColor, isStop, sz));
      });
    });
  }

  function makeDotImage(color, isStop = false, isGapEndpoint = false) {
    return dotImageCached(color || '#888', isStop, dotSizeForLevel(zoomLevelRef.current), isGapEndpoint);
  }

  function openInfo(marker, html) {
    if (!sharedIwRef.current) return;
    sharedIwRef.current.setContent(html);
    sharedIwRef.current.open(mapRef.current, marker);
  }

  // 클릭한 마커의 좌표를 카카오 Geocoder 로 비동기 해석.
  // 메모리 캐시 (현 세션 빠름) + localStorage (세션 간 유지, TTL 30일).
  // 4자리 좌표 (≈11m) 그리드로 키 양자화 — 같은 건물/도로면 재호출 0건.
  function resolveAddress(lat, lng) {
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    // L1: in-memory
    if (addrCacheRef.current.has(key)) {
      return Promise.resolve(addrCacheRef.current.get(key));
    }
    // L2: localStorage
    try {
      const raw = localStorage.getItem('addrcache:' + key);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && obj.t && Date.now() - obj.t < 30 * 86400_000) {
          addrCacheRef.current.set(key, obj.v);
          return Promise.resolve(obj.v);
        }
      }
    } catch { /* noop */ }

    if (!geocoderRef.current && window.kakao?.maps?.services) {
      geocoderRef.current = new window.kakao.maps.services.Geocoder();
    }
    if (!geocoderRef.current) return Promise.resolve(null);
    return new Promise(resolve => {
      geocoderRef.current.coord2Address(lng, lat, (result, status) => {
        let out = null;
        if (status === window.kakao.maps.services.Status.OK && result?.length) {
          const r = result[0];
          out = {
            road:     r.road_address?.address_name || null,
            building: r.road_address?.building_name || null,
            jibun:    r.address?.address_name || null,
          };
        }
        addrCacheRef.current.set(key, out);
        try { localStorage.setItem('addrcache:' + key, JSON.stringify({ t: Date.now(), v: out })); } catch {}
        resolve(out);
      });
    });
  }

  // builder(addr) → HTML.  addr = null 일 때는 '위치 확인 중...' placeholder.
  function openInfoWithAddr(marker, lat, lng, builder) {
    if (!sharedIwRef.current) return;
    const reqId = ++iwReqIdRef.current;
    sharedIwRef.current.setContent(builder(null));
    sharedIwRef.current.open(mapRef.current, marker);
    resolveAddress(lat, lng).then(addr => {
      if (iwReqIdRef.current !== reqId) return;       // 다른 마커로 이동했으면 무시
      sharedIwRef.current.setContent(builder(addr));
    });
  }

  // gap (통신 두절) 구간 클릭 시 — 양 끝 timestamp + 좌표를 자연 키로 표시.
  // 복사 버튼은 글로벌 함수 등록 (InfoWindow 의 inline onclick 한정 사용).
  function openInfoWithGap(lat, lng, info) {
    if (!sharedIwRef.current) return;
    sharedIwRef.current.setContent(buildGapInfoHTML(info));
    sharedIwRef.current.setPosition(new window.kakao.maps.LatLng(lat, lng));
    sharedIwRef.current.open(mapRef.current);
  }

  useImperativeHandle(ref, () => ({
    /**
     * 컨테이너 크기·display 가 바뀐 뒤 호출 — kakao Map 이 새 dimension 에 맞춰 다시 그림.
     * display: none → block 전환 후 (예: corporate 탭 → home 복귀) 안 부르면 회색 화면.
     * relayout 자체가 일부 환경에서 center/zoom 을 흔들 수 있어 직전 상태 스냅샷 후 복원.
     */
    relayout() {
      if (!mapRef.current) return;
      const center = mapRef.current.getCenter();
      const level  = mapRef.current.getLevel();
      mapRef.current.relayout();
      if (center) mapRef.current.setCenter(center);
      if (level != null) mapRef.current.setLevel(level);
    },

    /**
     * 시커 슬롯 선택 표시용 핀 — 누를 때마다 한 군데에만 떠 있음.
     * 같은 핀 이미지를 라이브 마커도 쓰지만 zIndex 차이 + 시커 종료 시 자동 제거로 구분.
     */
    setSeekerPin(lat, lng, color) {
      if (!mapRef.current) return;
      const pos = new window.kakao.maps.LatLng(lat, lng);
      if (seekerPinRef.current) {
        seekerPinRef.current.setPosition(pos);
        seekerPinRef.current.setImage(pinImage(color || '#5B7CFF'));
      } else {
        seekerPinRef.current = new window.kakao.maps.Marker({
          map: mapRef.current, position: pos,
          image: pinImage(color || '#5B7CFF'),
          zIndex: 250,   // 라이브 마커(200) 보다 위 — 사용자가 막 누른 슬롯이라 우선
        });
      }
    },
    clearSeekerPin() {
      seekerPinRef.current?.setMap(null);
      seekerPinRef.current = null;
    },
    /**
     * Place / move main marker for deviceId, append to trail with given color.
     * meta: { recordedAt, sat, vbatMv, fix, stale }
     */
    updateMarker(deviceId, lat, lng, label, color, meta = {}) {
      if (!mapRef.current) return;
      const pos = new window.kakao.maps.LatLng(lat, lng);

      if (markersRef.current[deviceId]) {
        const e = markersRef.current[deviceId];
        e.marker.setPosition(pos);
        // color 변화 시 핀 이미지 재생성. 캐시되어있어 거의 즉시.
        if (e.color !== color) {
          e.marker.setImage(pinImage(color || '#5B7CFF'));
        }
        e.color = color;
        e.meta = meta;
        e.label = label;
      } else {
        // 필터 적용 — 다른 디바이스 데이터가 필터 무시하고 그려지는 것 방지.
        const visible = currentFilterIdRef.current == null || currentFilterIdRef.current === deviceId;
        const marker = new window.kakao.maps.Marker({
          map: visible ? mapRef.current : null,
          position: pos,
          title: label,
          image: pinImage(color || '#5B7CFF'),
          // 라이브 위치 마커 — 옛 history 점(1~3) / cursor(99) 보다 명확히 위로.
          zIndex: 200,
        });
        window.kakao.maps.event.addListener(marker, 'click', () => {
          const e = markersRef.current[deviceId];
          if (!e) return;
          const p = e.marker.getPosition();
          const lat = p.getLat(), lng = p.getLng();
          if (onPointInfoRef.current) {
            // React-side 처리 (모바일 bottom-sheet 등). placeholder 후 비동기 resolve.
            const base = { kind: 'main', label: e.label, color: e.color, meta: e.meta || {}, lat, lng };
            onPointInfoRef.current({ ...base, addr: null });
            resolveAddress(lat, lng).then(addr => {
              onPointInfoRef.current?.({ ...base, addr });
            });
          } else {
            openInfoWithAddr(e.marker, lat, lng,
              (addr) => buildMainInfoHTML(e.label, e.color, e.meta || {}, addr, lat, lng));
          }
        });
        markersRef.current[deviceId] = { marker, color, meta, label };
      }

      // ── trail polyline (segment + gap 분리) ─────────────────────────
      // recordedAt 시간 gap > POLYLINE_GAP_THRESHOLD_S 면 sleep/reset/통신두절 추정.
      // 새 solid segment 시작 + 직전 segment 끝 → 현재 좌표 잇는 dashed polyline 추가.
      const stroke = color || '#888';
      const opacity = meta.stale ? 0.35 : 0.85;
      const sw = strokeWeightForLevel(zoomLevelRef.current);
      const newRecordedAt = meta.recordedAt ? new Date(meta.recordedAt).getTime() : Date.now();
      const prevRecordedAt = lastRecordedAtRef.current[deviceId];
      const gapS = prevRecordedAt ? (newRecordedAt - prevRecordedAt) / 1000 : 0;
      const isGap = prevRecordedAt && gapS > POLYLINE_GAP_THRESHOLD_S;

      if (!polyRef.current[deviceId]) {
        polyRef.current[deviceId] = { segments: [], gaps: [] };
      }
      const entry = polyRef.current[deviceId];

      if (isGap || entry.segments.length === 0) {
        // gap 발견 → 직전 segment 끝 좌표 ↔ 현재 좌표 잇는 dashed (시각 전용, 클릭 X)
        // 클릭 가능한 정보는 gap 양끝 history point marker 에서 (meta.gapBefore/gapAfter) 처리.
        if (isGap && entry.segments.length > 0) {
          const lastSeg = entry.segments[entry.segments.length - 1];
          const lastPos = lastSeg.coords[lastSeg.coords.length - 1];
          if (lastPos) {
            const dashedVisible = currentFilterIdRef.current == null || currentFilterIdRef.current === deviceId;
            const dashed = new window.kakao.maps.Polyline({
              map: dashedVisible ? mapRef.current : null,
              path: [lastPos, pos],
              strokeWeight: Math.max(1, sw - 1),
              strokeColor: stroke,
              strokeOpacity: 0.45,
              strokeStyle: 'shortdash',
            });
            entry.gaps.push(dashed);
          }
        }
        const coords = [pos];
        const polyVisible = currentFilterIdRef.current == null || currentFilterIdRef.current === deviceId;
        const poly = new window.kakao.maps.Polyline({
          map: polyVisible ? mapRef.current : null,
          path: coords,
          strokeWeight: sw,
          strokeColor: stroke,
          strokeOpacity: opacity,
          strokeStyle: 'solid',
        });
        entry.segments.push({ coords, poly });
      } else {
        // 기존 마지막 segment 연속 — coords append + path 갱신
        const lastSeg = entry.segments[entry.segments.length - 1];
        lastSeg.coords.push(pos);
        lastSeg.poly.setPath(lastSeg.coords);
        lastSeg.poly.setOptions({ strokeColor: stroke, strokeOpacity: opacity, strokeWeight: sw });
      }

      lastRecordedAtRef.current[deviceId] = newRecordedAt;
    },

    /**
     * 궤적 위의 개별 fix 점에 작은 클릭가능한 마커를 추가.
     * meta: { recordedAt, sat, vbatMv, fix, skipMarker?, isGapEndpoint? }
     *
     * meta.skipMarker=true → dot 마커 생성 안 함, 진행방향 화살표 accumulator 만 갱신.
     *   호출자 (Dashboard) 가 priority sampling 으로 일부만 클릭 가능하게 만들 때 사용.
     *   화살표 흐름은 모든 점 기준으로 계속 정확하게 유지됨.
     * meta.isGapEndpoint=true → gap 양끝 점. 화살표(zIndex 4) 위로 올라오게 zIndex 5 + 살짝 큰 점.
     */
    addHistoryPoint(deviceId, lat, lng, color, meta = {}) {
      if (!mapRef.current) return;
      const pos = new window.kakao.maps.LatLng(lat, lng);
      const isStop = !!meta.isStop;
      const c = color || '#888';

      const dotVisible = currentFilterIdRef.current == null || currentFilterIdRef.current === deviceId;
      if (!meta.skipMarker) {
        // cluster (5+ 점 좁은 범위 뭉침) 은 디바이스 색 무시하고 강제 빨강 — 시각적 경고.
        const dotColor = isStop ? '#EF4444' : c;
        // gap 양끝 점은 화살표(zIndex 4) 보다 위로 올라와야 클릭 가능. stop / 일반은 그대로.
        const zIdx = meta.isGapEndpoint ? 5 : (isStop ? 2 : 1);
        const marker = new window.kakao.maps.Marker({
          map: dotVisible ? mapRef.current : null,
          position: pos,
          image: makeDotImage(dotColor, isStop, meta.isGapEndpoint),
          clickable: true,
          zIndex: zIdx,
        });
        window.kakao.maps.event.addListener(marker, 'click', () => {
          const p = marker.getPosition();
          const la = p.getLat(), ln = p.getLng();
          if (onPointInfoRef.current) {
            const base = { kind: 'point', color: c, meta, lat: la, lng: ln };
            onPointInfoRef.current({ ...base, addr: null });
            resolveAddress(la, ln).then(addr => {
              onPointInfoRef.current?.({ ...base, addr });
            });
          } else {
            openInfoWithAddr(marker, la, ln,
              (addr) => buildPointInfoHTML(meta, c, addr, la, ln));
          }
        });
        if (!pointsRef.current[deviceId]) pointsRef.current[deviceId] = [];
        pointsRef.current[deviceId].push({ marker, color: c, isStop });
      }

      // 진행 방향 화살표 — deviceId 별 누적 distance, ARROW_INTERVAL_M 마다 1개.
      const st = arrowStateRef.current[deviceId];
      if (st) {
        const segDist = distanceM({ lat: st.lastPos.lat, lng: st.lastPos.lng }, { lat, lng });
        st.distAcc += segDist;
        if (st.distAcc >= ARROW_INTERVAL_M) {
          st.distAcc = 0;
          const angle = calcBearing(st.lastPos.lat, st.lastPos.lng, lat, lng);
          const am = new window.kakao.maps.Marker({
            map: dotVisible ? mapRef.current : null,
            position: pos,
            image: makeArrowImage(angle, c),
            clickable: false,
            zIndex: 4,
          });
          if (!arrowsRef.current[deviceId]) arrowsRef.current[deviceId] = [];
          arrowsRef.current[deviceId].push(am);
        }
        st.lastPos = { lat, lng };
      } else {
        arrowStateRef.current[deviceId] = { lastPos: { lat, lng }, distAcc: 0 };
      }
    },

    /** 디바이스의 history 점들 + 방향 화살표를 모두 제거 (loadDevices 직전 호출용). */
    clearHistoryPoints(deviceId) {
      const arr = pointsRef.current[deviceId];
      if (arr) {
        arr.forEach(({ marker }) => marker.setMap(null));
        delete pointsRef.current[deviceId];
      }
      const arrows = arrowsRef.current[deviceId];
      if (arrows) {
        arrows.forEach(m => m.setMap(null));
        delete arrowsRef.current[deviceId];
      }
      delete arrowStateRef.current[deviceId];
    },

    /**
     * 모든 디바이스의 history 점들을 일시적으로 숨김/노출 (지우지 않고 visibility 만).
     * 시커 활성 시 호출하면 라이브 trail (초록) 가 seeker path (파랑) 와 시각 충돌 없이 정리됨.
     */
    setHistoryPointsVisible(visible) {
      if (!mapRef.current) return;
      Object.values(pointsRef.current).forEach(arr => {
        arr.forEach(({ marker }) => marker.setMap(visible ? mapRef.current : null));
      });
      Object.values(arrowsRef.current).forEach(arr => {
        arr.forEach(m => m.setMap(visible ? mapRef.current : null));
      });
    },
    setLiveTrailsVisible(visible) {
      if (!mapRef.current) return;
      Object.values(polyRef.current).forEach(entry => {
        entry.segments.forEach(s => s.poly.setMap(visible ? mapRef.current : null));
        entry.gaps.forEach(g => g.setMap(visible ? mapRef.current : null));
      });
    },

    setMarkerColor(deviceId, color) {
      const me = markersRef.current[deviceId];
      if (me) me.color = color;
      const entry = polyRef.current[deviceId];
      if (entry) {
        entry.segments.forEach(s => s.poly.setOptions({ strokeColor: color }));
        entry.gaps.forEach(g => g.setOptions({ strokeColor: color }));
      }
      // history dots 색깔 변경 — isStop 점은 디바이스 색 변경에도 빨강 유지.
      const arr = pointsRef.current[deviceId];
      if (arr) {
        const sz = dotSizeForLevel(zoomLevelRef.current);
        arr.forEach(o => {
          o.color = color;
          const dotColor = o.isStop ? '#EF4444' : color;
          o.marker.setImage(dotImageCached(dotColor, o.isStop, sz));
        });
      }
    },

    focusDevice(deviceId) {
      const entry = markersRef.current[deviceId];
      if (entry) mapRef.current?.panTo(entry.marker.getPosition());
    },

    fitToAllMarkers(padding = 50) {
      if (!mapRef.current) return;
      const entries = Object.values(markersRef.current);
      if (entries.length === 0) return;
      const bounds = new window.kakao.maps.LatLngBounds();
      entries.forEach(({ marker }) => bounds.extend(marker.getPosition()));
      markProgrammatic();
      mapRef.current.setBounds(bounds, padding, padding, padding, padding);
    },

    /** 저장된 사용자 view (center+level) 로 복원 — 새로고침 후 호출. */
    setView(lat, lng, level) {
      if (!mapRef.current) return;
      markProgrammatic();
      mapRef.current.setCenter(new window.kakao.maps.LatLng(lat, lng));
      if (level != null) mapRef.current.setLevel(level);
    },

    /**
     * 특정 디바이스만 보이게 / null이면 전체 보이기.
     * opts.fit (default true) — false 면 setBounds 안 함 (사용자 저장 view 복원과 결합).
     */
    filterToDevice(targetId, opts = {}) {
      if (!mapRef.current || !window.kakao?.maps) return;
      currentFilterIdRef.current = targetId;   // 새 마커 생성 시 참조
      const all = mapRef.current;
      Object.entries(markersRef.current).forEach(([id, { marker }]) => {
        marker.setMap((targetId === null || +id === targetId) ? all : null);
      });
      Object.entries(polyRef.current).forEach(([id, entry]) => {
        const vis = (targetId === null || +id === targetId);
        entry.segments.forEach(s => s.poly.setMap(vis ? all : null));
        entry.gaps.forEach(g => g.setMap(vis ? all : null));
      });
      Object.entries(pointsRef.current).forEach(([id, arr]) => {
        const vis = (targetId === null || +id === targetId);
        arr.forEach(({ marker }) => marker.setMap(vis ? all : null));
      });
      Object.entries(arrowsRef.current).forEach(([id, arr]) => {
        const vis = (targetId === null || +id === targetId);
        arr.forEach(m => m.setMap(vis ? all : null));
      });

      // bounds 재조정 — opts.fit=false 면 skip (사용자 저장 view 복원 시 zoom 보존)
      sharedIwRef.current?.close();
      const { fit = true } = opts;
      if (!fit) return;
      if (targetId !== null) {
        const pts = pointsRef.current[targetId] || [];
        const main = markersRef.current[targetId];
        const bounds = new window.kakao.maps.LatLngBounds();
        pts.forEach(({ marker }) => bounds.extend(marker.getPosition()));
        if (main) bounds.extend(main.marker.getPosition());
        if (!bounds.isEmpty()) {
          markProgrammatic();
          mapRef.current?.setBounds(bounds, 60, 60, 60, 60);
        }
      } else {
        const bounds = new window.kakao.maps.LatLngBounds();
        Object.values(markersRef.current).forEach(({ marker }) => bounds.extend(marker.getPosition()));
        if (!bounds.isEmpty()) {
          markProgrammatic();
          mapRef.current?.setBounds(bounds, 60, 60, 60, 60);
        }
      }
    },

    getCurrentCenter() {
      if (!mapRef.current) return null;
      const c = mapRef.current.getCenter();
      return { lat: c.getLat(), lng: c.getLng() };
    },

    setMapType(mode) {
      if (!mapRef.current || !window.kakao?.maps?.MapTypeId) return;
      const T = window.kakao.maps.MapTypeId;
      const id = mode === 'skyview' ? T.SKYVIEW
              : mode === 'hybrid'   ? T.HYBRID
              : mode === 'use_district' ? T.USE_DISTRICT
              : T.ROADMAP;
      mapRef.current.setMapTypeId(id);
    },

    toggleCadastral(on) {
      if (!mapRef.current || !window.kakao?.maps) return;
      const T = window.kakao.maps.MapTypeId;
      if (on) mapRef.current.addOverlayMapTypeId(T.USE_DISTRICT);
      else    mapRef.current.removeOverlayMapTypeId(T.USE_DISTRICT);
    },

    drawGeofence(geofenceId, lat, lng, radius, name = '', inside = false) {
      if (!mapRef.current) return;
      // 진입 시 빨강(경고), 바깥일 때 초록(정상). 진입 시엔 fill 진하게 강조.
      const color = inside ? '#EF4444' : '#10B981';
      const fillOpacity = inside ? 0.28 : 0.14;
      const center = new window.kakao.maps.LatLng(lat, lng);
      const existing = fenceRef.current[geofenceId];
      if (existing) {
        existing.circle.setPosition(center);
        existing.circle.setRadius(radius);
        existing.circle.setOptions({
          strokeColor: color, fillColor: color,
          strokeStyle: inside ? 'solid' : 'dashed',
          fillOpacity,
        });
        existing.inside = inside;
      } else {
        const circle = new window.kakao.maps.Circle({
          map: mapRef.current, center, radius,
          strokeWeight: 2, strokeColor: color,
          strokeOpacity: 0.85,
          strokeStyle: inside ? 'solid' : 'dashed',
          fillColor: color, fillOpacity,
        });
        fenceRef.current[geofenceId] = { circle, name, inside };
      }
    },

    /** 임의 좌표로 지도 중심 이동 (애니메이션). */
    panToCoord(lat, lng) {
      if (!mapRef.current) return;
      mapRef.current.panTo(new window.kakao.maps.LatLng(lat, lng));
    },

    /**
     * Seeker 전용 history path 그리기.
     * points: [{ lat, lng, recorded_at, _speed?, _isStop? }] (시간 오름차순)
     * opts: { color, speedColor, timeColor, showStops, showCursor, onPointClick(point, idx) }
     * 반환: 동일 시그니처로 cursor 위치만 업데이트할 수 있는 헬퍼들 (setCursor, fitBounds).
     */
    drawSeekerPath(points, opts = {}) {
      if (!mapRef.current) return null;
      this.clearSeekerPath();
      const {
        color = '#5B7CFF', speedColor = false, timeColor = false, showStops = true,
        showCursor = false, onPointClick = null,
        maxMarkers = 300,        // 마커 폭주 방지 — 폴리라인은 그대로, 마커만 캡
        stopMergeRadiusM = 35,   // nearby stop markers are absorbed into one representative marker
        minBucketRun = 3,        // 노이즈 단일 버킷 전환 무시 (>=3 점 연속이어야 새 segment)
        timeSegments = 5,       // 하루 왕복 경로가 겹칠 때 시간대별 선 색상 분리
      } = opts;

      // 호출자에 따라 server DESC 순서로 그대로 넘어올 수 있음 (MiniSeekerOverlay) → 화살표 방향 역전.
      // 여기서 recorded_at ASC 로 강제 정렬 (이미 ASC 면 빠르게 통과). 모든 호출자에 안전.
      const pts = points
        .filter(p => p.lat != null && p.lng != null)
        .slice()
        .sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
      if (pts.length === 0) return null;

      const sw = strokeWeightForLevel(zoomLevelRef.current);

      // ── 폴리라인 ──
      // speedColor: 연속 같은 버킷끼리 묶고, run-length 최소 minBucketRun 미만 노이즈는 흡수.
      if (speedColor) {
        // 1차: 인접 같은 버킷 그룹화
        const segs = [];   // { bucket, start, end } end exclusive
        let s = 0, cur = speedBucket(pts[0]);
        for (let i = 1; i <= pts.length; i++) {
          const b = i < pts.length ? speedBucket(pts[i]) : null;
          if (b !== cur || i === pts.length) {
            segs.push({ bucket: cur, start: s, end: i });
            s = i; cur = b;
          }
        }
        // 2차: 짧은 segment 를 이전 segment 에 흡수 (시각 노이즈 제거)
        for (let i = 1; i < segs.length; i++) {
          const seg = segs[i];
          if (seg.end - seg.start < minBucketRun) {
            segs[i - 1].end = seg.end;
            segs.splice(i, 1); i--;
          }
        }
        // 그리기
        for (const seg of segs) {
          const segPath = [];
          // segment 끝점은 다음 segment 시작점과 이어주려고 +1 까지 포함
          const lastIdx = Math.min(seg.end, pts.length - 1);
          for (let i = seg.start; i <= lastIdx; i++) {
            segPath.push(new window.kakao.maps.LatLng(pts[i].lat, pts[i].lng));
          }
          if (segPath.length >= 2) {
            const poly = new window.kakao.maps.Polyline({
              map: mapRef.current, path: segPath,
              strokeWeight: sw,
              strokeColor: BUCKET_COLORS[seg.bucket] || color,
              strokeOpacity: 0.85,
              strokeStyle: 'solid',
            });
            seekerRef.current.poly.push(poly);
          }
        }
      } else if (timeColor && pts.length >= 2) {
        const segmentCount = Math.max(2, Math.min(timeSegments, TIME_SEGMENT_COLORS.length, pts.length - 1));
        for (let seg = 0; seg < segmentCount; seg++) {
          const start = Math.floor((pts.length - 1) * seg / segmentCount);
          const end = Math.floor((pts.length - 1) * (seg + 1) / segmentCount);
          const segPath = [];
          for (let i = start; i <= end; i++) {
            segPath.push(new window.kakao.maps.LatLng(pts[i].lat, pts[i].lng));
          }
          if (segPath.length >= 2) {
            const poly = new window.kakao.maps.Polyline({
              map: mapRef.current, path: segPath,
              strokeWeight: sw,
              strokeColor: TIME_SEGMENT_COLORS[seg] || color,
              strokeOpacity: 0.68,
              strokeStyle: 'solid',
            });
            seekerRef.current.poly.push(poly);
          }
        }
      } else {
        const path = pts.map(p => new window.kakao.maps.LatLng(p.lat, p.lng));
        const poly = new window.kakao.maps.Polyline({
          map: mapRef.current, path,
          strokeWeight: sw, strokeColor: color, strokeOpacity: 0.8, strokeStyle: 'solid',
        });
        seekerRef.current.poly.push(poly);
      }

      // ── dot markers ──
      // 1) stops 는 항상 모두 그린다 (강조 + 클릭 가능)
      // 2) 그 외 일반 점은 maxMarkers 안에서 균등 샘플링 (시각 가이드용)
      // 3) 첫/마지막은 강제 포함 (시작/종료 가시화)
      const dotSize = dotSizeForLevel(zoomLevelRef.current);
      const stopIdxSet = new Set();
      pts.forEach((p, i) => { if (p._isStop) stopIdxSet.add(i); });

      const stopCount = stopIdxSet.size;
      const nonStopBudget = Math.max(0, maxMarkers - stopCount);
      const total = pts.length;
      const renderIdxSet = new Set(stopIdxSet);
      renderIdxSet.add(0);
      renderIdxSet.add(total - 1);

      if (nonStopBudget >= total) {
        // 다 그려도 부담 적음 → 전부 렌더 (소규모 데이터)
        for (let i = 0; i < total; i++) renderIdxSet.add(i);
      } else if (nonStopBudget > 0) {
        // 균등 샘플링
        const step = Math.max(1, Math.floor(total / nonStopBudget));
        for (let i = 0; i < total; i += step) renderIdxSet.add(i);
      }
      // 정렬은 불필요 — Set 순회로 충분

      const markerIdxSet = showStops
        ? compactStopMarkerIndexes(pts, renderIdxSet, stopMergeRadiusM)
        : renderIdxSet;

      markerIdxSet.forEach(idx => {
        const p = pts[idx];
        if (!p) return;
        const isStop = !!p._isStop && showStops;
        const dotColor = isStop
          ? '#EF4444'
          : speedColor
            ? (BUCKET_COLORS[speedBucket(p)] || color)
            : timeColor
              ? (TIME_SEGMENT_COLORS[timeSegmentIndex(idx, total, Math.min(timeSegments, TIME_SEGMENT_COLORS.length))] || color)
              : color;
        // 클릭 허용 조건:
        //   - onPointClick(SeekerSheet 재생용): 부담 줄이기 위해 isStop 또는 total <= 200 일 때만
        //   - onPointInfo(모바일 sheet): 항상 (이미 maxMarkers 캡으로 렌더링 제한됨)
        const wantsClick =
          (onPointClick && (isStop || total <= 200)) ||
          !!onPointInfoRef.current;
        const marker = new window.kakao.maps.Marker({
          map: mapRef.current,
          position: new window.kakao.maps.LatLng(p.lat, p.lng),
          image: dotImageCached(dotColor, isStop, dotSize),
          clickable: wantsClick,
          zIndex: isStop ? 3 : 2,
        });
        if (wantsClick) {
          window.kakao.maps.event.addListener(marker, 'click', () => {
            // 외부 onPointClick(SeekerSheet 재생용) 우선 — 같이 있으면 그쪽도 호출.
            if (onPointClick) onPointClick(p, idx);
            // 모바일 sheet 콜백 — 항상 정보 emit (placeholder 후 비동기 주소 갱신).
            if (onPointInfoRef.current) {
              const base = {
                kind: 'point', color: dotColor,
                meta: { recordedAt: p.recorded_at, isStop, speedKmh: p._speed, sat: p.sat, vbatMv: p.vbat_mv },
                lat: p.lat, lng: p.lng,
              };
              onPointInfoRef.current({ ...base, addr: null });
              resolveAddress(p.lat, p.lng).then(addr => {
                onPointInfoRef.current?.({ ...base, addr });
              });
            }
          });
        }
        seekerRef.current.pts.push(marker);
      });

      // ── 진행 방향 화살표 — 누적 ARROW_INTERVAL_M (200m) 마다 1개 ─────────────
      {
        let distAcc = 0;
        let nextArrowAt = ARROW_INTERVAL_M;
        for (let i = 1; i < pts.length; i++) {
          const prev = pts[i - 1], cur = pts[i];
          const segDist = distanceM({ lat: prev.lat, lng: prev.lng }, { lat: cur.lat, lng: cur.lng });
          distAcc += segDist;
          if (distAcc >= nextArrowAt) {
            nextArrowAt = distAcc + ARROW_INTERVAL_M;
            const angle = calcBearing(prev.lat, prev.lng, cur.lat, cur.lng);
            const arrowColor = speedColor ? (BUCKET_COLORS[speedBucket(cur)] || color) : color;
            const am = new window.kakao.maps.Marker({
              map: mapRef.current,
              position: new window.kakao.maps.LatLng(cur.lat, cur.lng),
              image: makeArrowImage(angle, arrowColor),
              clickable: false,
              zIndex: 4,
            });
            seekerRef.current.pts.push(am);
          }
        }
      }

      // cursor (재생용 큰 마커)
      if (showCursor && pts[0]) {
        const cursor = new window.kakao.maps.Marker({
          map: mapRef.current,
          position: new window.kakao.maps.LatLng(pts[0].lat, pts[0].lng),
          image: cursorImage(color),
          zIndex: 99,
        });
        seekerRef.current.cursor = cursor;
      }

      // bounds fit
      if (pts.length > 1) {
        const bounds = new window.kakao.maps.LatLngBounds();
        pts.forEach(p => bounds.extend(new window.kakao.maps.LatLng(p.lat, p.lng)));
        mapRef.current.setBounds(bounds, 60, 60, 60, 60);
      } else {
        mapRef.current.setCenter(new window.kakao.maps.LatLng(pts[0].lat, pts[0].lng));
      }

      return {
        setCursor(idx) {
          const c = seekerRef.current.cursor;
          const p = pts[idx];
          if (!c || !p) return;
          c.setPosition(new window.kakao.maps.LatLng(p.lat, p.lng));
        },
      };
    },

    clearSeekerPath() {
      seekerRef.current.poly.forEach(p => p.setMap(null));
      seekerRef.current.pts.forEach(m => m.setMap(null));
      seekerRef.current.cursor?.setMap(null);
      seekerRef.current = { poly: [], pts: [], cursor: null };
      // 시커 닫힐 때 선택 핀도 같이 정리.
      seekerPinRef.current?.setMap(null);
      seekerPinRef.current = null;
    },

    removeGeofence(geofenceId) {
      const entry = fenceRef.current[geofenceId];
      if (entry) { entry.circle.setMap(null); delete fenceRef.current[geofenceId]; }
    },

    clearAllGeofences() {
      Object.values(fenceRef.current).forEach(e => e.circle.setMap(null));
      fenceRef.current = {};
    },

    removeMarker(deviceId) {
      const entry = markersRef.current[deviceId];
      if (entry) {
        entry.marker.setMap(null);
        delete markersRef.current[deviceId];
      }
      const polyEntry = polyRef.current[deviceId];
      if (polyEntry) {
        polyEntry.segments.forEach(s => s.poly.setMap(null));
        polyEntry.gaps.forEach(g => g.setMap(null));
        delete polyRef.current[deviceId];
      }
      delete lastRecordedAtRef.current[deviceId];
      const pts = pointsRef.current[deviceId];
      if (pts) {
        pts.forEach(({ marker }) => marker.setMap(null));
        delete pointsRef.current[deviceId];
      }
      const arrows = arrowsRef.current[deviceId];
      if (arrows) {
        arrows.forEach(m => m.setMap(null));
        delete arrowsRef.current[deviceId];
      }
      delete arrowStateRef.current[deviceId];
    },
  }));

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
});

// ── InfoWindow content builders ────────────────────────────────────

// 모노크롬 inline SVG — InfoWindow 안에서 currentColor 사용.
const SVG_PIN  = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
const SVG_BAT  = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="18" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/></svg>';
const SVG_SAT  = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><path d="M12 6V2M12 22v-4M2 12h4M22 12h-4"/></svg>';
const SVG_RUN  = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h6l3-6 3 12 3-6h3"/></svg>';
const SVG_CAM  = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';

const ROW = (svg, html) =>
  `<div style="display:flex;align-items:center;gap:6px;color:var(--iw-text,#444)">${svg}<span>${html}</span></div>`;

function addrLine(addr) {
  // addr = { road, building, jibun } | null | undefined(=loading)
  if (addr === null) return '<span style="color:#aaa">주소 정보 없음</span>';
  if (!addr) return '<span style="color:#aaa;font-style:italic">위치 확인 중...</span>';
  if (addr.road) {
    const road = escHtml(addr.road);
    return addr.building
      ? `${road}<br><span style="color:#666;font-size:11px">${escHtml(addr.building)}</span>`
      : road;
  }
  if (addr.jibun) return escHtml(addr.jibun);
  return '<span style="color:#aaa">주소 정보 없음</span>';
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[c]));
}

// gap 복사 버튼용 — 텍스트를 글로벌 store 에 보관 후 id 반환. onclick attribute 안에 큰
// JSON 문자열을 직접 넣으면 따옴표 escape 가 깨져서 (Unexpected end of input) 안전한
// id-lookup 방식 사용. window.__btw_copyGap(id, this) 가 store 에서 읽어 클립보드 복사.
let __gapTextSeq = 0;
function registerGapCopyText(text) {
  const id = `g${++__gapTextSeq}`;
  if (typeof window !== 'undefined') {
    window.__btw_gapTexts = window.__btw_gapTexts || {};
    window.__btw_gapTexts[id] = text;
  }
  return id;
}

// gap (통신 두절) 구간 InfoWindow HTML — 양 끝 timestamp + 좌표 + 복사 가능 텍스트.
// device_id + recorded_at 자연 키만으로 server location_records 와 정확 매칭 가능.
function buildGapInfoHTML(info) {
  const { deviceId, label, color, fromTs, toTs, fromLatLng, toLatLng, gapS } = info;
  const fromISO = new Date(fromTs).toISOString();
  const toISO = new Date(toTs).toISOString();
  const fromKr = new Date(fromTs).toLocaleString('ko-KR');
  const toKr = new Date(toTs).toLocaleString('ko-KR');
  const gapMin = Math.round(gapS / 60);
  const gapStr = gapMin >= 60 ? `${Math.floor(gapMin/60)}시간 ${gapMin%60}분` : `${gapMin}분`;
  const copyText = [
    `device_id: ${deviceId} (${label})`,
    `gap: ${gapStr}`,
    `from: ${fromISO}  (${fromLatLng.lat.toFixed(6)}, ${fromLatLng.lng.toFixed(6)})`,
    `to:   ${toISO}  (${toLatLng.lat.toFixed(6)}, ${toLatLng.lng.toFixed(6)})`,
  ].join('\n');
  return `
    <div style="padding:12px 14px;font-size:12px;font-family:-apple-system,system-ui,sans-serif;min-width:280px;line-height:1.55;color:#1a1a2e">
      <div style="font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:6px">
        <span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:${color || '#888'}"></span>
        📡 통신 두절 구간 · ${escHtml(label)}
      </div>
      <div style="font-size:11px;color:#666;margin-bottom:6px">두 좌표 사이 ingest 가 ${gapStr} 끊김 (sleep / reset / signal_loss 등)</div>
      <div style="background:#f5f5f7;border-radius:6px;padding:8px 10px;margin-bottom:8px;font-family:ui-monospace,monospace;font-size:11px;white-space:pre-wrap;user-select:all">${escHtml(copyText)}</div>
      <button onclick="window.__btw_copyGap('${registerGapCopyText(copyText)}',this)" style="background:#1a1a2e;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;width:100%">📋 복사</button>
    </div>
  `;
}

function buildMainInfoHTML(label, color, m, addr, lat, lng) {
  const fixTxt = m.fix === false ? 'no fix' : 'fix';
  const ageTxt = m.recordedAt ? new Date(m.recordedAt).toLocaleString('ko-KR') : '—';
  const sat    = m.sat ?? '—';
  const vbat   = m.vbatMv ? `${m.vbatMv} mV` : '—';
  const speed  = m.speedKmh != null ? ROW(SVG_RUN, `${m.speedKmh.toFixed(1)} km/h`) : '';
  // 라이브 마커도 gap 양끝점일 수 있음 — gap 정보 노출.
  const gapBlock = (m.gapBefore || m.gapAfter) ? buildGapInPointBlock(m, lat, lng) : '';
  return `
    <div style="padding:12px 14px;font-size:12px;font-family:-apple-system,system-ui,sans-serif;min-width:240px;line-height:1.55;color:#1a1a2e">
      <div style="font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:6px">
        <span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:${color || '#888'}"></span>
        ${escHtml(label)}
      </div>
      ${ROW(SVG_PIN, addrLine(addr))}
      ${ROW(SVG_SAT, `${fixTxt} · sat ${sat}`)}
      ${ROW(SVG_BAT, vbat)}
      ${speed}
      <div style="color:#888;font-size:11px;margin:4px 0 10px">${ageTxt}</div>
      ${gapBlock}
      ${roadviewBtn(lat, lng)}
    </div>
  `;
}

function buildPointInfoHTML(m, color, addr, lat, lng) {
  const ageTxt = m.recordedAt ? new Date(m.recordedAt).toLocaleString('ko-KR') : '—';
  const sat    = m.sat ?? '—';
  const vbat   = m.vbatMv ? `${m.vbatMv} mV` : '—';
  const speed  = m.speedKmh != null ? ROW(SVG_RUN, `${m.speedKmh.toFixed(1)} km/h`) : '';
  const stopBadge = m.isStop
    ? `<span style="display:inline-block;background:#1a1a2e;color:#fbbf24;padding:1px 7px;border-radius:8px;font-size:10px;font-weight:600;margin-left:6px;letter-spacing:.04em">정지</span>`
    : '';
  // gap 정보 — 이 점이 통신 두절 구간의 시작점 또는 끝점인 경우 표시 + 복사 버튼.
  const gapBlock = (m.gapBefore || m.gapAfter)
    ? buildGapInPointBlock(m, lat, lng)
    : '';
  return `
    <div style="padding:12px 14px;font-size:12px;font-family:-apple-system,system-ui,sans-serif;min-width:240px;line-height:1.55;color:#1a1a2e">
      <div style="font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:6px">
        <span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:${color || '#888'}"></span>
        기록 지점${stopBadge}
      </div>
      ${ROW(SVG_PIN, addrLine(addr))}
      ${ROW(SVG_SAT, `sat ${sat} · ${vbat}`)}
      ${speed}
      <div style="color:#888;font-size:11px;margin:4px 0 10px">${ageTxt}</div>
      ${gapBlock}
      ${roadviewBtn(lat, lng)}
    </div>
  `;
}

// 포인터 InfoWindow 내 gap (통신 두절) 정보 + 복사 버튼.
// m.gapBefore / m.gapAfter = { gapS, peerTs, peerLat, peerLng } (peer = gap 반대편 좌표).
function buildGapInPointBlock(m, lat, lng) {
  const items = [];
  if (m.gapBefore) items.push({ ...m.gapBefore, side: 'before' });
  if (m.gapAfter)  items.push({ ...m.gapAfter,  side: 'after' });
  const blocks = items.map(it => {
    const peerKr  = new Date(it.peerTs).toLocaleString('ko-KR');
    const peerISO = new Date(it.peerTs).toISOString();
    const thisISO = m.recordedAt ? new Date(m.recordedAt).toISOString() : '';
    const gapMin  = Math.round(it.gapS / 60);
    const gapStr  = gapMin >= 60 ? `${Math.floor(gapMin/60)}시간 ${gapMin%60}분` : `${gapMin}분`;
    const label   = it.side === 'before' ? '⬅ 이전 좌표' : '➡ 다음 좌표';
    const lines = it.side === 'after'
      ? [
          `device: ${m.deviceLabel || '-'} (id=${m.deviceId || '-'})`,
          `gap: ${gapStr} (${it.side})`,
          `from: ${thisISO} (${lat.toFixed(6)}, ${lng.toFixed(6)})`,
          `to:   ${peerISO} (${it.peerLat.toFixed(6)}, ${it.peerLng.toFixed(6)})`,
        ]
      : [
          `device: ${m.deviceLabel || '-'} (id=${m.deviceId || '-'})`,
          `gap: ${gapStr} (${it.side})`,
          `from: ${peerISO} (${it.peerLat.toFixed(6)}, ${it.peerLng.toFixed(6)})`,
          `to:   ${thisISO} (${lat.toFixed(6)}, ${lng.toFixed(6)})`,
        ];
    const copyId = registerGapCopyText(lines.join('\n'));
    return `
      <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;padding:8px 10px;margin-bottom:6px">
        <div style="font-size:11px;font-weight:700;color:#c2410c;margin-bottom:3px">${label}와 ${gapStr} 통신 두절</div>
        <div style="font-size:11px;color:#666;margin-bottom:6px">${peerKr}</div>
        <button onclick="window.__btw_copyGap('${copyId}',this)" style="background:#1a1a2e;color:#fff;border:none;border-radius:5px;padding:5px 10px;font-size:11px;font-weight:600;cursor:pointer;width:100%">📋 보고 정보 복사</button>
      </div>
    `;
  }).join('');
  return `<div style="margin:6px 0 8px">${blocks}</div>`;
}

function roadviewBtn(lat, lng) {
  return `<button onclick="window.__btw_openRoadview(${lat},${lng})" style="
    box-sizing:border-box;
    width:100%;padding:7px 10px;margin-top:2px;
    background:#1a1a2e;color:white;border:none;border-radius:6px;
    font-size:12px;font-weight:600;cursor:pointer;
    display:flex;align-items:center;justify-content:center;gap:6px;
  ">${SVG_CAM} 로드뷰 보기</button>`;
}

export default KakaoMap;
