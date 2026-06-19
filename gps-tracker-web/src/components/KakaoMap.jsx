import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { haversineM } from '../lib/stops';

const DEFAULT_CENTER = { lat: 37.5665, lng: 126.978 };
const MAX_HISTORY_POINTS = 500;

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
const BUCKET_COLORS = ['#EF4444', '#F59E0B', '#10B981', '#3B82F6', '#8B5CF6'];
function speedBucket(p) {
  if (p._isStop || p._speed == null || p._speed < 5) return 0;       // 정지/도보 미만
  if (p._speed < 30)  return 1;                                       // 시내 저속
  if (p._speed < 60)  return 2;                                       // 일반 시내
  if (p._speed < 100) return 3;                                       // 고속도로
  return 4;                                                            // 초고속
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
function dotImageCached(color, isStop, size) {
  const key = `${color}|${isStop ? 1 : 0}|${size}`;
  let img = dotImageCache.get(key);
  if (img) return img;
  const half = size / 2;
  const r    = Math.max(3, half - 2);
  const svg = isStop
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
        <rect x="2" y="2" width="${size-4}" height="${size-4}" rx="2" fill="${color}" stroke="white" stroke-width="1.5"/>
        <circle cx="${half}" cy="${half}" r="${Math.max(2, r/3)}" fill="white"/>
      </svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
        <circle cx="${half}" cy="${half}" r="${r}" fill="${color}" stroke="white" stroke-width="1.5"/>
      </svg>`;
  const url = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  img = new window.kakao.maps.MarkerImage(
    url, new window.kakao.maps.Size(size, size),
    { offset: new window.kakao.maps.Point(half, half) },
  );
  dotImageCache.set(key, img);
  return img;
}

const KakaoMap = forwardRef(function KakaoMap({ onReady, onRoadview, onPointInfo, onUserPan }, ref) {
  // onPointInfo 가 제공되면 마커 클릭 시 kakao InfoWindow 대신 그 콜백을 호출.
  // 부모(Dashboard) 가 React 기반 bottom-sheet 으로 표시 (모바일 친화적).
  // 콜백 시그니처: ({ kind: 'main'|'point', label, color, meta, addr, lat, lng }) => void
  // — addr 가 null 인 첫 호출 후 비동기 resolve 되면 동일 시그니처로 한 번 더 호출.
  const onPointInfoRef = useRef(onPointInfo);
  // onUserPan: 사용자가 직접 지도를 드래그(또는 더블탭/핀치)했을 때 호출.
  // 라이브 추적 토글을 끄는 데 사용. panTo (프로그램적) 는 dragend 안 발생시키므로 안전.
  const onUserPanRef = useRef(onUserPan);
  const containerRef = useRef(null);
  const mapRef       = useRef(null);
  const markersRef   = useRef({});   // deviceId → { marker, color, meta }
  const polyRef      = useRef({});   // deviceId → Polyline
  const coordsRef    = useRef({});   // deviceId → LatLng[]
  const pointsRef    = useRef({});   // deviceId → [{ marker, color, isStop }]
  const arrowsRef    = useRef({});   // deviceId → [marker] 방향 화살표
  const arrowStateRef= useRef({});   // deviceId → { lastPos:{lat,lng}, distAcc:number }
  const fenceRef     = useRef({});   // geofenceId → { circle, name }
  const sharedIwRef  = useRef(null); // single InfoWindow shared by all markers/points
  const onRoadviewRef= useRef(onRoadview);
  const zoomLevelRef = useRef(10);   // 현재 zoom level — 마커/라인 두께 계산용
  const geocoderRef  = useRef(null); // kakao.maps.services.Geocoder (lazy)
  const addrCacheRef = useRef(new Map());   // "lat,lng(5dp)" → {road, building, jibun} | null
  const iwReqIdRef   = useRef(0);    // InfoWindow 비동기 갱신용 시퀀스
  const seekerRef    = useRef({ poly: [], pts: [], cursor: null });   // history seeker 임시 렌더링
  const seekerPinRef = useRef(null);   // 시커 슬롯 선택 표시용 단일 핀 마커
  const routePlanRef = useRef({ markers: [], polys: [] }); // 경로 계획 마커 + 폴리라인

  useEffect(() => { onRoadviewRef.current = onRoadview; }, [onRoadview]);
  useEffect(() => { onPointInfoRef.current = onPointInfo; }, [onPointInfo]);
  useEffect(() => { onUserPanRef.current = onUserPan; }, [onUserPan]);

  // 글로벌 콜백 — InfoWindow 안의 onclick에서 호출.
  useEffect(() => {
    window.__btw_openRoadview = (lat, lng) => onRoadviewRef.current?.({ lat, lng });
    return () => { delete window.__btw_openRoadview; };
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
          if (lvl === zoomLevelRef.current) return;
          zoomLevelRef.current = lvl;
          applyZoomStyles();
        });
        // 사용자 직접 드래그/줌 → 라이브 추적 종료 신호.
        // zoom_changed 는 프로그램적 줌(zoomToCoord) 도 발생하므로 플래그로 구분.
        let programmaticZoom = false;
        window.kakao.maps.event.addListener(mapRef.current, 'dragend', () => {
          onUserPanRef.current?.();
        });
        window.kakao.maps.event.addListener(mapRef.current, 'zoom_changed', () => {
          if (programmaticZoom) { programmaticZoom = false; return; }
          onUserPanRef.current?.();
        });
        // zoomToCoord 에서 호출 전에 플래그 세트할 수 있도록 외부에 노출.
        mapRef.current.__setProgrammaticZoom = () => { programmaticZoom = true; };
        onReady?.();
      });
    };
    const wait = setInterval(() => {
      if (window.kakao?.maps) { clearInterval(wait); initMap(); }
    }, 100);
    return () => { cancelled = true; clearInterval(wait); };
  }, []);

  // zoom 변경 시 — 모든 polylines + dot markers 일괄 갱신.
  function applyZoomStyles() {
    const lvl = zoomLevelRef.current;
    const sw  = strokeWeightForLevel(lvl);
    const sz  = dotSizeForLevel(lvl);
    Object.values(polyRef.current).forEach(p => p.setOptions({ strokeWeight: sw }));
    Object.values(pointsRef.current).forEach(arr => {
      arr.forEach(({ marker, color, isStop }) => {
        const dotColor = isStop ? '#EF4444' : (color || '#888');
        marker.setImage(dotImageCached(dotColor, isStop, sz));
      });
    });
  }

  function makeDotImage(color, isStop = false) {
    return dotImageCached(color || '#888', isStop, dotSizeForLevel(zoomLevelRef.current));
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
        // 색 바뀐 경우 핀 이미지도 갱신.
        if (e.color !== color) e.marker.setImage(pinImage(color || '#5B7CFF'));
        e.color = color;
        e.meta = meta;
        e.label = label;
      } else {
        const marker = new window.kakao.maps.Marker({
          map: mapRef.current,
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

      // append trail coords
      if (!coordsRef.current[deviceId]) coordsRef.current[deviceId] = [];
      coordsRef.current[deviceId].push(pos);
      if (coordsRef.current[deviceId].length > MAX_HISTORY_POINTS) coordsRef.current[deviceId].shift();

      const stroke = color || '#888';
      const opacity = meta.stale ? 0.35 : 0.85;
      const sw = strokeWeightForLevel(zoomLevelRef.current);
      if (polyRef.current[deviceId]) {
        polyRef.current[deviceId].setPath(coordsRef.current[deviceId]);
        polyRef.current[deviceId].setOptions({ strokeColor: stroke, strokeOpacity: opacity, strokeWeight: sw });
      } else {
        polyRef.current[deviceId] = new window.kakao.maps.Polyline({
          map: mapRef.current,
          path: coordsRef.current[deviceId],
          strokeWeight: sw,
          strokeColor: stroke,
          strokeOpacity: opacity,
          strokeStyle: 'solid',
        });
      }
    },

    /**
     * 궤적 위의 개별 fix 점에 작은 클릭가능한 마커를 추가.
     * meta: { recordedAt, sat, vbatMv, fix }
     */
    addHistoryPoint(deviceId, lat, lng, color, meta = {}) {
      if (!mapRef.current) return;
      const pos = new window.kakao.maps.LatLng(lat, lng);
      const isStop = !!meta.isStop;
      const c = color || '#888';
      // cluster (5+ 점 좁은 범위 뭉침) 은 디바이스 색 무시하고 강제 빨강 — 시각적 경고.
      const dotColor = isStop ? '#EF4444' : c;
      const marker = new window.kakao.maps.Marker({
        map: mapRef.current,
        position: pos,
        image: makeDotImage(dotColor, isStop),
        clickable: true,
        zIndex: isStop ? 2 : 1,
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
      pointsRef.current[deviceId].push({ marker, color: c, isStop, recordedAt: meta.recordedAt });

      // 방향 화살표 — 200m 마다 1개
      {
        const ARROW_INTERVAL_M = 200;
        const st = arrowStateRef.current[deviceId];
        if (st) {
          const dist = haversineM(st.lastPos.lat, st.lastPos.lng, lat, lng);
          st.distAcc += dist;
          if (st.distAcc >= ARROW_INTERVAL_M) {
            st.distAcc = 0;
            const toRad = d => d * Math.PI / 180;
            const dLng = toRad(lng - st.lastPos.lng);
            const φ1 = toRad(st.lastPos.lat), φ2 = toRad(lat);
            const y = Math.sin(dLng) * Math.cos(φ2);
            const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLng);
            const angle = Math.round(((Math.atan2(y, x) * 180 / Math.PI + 360) % 360) / 5) * 5;
            const cv = document.createElement('canvas');
            cv.width = 20; cv.height = 20;
            const ctx2 = cv.getContext('2d');
            ctx2.save();
            ctx2.translate(10, 10);
            ctx2.rotate(angle * Math.PI / 180);
            ctx2.translate(-10, -10);
            ctx2.beginPath();
            ctx2.moveTo(10, 2); ctx2.lineTo(16, 18); ctx2.lineTo(10, 13); ctx2.lineTo(4, 18);
            ctx2.closePath();
            ctx2.fillStyle = c; ctx2.fill();
            ctx2.strokeStyle = 'rgba(255,255,255,0.9)'; ctx2.lineWidth = 1.5; ctx2.lineJoin = 'round'; ctx2.stroke();
            ctx2.restore();
            const imgUrl = cv.toDataURL('image/png');
            const am = new window.kakao.maps.Marker({
              map: mapRef.current,
              position: pos,
              image: new window.kakao.maps.MarkerImage(imgUrl, new window.kakao.maps.Size(20, 20), { offset: new window.kakao.maps.Point(10, 10) }),
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
      }
    },

    /** 디바이스의 history 점들을 모두 제거 (loadDevices 직전 호출용). */
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

    setMarkerColor(deviceId, color) {
      const entry = markersRef.current[deviceId];
      if (entry) entry.color = color;
      const poly = polyRef.current[deviceId];
      if (poly) poly.setOptions({ strokeColor: color });
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
      mapRef.current.setBounds(bounds, padding, padding, padding, padding);
    },

    /** 특정 디바이스만 보이게 / null이면 전체 보이기. */
    filterToDevice(targetId) {
      const all = mapRef.current;
      Object.entries(markersRef.current).forEach(([id, { marker }]) => {
        marker.setMap((targetId === null || +id === targetId) ? all : null);
      });
      Object.entries(polyRef.current).forEach(([id, poly]) => {
        poly.setMap((targetId === null || +id === targetId) ? all : null);
      });
      Object.entries(pointsRef.current).forEach(([id, arr]) => {
        const vis = (targetId === null || +id === targetId);
        arr.forEach(({ marker }) => marker.setMap(vis ? all : null));
      });

      // bounds 재조정
      sharedIwRef.current?.close();
      if (targetId !== null) {
        const pts  = pointsRef.current[targetId] || [];
        const main = markersRef.current[targetId];
        const bounds = new window.kakao.maps.LatLngBounds();

        // 가장 최근 날짜(KST 기준)의 점만 포함
        const KST = 9 * 3600 * 1000;
        const mainDate = main?.meta?.recordedAt
          ? new Date(new Date(main.meta.recordedAt).getTime() + KST).toISOString().slice(0, 10)
          : null;

        const filtered = mainDate
          ? pts.filter(p => {
              if (!p.recordedAt) return false;
              return new Date(new Date(p.recordedAt).getTime() + KST).toISOString().slice(0, 10) === mainDate;
            })
          : pts;

        const safePoints = filtered.length > 0 ? filtered : pts;
        safePoints.forEach(({ marker }) => bounds.extend(marker.getPosition()));
        if (main) bounds.extend(main.marker.getPosition());
         if (!bounds.isEmpty()) {
          mapRef.current?.setBounds(bounds, 60, 60, 60, 60);
          const MIN_LEVEL = 7;
          const curLevel = mapRef.current.getLevel();
          if (curLevel < MIN_LEVEL) mapRef.current.setLevel(MIN_LEVEL);
        }
      } else {
        const bounds = new window.kakao.maps.LatLngBounds();
        Object.values(markersRef.current).forEach(({ marker }) => bounds.extend(marker.getPosition()));
        if (!bounds.isEmpty()) mapRef.current?.setBounds(bounds, 60, 60, 60, 60);
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
    /** 좌표로 이동 + 줌 레벨 지정 (라이브 추적 ON 시 사용). */
    zoomToCoord(lat, lng, level) {
      if (!mapRef.current) return;
      mapRef.current.__setProgrammaticZoom?.();
      mapRef.current.setCenter(new window.kakao.maps.LatLng(lat, lng));
      mapRef.current.setLevel(level);
    },

    /**
     * Seeker 전용 history path 그리기.
     * points: [{ lat, lng, recorded_at, _speed?, _isStop? }] (시간 오름차순)
     * opts: { color, speedColor, showStops, showCursor, onPointClick(point, idx) }
     * 반환: 동일 시그니처로 cursor 위치만 업데이트할 수 있는 헬퍼들 (setCursor, fitBounds).
     */
    drawSeekerPath(points, opts = {}) {
      if (!mapRef.current) return null;
      this.clearSeekerPath();
      const {
        color = '#5B7CFF', speedColor = false, showStops = true,
        showCursor = false, onPointClick = null,
        maxMarkers = 300,        // 마커 폭주 방지 — 폴리라인은 그대로, 마커만 캡
        minBucketRun = 3,        // 노이즈 단일 버킷 전환 무시 (>=3 점 연속이어야 새 segment)
        speedLimit = null,       // km/h — 초과 구간 빨강 오버레이. null = 비활성
        showSatWarning = false,  // sat<4 구간 노란 점선 오버레이
      } = opts;

      const pts = points.filter(p => p.lat != null && p.lng != null);
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
      } else {
        // 시간 간격 30분 이상이면 새 trip segment — 왕복 구간 시각 분리.
        const TRIP_GAP_MS = 30 * 60 * 1000;
        const trips = [];
        let cur = [pts[0]];
        for (let i = 1; i < pts.length; i++) {
          const gap = new Date(pts[i].recorded_at) - new Date(pts[i - 1].recorded_at);
          if (gap > TRIP_GAP_MS) {
            trips.push(cur);
            cur = [];
          }
          cur.push(pts[i]);
        }
        trips.push(cur);

        trips.forEach((trip, ti) => {
          if (trip.length < 2) return;
          const path = trip.map(p => new window.kakao.maps.LatLng(p.lat, p.lng));
          // 짝수 trip: solid 진함 / 홀수 trip: dashed + 반투명 (왕복 귀로)
          const isReturn = ti % 2 === 1;
          const poly = new window.kakao.maps.Polyline({
            map: mapRef.current, path,
            strokeWeight: isReturn ? Math.max(2, sw - 1) : sw,
            strokeColor: color,
            strokeOpacity: isReturn ? 0.4 : 0.85,
            strokeStyle: isReturn ? 'shortdot' : 'solid',
          });
          seekerRef.current.poly.push(poly);
        });
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

      // 인접 기반 중복 마커 제거 — stop 이 아닌 일반 점은 이미 그린 점 15m 이내면 생략.
      const DEDUP_M = 15;
      const renderedPositions = [];

      renderIdxSet.forEach(idx => {
        const p = pts[idx];
        if (!p) return;
        const isStop = !!p._isStop && showStops;

        // 중복 마커 제거: stop 이 아닌 점이 이미 렌더된 점 15m 이내이면 건너뜀.
        if (!isStop) {
          const tooClose = renderedPositions.some(r =>
            haversineM(p.lat, p.lng, r.lat, r.lng) <= DEDUP_M
          );
          if (tooClose) return;
        }
        renderedPositions.push({ lat: p.lat, lng: p.lng });

        const dotColor = isStop
          ? '#EF4444'
          : (speedColor ? (BUCKET_COLORS[speedBucket(p)] || color) : color);
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

      // ── 방향 화살표 마커 ─────────────────────────────────────────
      // 누적 거리 기준 ARROW_INTERVAL_M 마다 진행 방향 화살표 1개.
      // Canvas PNG 방식 — SVG data URL 은 Kakao MarkerImage 에서 불안정.
      {
        const ARROW_INTERVAL_M = 200;
        const arrowCache = {};
        const makeArrowImage = (angleDeg, arrowColor) => {
          const r = Math.round(angleDeg / 5) * 5;
          const key = `${r}_${arrowColor}`;
          if (arrowCache[key]) return arrowCache[key];
          const c = document.createElement('canvas');
          c.width = 20; c.height = 20;
          const ctx = c.getContext('2d');
          ctx.save();
          ctx.translate(10, 10);
          ctx.rotate(r * Math.PI / 180);
          ctx.translate(-10, -10);
          ctx.beginPath();
          ctx.moveTo(10, 2);   // 위 꼭짓점 (진행방향 끝)
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
          arrowCache[key] = new window.kakao.maps.MarkerImage(
            url,
            new window.kakao.maps.Size(20, 20),
            { offset: new window.kakao.maps.Point(10, 10) }
          );
          return arrowCache[key];
        };
        const calcBearing = (lat1, lng1, lat2, lng2) => {
          const toRad = d => d * Math.PI / 180;
          const dLng = toRad(lng2 - lng1);
          const φ1 = toRad(lat1), φ2 = toRad(lat2);
          const y = Math.sin(dLng) * Math.cos(φ2);
          const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLng);
          return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
        };
        let distAcc = 0;
        let nextArrowAt = ARROW_INTERVAL_M;
        for (let i = 1; i < pts.length; i++) {
          const prev = pts[i - 1], cur = pts[i];
          const segDist = haversineM(prev.lat, prev.lng, cur.lat, cur.lng);
          distAcc += segDist;
          if (distAcc >= nextArrowAt) {
            nextArrowAt = distAcc + ARROW_INTERVAL_M;
            const angle = calcBearing(prev.lat, prev.lng, cur.lat, cur.lng);
            const arrowColor = speedColor ? (BUCKET_COLORS[speedBucket(cur)] || color) : color;
            const m = new window.kakao.maps.Marker({
              map: mapRef.current,
              position: new window.kakao.maps.LatLng(cur.lat, cur.lng),
              image: makeArrowImage(angle, arrowColor),
              clickable: false,
              zIndex: 4,
            });
            seekerRef.current.pts.push(m);
          }
        }
      }

      // ── 속도 초과 오버레이 (C) ──────────────────────────────────
      if (speedLimit != null) {
        let seg = null;
        const flushSpeedSeg = () => {
          if (seg && seg.length >= 2) {
            const poly = new window.kakao.maps.Polyline({
              map: mapRef.current, path: seg,
              strokeWeight: sw + 2,
              strokeColor: '#EF4444',
              strokeOpacity: 0.9,
              strokeStyle: 'solid',
              zIndex: 10,
            });
            seekerRef.current.poly.push(poly);
          }
          seg = null;
        };
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          if (p._speed != null && p._speed > speedLimit) {
            if (!seg) seg = [];
            // 이전 점도 포함해야 선이 이어짐
            if (seg.length === 0 && i > 0) {
              seg.push(new window.kakao.maps.LatLng(pts[i-1].lat, pts[i-1].lng));
            }
            seg.push(new window.kakao.maps.LatLng(p.lat, p.lng));
          } else {
            if (seg) {
              // 초과 구간 끝 — 다음 점까지 포함해 연결
              seg.push(new window.kakao.maps.LatLng(p.lat, p.lng));
              flushSpeedSeg();
            }
          }
        }
        flushSpeedSeg();
      }

      // ── GPS 약신호 오버레이 (A) — sat < 4 ──────────────────────
      if (showSatWarning) {
        let satSeg = null;
        const flushSatSeg = () => {
          if (satSeg && satSeg.length >= 2) {
            const poly = new window.kakao.maps.Polyline({
              map: mapRef.current, path: satSeg,
              strokeWeight: sw + 1,
              strokeColor: '#F59E0B',
              strokeOpacity: 0.85,
              strokeStyle: 'shortdot',
              zIndex: 9,
            });
            seekerRef.current.poly.push(poly);
          }
          satSeg = null;
        };
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          const weakSat = p.sat != null && p.sat < 4;
          if (weakSat) {
            if (!satSeg) satSeg = [];
            if (satSeg.length === 0 && i > 0) {
              satSeg.push(new window.kakao.maps.LatLng(pts[i-1].lat, pts[i-1].lng));
            }
            satSeg.push(new window.kakao.maps.LatLng(p.lat, p.lng));
          } else {
            if (satSeg) {
              satSeg.push(new window.kakao.maps.LatLng(p.lat, p.lng));
              flushSatSeg();
            }
          }
        }
        flushSatSeg();
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

    // ── 경로 계획 (Route Planner) ─────────────────────────────
    drawRoutePlan(waypoints) {
      // 기존 route 제거
      routePlanRef.current.markers.forEach(m => m.setMap(null));
      routePlanRef.current.polys.forEach(p => p.setMap(null));
      routePlanRef.current = { markers: [], polys: [] };
      if (!mapRef.current || !waypoints?.length) return;

      const kakao = window.kakao.maps;
      const latLngs = waypoints.map(w => new kakao.LatLng(w.lat, w.lng));

      // 번호 마커 (캔버스 기반)
      waypoints.forEach((w, i) => {
        const c = document.createElement('canvas');
        c.width = 32; c.height = 32;
        const ctx = c.getContext('2d');
        ctx.beginPath();
        ctx.arc(16, 16, 14, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#10B981' : i === waypoints.length - 1 ? '#EF4444' : '#4f46e5';
        ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), 16, 17);
        const img = new kakao.MarkerImage(c.toDataURL(), new kakao.Size(32, 32), { offset: new kakao.Point(16, 16) });
        const marker = new kakao.Marker({ map: mapRef.current, position: latLngs[i], image: img, zIndex: 300 });
        routePlanRef.current.markers.push(marker);
      });

      // 경로 폴리라인
      if (latLngs.length >= 2) {
        const poly = new kakao.Polyline({
          map: mapRef.current, path: latLngs,
          strokeWeight: 4, strokeColor: '#4f46e5',
          strokeOpacity: 0.85, strokeStyle: 'solid',
        });
        routePlanRef.current.polys.push(poly);
      }

      // 바운드 맞추기
      const bounds = new kakao.LatLngBounds();
      latLngs.forEach(ll => bounds.extend(ll));
      mapRef.current.setBounds(bounds, 60);
    },

    clearRoutePlan() {
      routePlanRef.current.markers.forEach(m => m.setMap(null));
      routePlanRef.current.polys.forEach(p => p.setMap(null));
      routePlanRef.current = { markers: [], polys: [] };
    },

    removeMarker(deviceId) {
      const entry = markersRef.current[deviceId];
      if (entry) {
        entry.marker.setMap(null);
        delete markersRef.current[deviceId];
      }
      if (polyRef.current[deviceId]) {
        polyRef.current[deviceId].setMap(null);
        delete polyRef.current[deviceId];
      }
      const pts = pointsRef.current[deviceId];
      if (pts) {
        pts.forEach(({ marker }) => marker.setMap(null));
        delete pointsRef.current[deviceId];
      }
      delete coordsRef.current[deviceId];
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

function buildMainInfoHTML(label, color, m, addr, lat, lng) {
  const fixTxt = m.fix === false ? 'no fix' : 'fix';
  const ageTxt = m.recordedAt ? new Date(m.recordedAt).toLocaleString('ko-KR') : '—';
  const sat    = m.sat ?? '—';
  const vbat   = m.vbatMv ? `${m.vbatMv} mV` : '—';
  return `
    <div style="padding:12px 14px;font-size:12px;font-family:-apple-system,system-ui,sans-serif;min-width:240px;line-height:1.55;color:#1a1a2e">
      <div style="font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:6px">
        <span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:${color || '#888'}"></span>
        ${escHtml(label)}
      </div>
      ${ROW(SVG_PIN, addrLine(addr))}
      ${ROW(SVG_SAT, `${fixTxt} · sat ${sat}`)}
      ${ROW(SVG_BAT, vbat)}
      <div style="color:#888;font-size:11px;margin:4px 0 10px">${ageTxt}</div>
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
      ${roadviewBtn(lat, lng)}
    </div>
  `;
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
