import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { compactStopMarkerIndexes as compactStopMarkerIndexesLib } from '../lib/stops';

const DEFAULT_CENTER = { lat: 37.5665, lng: 126.978 };
const MAX_HISTORY_POINTS = 500;
const MIN_TRAIL_POINT_DISTANCE_M = 20;
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
  // Kakao Maps zoom — 낮을수록 확대. 확대일수록 dot 크게 (이전 거꾸로였음).
  if (level <= 3)  return 22;   // 최대 확대 — 가장 크게
  if (level <= 5)  return 20;
  if (level <= 7)  return 18;
  if (level <= 9)  return 16;
  if (level <= 11) return 14;
  return 12;                    // 최대 축소 — 가장 작게 (다만 12 유지)
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

// (2026-07-29) Phase F7-a — Seeker canvas overlay.
//
// 배경: drawSeekerPath 는 point 당 kakao.maps.Marker 를 생성. maxMarkers=300 캡으로
// 5000-point trip 도 마커 300개로 제한하지만, 마커 생성/제거 자체가 DOM 요소 단위 —
// 장거리 trip 이 자주 열리면 사용자 체감 stutter. fingerprint 로 rebuild 는 이미 skip
// 하지만 실 데이터 변경 시엔 여전히 teardown+rebuild.
//
// Canvas overlay 는:
// - 전체 point 렌더 (마커 캡 없이, sampling 만 필요 시)
// - 렌더 = single canvas draw call = O(points) 이지만 DOM 조작 없음
// - zoom/pan 시 map projection 으로 재투영해 재렌더 (rAF throttle)
// - Cursor 는 여전히 kakao.maps.Marker 유지 (재생 시 setPosition 만 하면 되므로 저렴)
//
// 이 라운드는 parallel 구현 — drawSeekerPathCanvas 를 별도 method 로 제공.
// FleetDashboard 에서 ?canvas=1 flag 로 opt-in. 안정성 검증 후 다음 라운드에서 default.
class SeekerCanvasOverlay {
  constructor(map) {
    this.map = map;
    this.pts = [];
    this.opts = {};
    this._raf = null;

    const container = map.getNode();
    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '2';   // above tiles, below markers (kakao markers ~200+)
    container.appendChild(canvas);
    this._canvas = canvas;
    this._container = container;

    this._onIdle = () => this._schedule();
    this._onResize = () => { this._resize(); this._schedule(); };
    window.kakao.maps.event.addListener(map, 'idle', this._onIdle);
    window.kakao.maps.event.addListener(map, 'zoom_changed', this._onIdle);
    window.kakao.maps.event.addListener(map, 'bounds_changed', this._onIdle);
    window.addEventListener('resize', this._onResize);

    this._resize();
  }

  _resize() {
    const rect = this._container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this._canvas.width  = Math.max(1, Math.floor(rect.width  * dpr));
    this._canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this._canvas.style.width  = rect.width  + 'px';
    this._canvas.style.height = rect.height + 'px';
    const ctx = this._canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = rect.width;
    this._h = rect.height;
  }

  setData(pts, opts) {
    this.pts = pts || [];
    this.opts = opts || {};
    this._schedule();
  }

  clear() {
    this.pts = [];
    this.opts = {};
    this._schedule();
  }

  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this._draw();
    });
  }

  _draw() {
    const ctx = this._canvas.getContext('2d');
    ctx.clearRect(0, 0, this._w, this._h);
    if (!this.pts.length || !this.map) return;

    const proj = this.map.getProjection();
    if (!proj) return;

    // containerPointFromCoords 는 viewport pixel (canvas 좌표계와 동일).
    // pan/zoom 오프셋은 kakao 가 자동 처리.
    const toPx = (lat, lng) => {
      const cp = proj.containerPointFromCoords(new window.kakao.maps.LatLng(lat, lng));
      return cp;
    };

    const { color = '#5B7CFF' } = this.opts;

    // 1) polyline
    ctx.strokeStyle = color;
    ctx.lineWidth = strokeWeightForLevel(this.map.getLevel());
    ctx.globalAlpha = 0.8;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < this.pts.length; i++) {
      const p = this.pts[i];
      if (p.lat == null || p.lng == null) continue;
      const cp = toPx(p.lat, p.lng);
      if (!started) { ctx.moveTo(cp.x, cp.y); started = true; }
      else          { ctx.lineTo(cp.x, cp.y); }
    }
    ctx.stroke();

    // 2) all dots (fills the "sampled marker" role — canvas 로 캡 없이 전부 렌더)
    const dotR = Math.max(2, dotSizeForLevel(this.map.getLevel()) / 5);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    for (const p of this.pts) {
      if (p.lat == null || p.lng == null || p._isStop) continue;
      const cp = toPx(p.lat, p.lng);
      ctx.beginPath();
      ctx.arc(cp.x, cp.y, dotR, 0, 2 * Math.PI);
      ctx.fill();
    }

    // 3) stops — 강조 (빨강 큰 원)
    if (this.opts.showStops !== false) {
      ctx.fillStyle = '#EF4444';
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 1;
      for (const p of this.pts) {
        if (!p._isStop || p.lat == null || p.lng == null) continue;
        const cp = toPx(p.lat, p.lng);
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, dotR * 2.2, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
      }
    }

    ctx.globalAlpha = 1;
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    window.kakao.maps.event.removeListener(this.map, 'idle', this._onIdle);
    window.kakao.maps.event.removeListener(this.map, 'zoom_changed', this._onIdle);
    window.kakao.maps.event.removeListener(this.map, 'bounds_changed', this._onIdle);
    window.removeEventListener('resize', this._onResize);
    if (this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
  }
}
// (2026-07-25) timeColor = device 색 유지 + opacity 5단계로 시간 진행 표현 (진할수록 최근).
// 원래는 다른 색 5개 (BUCKET-like) 였으나 여러 device 겹칠 때 identity 상실 → opacity 로 통일.
// 관련: PR #9 (song1074) 원 아이디어, 이후 재구현.
const TIME_SEGMENT_OPACITIES = [0.36, 0.48, 0.60, 0.72, 0.84];
function speedBucket(p) {
  if (p._isStop || p._speed == null || p._speed < 5) return 0;       // 정지/도보 미만
  if (p._speed < 30)  return 1;                                       // 시내 저속
  if (p._speed < 60)  return 2;                                       // 일반 시내
  if (p._speed < 100) return 3;                                       // 고속도로
  return 4;                                                            // 초고속
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

// Seeker 는 대표 인덱스 Set 만 필요. lib/stops 헬퍼 는 { compacted, clusterMap }
// 을 반환하므로 얇게 래핑.
function compactStopMarkerIndexes(pts, indexes, radiusM) {
  return compactStopMarkerIndexesLib(pts, indexes, radiusM).compacted;
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

// 정지 클러스터 대표 marker — 원형 + 개수 텍스트. 화살표(20x20) 보다 살짝 큼(28x28)
// 으로 뭉친 것을 한눈에 구분. cache key: count bucket + color.
const _clusterImageCache = {};
function makeClusterImage(count, color) {
  const bucket = count <= 9 ? String(count) : count <= 99 ? '10+' : '99+';
  const key = `${bucket}_${color}`;
  if (_clusterImageCache[key]) return _clusterImageCache[key];
  const size = 28;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  const cx = size / 2, cy = size / 2, r = 12;
  // 흰 외곽 링 (지도 위 대비)
  ctx.beginPath(); ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.fill();
  // 색상 원
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  // 개수 텍스트
  ctx.font = 'bold 11px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(bucket, cx, cy + 0.5);
  const url = c.toDataURL('image/png');
  _clusterImageCache[key] = new window.kakao.maps.MarkerImage(
    url,
    new window.kakao.maps.Size(size, size),
    { offset: new window.kakao.maps.Point(cx, cy) }
  );
  return _clusterImageCache[key];
}

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
  const lastRecordedAtRef = useRef({});   // deviceId → 직전 좌표 recordedAt (ms epoch). updateMarker 의 polyline gap 계산용
  const lastDotAtRef      = useRef({});   // deviceId → addHistoryPoint 의 dedup 전용. clearHistoryPoints 시 reset
  const pointsRef    = useRef({});   // deviceId → [{ marker, color, isStop }]
  // live history 의 진행 방향 화살표 — 누적 ARROW_INTERVAL_M (200m) 마다 1개.
  // (2026-07-01) dot + arrow 이중 marker 통일 → arrowsRef 삭제. pointsRef 안 marker 가 화살표 겸용.
  // arrowStateRef 는 직전 fix 좌표 (heading 계산용) 만 유지.
  const arrowStateRef  = useRef({});  // deviceId → { lastPos:{lat,lng}, distAcc }
  const fenceRef     = useRef({});   // geofenceId → { circle, name }
  // 현재 단말기 필터 — null = 전체. updateMarker/addHistoryPoint 가 새 마커/폴리라인 생성 시 이걸 참조해
  // 필터에 안 맞는 디바이스 데이터는 map=null 로 숨겨둠 (filterToDevice 가 명시 호출되지 않아도).
  const currentFilterIdRef = useRef(null);
  // (2026-07-27) Seeker 모드 플래그 — true 면 live layer (main pin / arrow dot / cluster / polyline / gap)
  // 전부 map:null. WS/refresh 로 들어오는 새 fix 는 내부 state (markersRef/polyRef/pointsRef) 에만
  // 축적, map 에는 안 그려짐. 시커 종료 시 setSeekerMode(false) 로 필터 규칙에 따라 일괄 복원.
  // 이전엔 setHistoryPointsVisible + setLiveTrailsVisible 로 pointsRef/polyRef 만 감췄고 markersRef
  // (main pin, zIndex 200) 이 그대로 노출 → 초록 pin + 30s refresh 로 오늘 데이터가 시커 위에 얹혀 보임.
  const seekerModeRef = useRef(false);
  // 새 live-layer element 를 map 에 올릴지 판정. seeker 모드거나 device 필터와 불일치 시 map:null.
  const isLiveVisible = (deviceId) => {
    if (seekerModeRef.current) return false;
    const f = currentFilterIdRef.current;
    return f == null || f === deviceId;
  };
  const sharedIwRef  = useRef(null); // single InfoWindow shared by all markers/points
  const onRoadviewRef= useRef(onRoadview);
  const zoomLevelRef = useRef(10);   // 현재 zoom level — 마커/라인 두께 계산용
  const geocoderRef  = useRef(null); // kakao.maps.services.Geocoder (lazy)
  const addrCacheRef = useRef(new Map());   // "lat,lng(5dp)" → {road, building, jibun} | null
  const iwReqIdRef   = useRef(0);    // InfoWindow 비동기 갱신용 시퀀스
  const seekerRef    = useRef({ poly: [], pts: [], cursor: null });   // history seeker 임시 렌더링
  const seekerPinRef = useRef(null);   // 시커 슬롯 선택 표시용 단일 핀 마커
  // (F7-a) Seeker canvas overlay — drawSeekerPathCanvas 사용 시 활성. cursor 는 별도 kakao Marker.
  const canvasSeekerRef = useRef(null);       // SeekerCanvasOverlay | null
  const canvasCursorRef = useRef(null);       // kakao.maps.Marker | null (재생 커서)
  const canvasPtsRef    = useRef([]);         // setCursor(idx) 참조용
  // (F4-a) MarkerClusterer — 수백 대 밀집 시 marker 겹침·클릭 방해 해소.
  // 메인 device pin (updateMarker) 만 cluster. history dot / arrow / cursor / seeker path 는 제외.
  // minLevel 5+ (약 500m~수십km 시야) 에서 활성. 그 아래는 개별 marker.
  // SDK 는 kakaoloader 시점에 clusterer library 이미 로드됨 (script src `libraries=…,clusterer`).
  const clustererRef = useRef(null);

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
        // (F4-a) MarkerClusterer — 활성 조건 (minLevel) 이상에서 자동으로 marker 그룹핑.
        // gridSize 60px, averageCenter (중심점 = 소속 marker 평균 위치), disableClickZoom X
        // (클릭 시 자동 zoom-in). minLevel 5 ≈ 500m 시야 — 그 아래는 개별 marker.
        if (window.kakao.maps.MarkerClusterer) {
          clustererRef.current = new window.kakao.maps.MarkerClusterer({
            map: mapRef.current,
            averageCenter: true,
            minLevel: 5,
            gridSize: 60,
            disableClickZoom: false,
          });
        } else if (typeof console !== 'undefined') {
          console.warn('kakao MarkerClusterer 라이브러리 미로드 — clustering 비활성');
        }
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
        // (F7-a) canvas overlay 인스턴스 — 첫 draw 전까지 idle.
        canvasSeekerRef.current = new SeekerCanvasOverlay(mapRef.current);
        onReady?.();
      });
    };
    ensureKakaoMapSdk()
      .then(() => { if (!cancelled) initMap(); })
      .catch(error => console.error('Kakao Maps SDK load failed', error));
    return () => {
      cancelled = true;
      canvasSeekerRef.current?.destroy();
      canvasSeekerRef.current = null;
    };
  }, []);

  // zoom 변경 시 — 모든 polylines 두께 갱신. (2026-07-01) 화살표 marker 는 zoom 무관 20px 고정.
  function applyZoomStyles() {
    const lvl = zoomLevelRef.current;
    const sw  = strokeWeightForLevel(lvl);
    Object.values(polyRef.current).forEach(entry => {
      entry.segments.forEach(s => s.poly.setOptions({ strokeWeight: sw }));
      entry.gaps.forEach(g => g.setOptions({ strokeWeight: Math.max(1, sw - 1) }));
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
    /** 현재 Kakao map zoom level (1=최대 확대 ~ 14=최대 축소). Dashboard 의 clickable dot 간격 계산용. */
    getZoomLevel() { return zoomLevelRef.current; },

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
    updateMarker(deviceId, lat, lng, label, color, meta = {}, opts = {}) {
      if (!mapRef.current) return;
      // 유효성 방어 — undefined/null/NaN lat|lng 는 kakao.maps.LatLng 을 invalid 로 만들어
      // 후속 setBounds/extend 시 "Cannot read properties of undefined (reading 'x')" 폭포수.
      if (typeof lat !== 'number' || typeof lng !== 'number'
          || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
      // deferPolyline=true 면 coords 만 push 하고 setPath skip — bulk 로드 시 O(N²) 재렌더 회피.
      // 마지막 fix 나 별도 flushLiveTrail(deviceId) 호출로 한 번만 setPath 하면 O(N).
      const deferPoly = opts.deferPolyline === true;
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
        // seeker 모드거나 필터와 불일치면 map:null 로 생성 — state 는 유지, 렌더만 억제.
        // (F4-a) clusterer 사용 시엔 개별 marker 의 map 은 null 두고 clusterer 가 관리.
        //         visible=true 인 marker 만 clusterer 에 추가.
        const visible = isLiveVisible(deviceId);
        const useCluster = !!clustererRef.current;
        const marker = new window.kakao.maps.Marker({
          map: (useCluster || !visible) ? null : mapRef.current,
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
        if (useCluster && visible) clustererRef.current.addMarker(marker);
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
      // (2026-07-03) out-of-order 방어 — newRecordedAt < prevRecordedAt (음수 gap) 인 fix 는
      // polyline 에 이으면 역방향 라인 생김 ("deadline 으로 엮이는" 이슈). Backend 는 오름차순
      // 보내지만 WS 재접속 replay / 병렬 device 큐 순서 flip 등에서 방어. skip 대신 새 segment
      // 시작 (gap 로 표시하지도 않고 조용히 새 시작).
      if (prevRecordedAt && newRecordedAt < prevRecordedAt) {
        return;   // stale fix — polyline 오염 방지
      }
      const isGap = prevRecordedAt && gapS > POLYLINE_GAP_THRESHOLD_S;

      if (!polyRef.current[deviceId]) {
        polyRef.current[deviceId] = { segments: [], gaps: [] };
      }
      const entry = polyRef.current[deviceId];

      if (isGap || entry.segments.length === 0) {
        // gap 발견 → 직전 segment 끝 좌표 ↔ 현재 좌표 잇는 dashed (시각 전용, 클릭 X).
        // 클릭 가능한 정보는 gap 양끝 history point marker 에서 (meta.gapBefore/gapAfter) 처리.
        if (isGap && entry.segments.length > 0) {
          const lastSeg = entry.segments[entry.segments.length - 1];
          const lastPos = lastSeg.coords[lastSeg.coords.length - 1];
          if (lastPos) {
            const dashed = new window.kakao.maps.Polyline({
              map: isLiveVisible(deviceId) ? mapRef.current : null,
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
        const poly = new window.kakao.maps.Polyline({
          map: isLiveVisible(deviceId) ? mapRef.current : null,
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
        const lastPos = lastSeg.coords[lastSeg.coords.length - 1];
        const movedFromLastTrail = !lastPos || distanceM(
          { lat: lastPos.getLat(), lng: lastPos.getLng() },
          { lat, lng },
        ) >= MIN_TRAIL_POINT_DISTANCE_M;
        if (movedFromLastTrail) lastSeg.coords.push(pos);
        if (!deferPoly) {
          if (movedFromLastTrail) lastSeg.poly.setPath(lastSeg.coords);
          lastSeg.poly.setOptions({ strokeColor: stroke, strokeOpacity: opacity, strokeWeight: sw });
        }
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
      // 유효성 방어 — invalid lat/lng 면 kakao LatLng 이 손상돼 이후 bounds/polyline 캐스케이드 폭발.
      if (typeof lat !== 'number' || typeof lng !== 'number'
          || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
      // P1 dedup (PR #68): initial fetch + WS broadcast 가 같은 fix 두 번 추가하던 케이스 방지.
      // (2026-06-30) dedup ref 를 lastDotAtRef 로 분리 — lastRecordedAtRef 는 updateMarker 의 polyline
      // gap 계산용이라 reset 하면 polyline 망가짐. addHistoryPoint 만의 dedup 으로 격리.
      if (meta.recordedAt) {
        const newAt = new Date(meta.recordedAt).getTime();
        const lastAt = lastDotAtRef.current[deviceId];
        if (lastAt && newAt <= lastAt) return;
        lastDotAtRef.current[deviceId] = newAt;
      }
      const pos = new window.kakao.maps.LatLng(lat, lng);
      const isStop = !!meta.isStop;
      const c = color || '#888';
      if (!meta.skipMarker) {
        // (2026-07-01) dot + arrow 이중 marker 통일 — 화살표 marker 하나로 (clickable + tooltip).
        // 첫 fix 는 heading 미확정 → angle=0 (북쪽 화살표). polyline 시작점 인식.
        // 정지 클러스터 대표 (clusterCount>1) 는 원형 + 개수 이미지로 교체.
        const isCluster = meta.clusterCount > 1;
        const st = arrowStateRef.current[deviceId];
        const angle = st ? calcBearing(st.lastPos.lat, st.lastPos.lng, lat, lng) : 0;
        const marker = new window.kakao.maps.Marker({
          map: isLiveVisible(deviceId) ? mapRef.current : null,
          position: pos,
          image: isCluster ? makeClusterImage(meta.clusterCount, c) : makeArrowImage(angle, c),
          clickable: true,
          zIndex: isCluster ? 6 : (meta.isGapEndpoint ? 7 : 5),
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
        const arr = pointsRef.current[deviceId];
        // (2026-07-03) FIFO cap — MAX_HISTORY_POINTS 초과 시 오래된 marker 삭제. 이전엔 선언만
        // 있고 실제 로직 없어 무한 축적 → 시간 지날수록 zoom refresh 느려짐 (실사용 피드백).
        while (arr.length >= MAX_HISTORY_POINTS) {
          const old = arr.shift();
          if (old?.marker) old.marker.setMap(null);
        }
        arr.push({ marker, color: c, isStop, angle });
        arrowStateRef.current[deviceId] = { lastPos: { lat, lng } };
      }
    },

    /** 디바이스의 history 화살표 marker + heading 누적 상태 모두 제거 (loadDevices 직전 호출용). */
    clearHistoryPoints(deviceId) {
      const arr = pointsRef.current[deviceId];
      if (arr) {
        arr.forEach(({ marker }) => marker.setMap(null));
        delete pointsRef.current[deviceId];
      }
      delete arrowStateRef.current[deviceId];
      // (2026-06-30) addHistoryPoint 의 dedup ref 만 reset — polyRef + lastRecordedAtRef 는
      // updateMarker 의 polyline gap 계산에 필요하므로 안 건드림.
      delete lastDotAtRef.current[deviceId];
    },

    // updateMarker(..., { deferPolyline:true }) 로 누적한 coords 를 한 번에 setPath.
    // 대량 fix (initial load 2000+) 시 O(N²) → O(N). 마지막 fix 후 반드시 호출.
    // gap 로 나뉜 여러 segment 를 모두 flush — 이전엔 마지막 segment 만 setPath 해서
    // 이전 사이클의 polyline 이 미렌더되던 회귀 (dot 만 남고 실선 사라짐) 방어.
    flushLiveTrail(deviceId) {
      const entry = polyRef.current[deviceId];
      if (!entry) return;
      entry.segments.forEach(seg => seg.poly.setPath(seg.coords));
    },

    // (2026-07-01) refresh(force=true) 용 — polyline + lastRecordedAtRef 완전 reset.
    // updateMarker 는 시간 오름차순 append 만 처리 → refresh 시 최신 상태의 polyline 에
    // 오래된 fix 들 append 되면 역방향 라인 그려짐. force refresh 전 이 함수로 클린 시작.
    clearLiveTrail(deviceId) {
      const entry = polyRef.current[deviceId];
      if (entry) {
        entry.segments.forEach(s => s.poly.setMap(null));
        entry.gaps.forEach(g => g.setMap(null));
        delete polyRef.current[deviceId];
      }
      delete lastRecordedAtRef.current[deviceId];
    },

    /**
     * (2026-07-27) Seeker 모드 진입/종료 — live layer 전체 (main pin + arrow/cluster dot +
     * solid polyline + dashed gap) visibility 를 원자적으로 토글.
     *
     * 이전엔 setHistoryPointsVisible + setLiveTrailsVisible 두 개로 pointsRef/polyRef 만 감췄으나
     * markersRef (main pin, zIndex 200) 가 그대로 노출되어 시커 위에 오늘의 라이브 pin (device color,
     * 초록 device 면 초록) 이 계속 떠 있었음. 30s force refresh + WS 이벤트도 seeker 상태 무시하고
     * updateMarker/addHistoryPoint 로 pin/dot/polyline 을 재생성 → 다른 날짜 fix 가 시커 path 위에
     * 계속 얹혀 보이는 회귀.
     *
     * 새 계약:
     *   1. active=true: 모든 live element setMap(null). isLiveVisible 은 false 반환 →
     *      새로 생성되는 element 도 map:null (WS/refresh 계속 돌아도 state 만 축적, 렌더 X).
     *   2. active=false: 필터 규칙 (currentFilterIdRef) 에 따라 visibility 복원. 그동안 축적된
     *      state 도 즉시 반영 (재조회 필요 없음).
     *
     * Dashboard 는 showSeeker || showMiniSeeker 변화에 이 API 하나만 호출.
     */
    setSeekerMode(active) {
      if (!mapRef.current) return;
      seekerModeRef.current = !!active;
      const useCluster = !!clustererRef.current;
      const applyMain = (deviceId) => {
        const f = currentFilterIdRef.current;
        return !seekerModeRef.current && (f == null || +f === +deviceId) ? mapRef.current : null;
      };
      // (F4-a) clusterer 사용 시 main pin 은 clusterer 가 관리 — direct setMap 대신
      //         addMarker/removeMarker 로 토글. visible=null 이면 remove, else add.
      Object.entries(markersRef.current).forEach(([id, { marker }]) => {
        const visible = applyMain(id) != null;
        if (useCluster) {
          if (visible) clustererRef.current.addMarker(marker);
          else         clustererRef.current.removeMarker(marker);
          marker.setMap(null);  // clusterer 가 알아서 그림
        } else {
          marker.setMap(visible ? mapRef.current : null);
        }
      });
      Object.entries(pointsRef.current).forEach(([id, arr]) => {
        const m = applyMain(id);
        arr.forEach(({ marker }) => marker.setMap(m));
      });
      Object.entries(polyRef.current).forEach(([id, entry]) => {
        const m = applyMain(id);
        entry.segments.forEach(s => s.poly.setMap(m));
        entry.gaps.forEach(g => g.setMap(m));
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
      // (2026-07-01) 화살표 marker — angle 유지 + device color 로 새 화살표 이미지.
      const arr = pointsRef.current[deviceId];
      if (arr) {
        arr.forEach(o => {
          o.color = color;
          o.marker.setImage(makeArrowImage(o.angle, color));
        });
      }
    },

    focusDevice(deviceId, opts = {}) {
      const entry = markersRef.current[deviceId];
      if (!entry || !mapRef.current) return false;
      markProgrammatic();
      mapRef.current.setCenter(entry.marker.getPosition());
      if (Number.isFinite(opts.level)) mapRef.current.setLevel(opts.level);
      return true;
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
      // (2026-07-27) seeker 모드 중 필터 변경은 상태만 갱신 — 시커 종료 시 setSeekerMode(false) 가
      // 필터 규칙대로 재복원. 여기서 setMap 하면 seeker path 위에 live 가 튀어나옴.
      if (seekerModeRef.current) {
        sharedIwRef.current?.close();
        return;
      }
      const all = mapRef.current;
      // (F4-a) clusterer 있으면 addMarker/removeMarker 로 필터, marker.setMap 은 null.
      const useCluster = !!clustererRef.current;
      Object.entries(markersRef.current).forEach(([id, { marker }]) => {
        const visible = (targetId === null || +id === targetId);
        if (useCluster) {
          if (visible) clustererRef.current.addMarker(marker);
          else         clustererRef.current.removeMarker(marker);
          marker.setMap(null);
        } else {
          marker.setMap(visible ? all : null);
        }
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
      const {
        color = '#5B7CFF', speedColor = false, timeColor = false, showStops = true,
        showCursor = false, onPointClick = null,
        maxMarkers = 300,        // 마커 폭주 방지 — 폴리라인은 그대로, 마커만 캡
        stopMergeRadiusM = 35,   // nearby stop markers are absorbed into one representative marker
        minBucketRun = 3,        // 노이즈 단일 버킷 전환 무시 (>=3 점 연속이어야 새 segment)
        timeSegments = 5,       // 하루 왕복 경로가 겹칠 때 시간대별 선 색상 분리
        // (F0-1) 옵션 토글 (색상·정지 강조 등) 시 사용자가 잡아둔 zoom/pan 을
        // 파괴하지 않도록 fingerprint 기반으로 refit 를 skip. 강제 refit 는 refit=true.
        refit,                   // undefined = auto, true = force, false = never
      } = opts;
      // fingerprint: 첫/마지막 timestamp + 개수. 좌표 집합이 실제로 변했는지 판단.
      const fp = points.length === 0 ? '' :
        `${points.length}|${points[0]?.recorded_at || ''}|${points[points.length-1]?.recorded_at || ''}`;
      // (F3-a-3) 옵션 signature — 색상/토글이 이전과 완전 동일하면 rebuild 자체 skip.
      // 이전엔 옵션 변화 없어도 clearSeekerPath + 전체 재생성이 항상 일어났음.
      const optsSig = `${color}|${speedColor}|${timeColor}|${showStops}|${showCursor}|${maxMarkers}|${stopMergeRadiusM}|${minBucketRun}|${timeSegments}`;
      if (refit !== true && seekerRef.current._fp === fp && seekerRef.current._optsSig === optsSig && seekerRef.current.poly.length > 0) {
        // 완전 동일 — 기존 marker/poly 재사용, cursor helper 만 반환.
        const cachedPts = seekerRef.current._pts || [];
        return {
          setCursor(idx) {
            const c = seekerRef.current.cursor;
            const p = cachedPts[idx];
            if (!c || !p) return;
            c.setPosition(new window.kakao.maps.LatLng(p.lat, p.lng));
          },
        };
      }
      const shouldRefit = refit === true
        || (refit !== false && seekerRef.current._fp !== fp);
      this.clearSeekerPath();
      seekerRef.current._fp = fp;
      seekerRef.current._optsSig = optsSig;

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
        const segmentCount = Math.max(2, Math.min(timeSegments, TIME_SEGMENT_OPACITIES.length, pts.length - 1));
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
              strokeColor: color,   // device color 유지
              strokeOpacity: TIME_SEGMENT_OPACITIES[seg] ?? 0.68,
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
        // timeColor 는 opacity 방식이라 dot 색상은 device color 유지 (dot 자체 opacity 는
        // dotImage 안에서 조정되지 않아 색 구분은 폴리라인에만 나타남 — 충분한 UX).
        const dotColor = isStop
          ? '#EF4444'
          : speedColor
            ? (BUCKET_COLORS[speedBucket(p)] || color)
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

      // (F0-1) bounds fit — 좌표 집합이 실제로 변한 경우에만.
      // 옵션 토글 (색상·정지 강조 등) 로 인한 재렌더 시엔 사용자가 잡아둔 zoom/pan 보존.
      if (shouldRefit) {
        if (pts.length > 1) {
          const bounds = new window.kakao.maps.LatLngBounds();
          pts.forEach(p => bounds.extend(new window.kakao.maps.LatLng(p.lat, p.lng)));
          mapRef.current.setBounds(bounds, 60, 60, 60, 60);
        } else {
          mapRef.current.setCenter(new window.kakao.maps.LatLng(pts[0].lat, pts[0].lng));
        }
      }

      // (F3-a-3) 다음 호출에서 fp/opts 동일 시 skip path 가 쓸 수 있도록 pts 캐시.
      seekerRef.current._pts = pts;

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
      // (F0-1) _fp 는 drawSeekerPath 가 새로 설정하기 전 clear 되면 refit 판단 잃음.
      // fingerprint 는 clear 후에도 유지 (draw 가 곧 덮어씀).
      const prevFp = seekerRef.current._fp;
      seekerRef.current = { poly: [], pts: [], cursor: null, _fp: prevFp };
      // 시커 닫힐 때 선택 핀도 같이 정리.
      seekerPinRef.current?.setMap(null);
      seekerPinRef.current = null;
    },

    /**
     * (F7-a) Canvas overlay 기반 seeker path.
     * drawSeekerPath 의 marker-per-point 를 canvas 로 대체 — 장거리 trip 렌더 부담 감소.
     * opts: { color, showStops, showCursor, refit }
     * 반환: { setCursor(idx) } — panTo 와 유사 UX 로 cursor 이동.
     */
    drawSeekerPathCanvas(points, opts = {}) {
      if (!mapRef.current || !canvasSeekerRef.current) return null;
      const { color = '#5B7CFF', showStops = true, showCursor = false, refit = true } = opts;

      const pts = (points || [])
        .filter(p => p.lat != null && p.lng != null)
        .slice()
        .sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));

      canvasPtsRef.current = pts;
      canvasSeekerRef.current.setData(pts, { color, showStops });

      // cursor 는 마커 유지 (재생 시 setPosition 만 하면 되므로 저렴)
      if (canvasCursorRef.current) {
        canvasCursorRef.current.setMap(null);
        canvasCursorRef.current = null;
      }
      if (showCursor && pts[0]) {
        canvasCursorRef.current = new window.kakao.maps.Marker({
          map: mapRef.current,
          position: new window.kakao.maps.LatLng(pts[0].lat, pts[0].lng),
          image: cursorImage(color),
          zIndex: 99,
        });
      }

      if (refit && pts.length > 0) {
        if (pts.length > 1) {
          const bounds = new window.kakao.maps.LatLngBounds();
          pts.forEach(p => bounds.extend(new window.kakao.maps.LatLng(p.lat, p.lng)));
          markProgrammatic();
          mapRef.current.setBounds(bounds, 60, 60, 60, 60);
        } else {
          markProgrammatic();
          mapRef.current.setCenter(new window.kakao.maps.LatLng(pts[0].lat, pts[0].lng));
        }
      }

      return {
        setCursor(idx) {
          const p = canvasPtsRef.current[idx];
          if (!canvasCursorRef.current || !p) return;
          canvasCursorRef.current.setPosition(new window.kakao.maps.LatLng(p.lat, p.lng));
        },
      };
    },

    clearSeekerPathCanvas() {
      canvasSeekerRef.current?.clear();
      canvasCursorRef.current?.setMap(null);
      canvasCursorRef.current = null;
      canvasPtsRef.current = [];
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

    // (F4-c) waypoint 클릭 · 외부 요청으로 지도 pan. seeker cursor 도 함께 이동
    //         (drawSeekerPath 로 이전에 생성된 cursor 가 있으면).
    panTo(lat, lng, opts = {}) {
      if (!mapRef.current || !window.kakao?.maps) return;
      const pos = new window.kakao.maps.LatLng(lat, lng);
      markProgrammatic();
      if (opts.instant) mapRef.current.setCenter(pos);
      else              mapRef.current.panTo(pos);
      // seeker cursor 있으면 함께 이동 — 시각적 tracking.
      if (seekerRef.current.cursor) {
        seekerRef.current.cursor.setPosition(pos);
      }
      // (F7-a) canvas seeker cursor 도 동일 처리.
      if (canvasCursorRef.current) {
        canvasCursorRef.current.setPosition(pos);
      }
    },

    removeMarker(deviceId) {
      const entry = markersRef.current[deviceId];
      if (entry) {
        // (F4-a) clusterer 에서 먼저 빼고 map:null (순서 반대면 clusterer 가 dead marker 참조).
        if (clustererRef.current) clustererRef.current.removeMarker(entry.marker);
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
  // vbat_mv (ESP ADC, 배터리 실측 근접) + cbc_mv (모듈 AT+CBC, 배선 loss 뒤). cbc 는 있을 때만 부기.
  const vbat   = m.vbatMv ? (m.cbcMv ? `${m.vbatMv} mV (모듈 ${m.cbcMv})` : `${m.vbatMv} mV`) : '—';
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

// "HH:MM" — KST 로컬 시각 (뭉친 dot tooltip 요약용)
function fmtHm(iso) {
  return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
}
// "N분간 정지" 요약 문구 (분 단위 반올림, 60분+ 는 시간 표기).
function fmtDurationKo(startIso, endIso) {
  const s = (new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000;
  if (s < 60) return `${Math.max(1, Math.round(s))}초간 정지`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}분간 정지`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm > 0 ? `${h}시간 ${rm}분간 정지` : `${h}시간 정지`;
}

function buildPointInfoHTML(m, color, addr, lat, lng) {
  const ageTxt = m.recordedAt ? new Date(m.recordedAt).toLocaleString('ko-KR') : '—';
  const sat    = m.sat ?? '—';
  // vbat_mv (ESP ADC, 배터리 실측 근접) + cbc_mv (모듈 AT+CBC, 배선 loss 뒤). cbc 는 있을 때만 부기.
  const vbat   = m.vbatMv ? (m.cbcMv ? `${m.vbatMv} mV (모듈 ${m.cbcMv})` : `${m.vbatMv} mV`) : '—';
  const speed  = m.speedKmh != null ? ROW(SVG_RUN, `${m.speedKmh.toFixed(1)} km/h`) : '';
  const stopBadge = m.isStop
    ? `<span style="display:inline-block;background:#1a1a2e;color:#fbbf24;padding:1px 7px;border-radius:8px;font-size:10px;font-weight:600;margin-left:6px;letter-spacing:.04em">정지</span>`
    : '';
  // 정지 클러스터 요약 — clusterCount>1 이면 개별 시각 대신 range + duration 표시.
  const isCluster = m.clusterCount > 1;
  const clusterBlock = isCluster
    ? `<div style="background:#f6f7fa;border:1px solid #e5e7eb;border-radius:6px;padding:6px 10px;margin:6px 0 10px;font-size:11px;line-height:1.5;color:#1a1a2e">
         <div style="font-weight:600;margin-bottom:2px">${fmtHm(m.clusterStartAt)} ~ ${fmtHm(m.clusterEndAt)}</div>
         <div style="color:#666">${fmtDurationKo(m.clusterStartAt, m.clusterEndAt)} · ${m.clusterCount}개 fix 합침</div>
       </div>`
    : '';
  // gap 정보 — 이 점이 통신 두절 구간의 시작점 또는 끝점인 경우 표시 + 복사 버튼.
  const gapBlock = (m.gapBefore || m.gapAfter)
    ? buildGapInPointBlock(m, lat, lng)
    : '';
  return `
    <div style="padding:12px 14px;font-size:12px;font-family:-apple-system,system-ui,sans-serif;min-width:240px;line-height:1.55;color:#1a1a2e">
      <div style="font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:6px">
        <span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:${color || '#888'}"></span>
        ${isCluster ? '정지 구간' : '기록 지점'}${stopBadge}
      </div>
      ${ROW(SVG_PIN, addrLine(addr))}
      ${clusterBlock}
      ${ROW(SVG_SAT, `sat ${sat} · ${vbat}`)}
      ${speed}
      <div style="color:#888;font-size:11px;margin:4px 0 10px">${isCluster ? '중앙 fix: ' : ''}${ageTxt}</div>
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
