// 공유 토큰만으로 접근하는 read-only 지도 페이지.
// 로그인 불필요, URL: /gps-tracker/app/s/<token>  또는  /s/<token>
//
// 두 모드:
//   - 라이브: 최근 N시간 (1h/6h/24h/7d) — 30초 자동 갱신
//   - 컴팩트 시커: MiniSeekerOverlay (좌하단 날짜 + 하단 시간) — 인증 user 와 동일 UX
import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchSharedView, fetchSharedLocations, fetchSharedDailyStats } from '../api';
import Icon from '../components/Icon';
import MiniSeekerOverlay from '../components/MiniSeekerOverlay';
import { applyTheme } from '../theme';

const DEFAULT_CENTER  = { lat: 37.5665, lng: 126.9780 };
const REFRESH_MS      = 30_000;
const RANGE_OPTIONS = [
  { id: '1h',  label: '1시간',  hours: 1 },
  { id: '6h',  label: '6시간',  hours: 6 },
  { id: '24h', label: '24시간', hours: 24 },
  { id: '7d',  label: '7일',    hours: 168 },
];

export default function SharePage({ token }) {
  const [view,    setView]    = useState(null);
  const [points,  setPoints]  = useState([]);    // 라이브 모드 점들 (시커 모드에선 자체 관리)
  const [error,   setError]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [mode,    setMode]    = useState('live');  // 'live' | 'history'
  const [rangeId, setRangeId] = useState('24h');
  const [lastSync, setLastSync] = useState(null);
  const [, setTick] = useState(0);

  const containerRef = useRef(null);
  const mapRef       = useRef(null);
  const polyRef      = useRef(null);
  const markerRef    = useRef(null);
  const dotsRef      = useRef([]);   // 클릭 가능한 작은 점 마커들
  const iwRef        = useRef(null); // InfoWindow (한 개만 공유)
  const geocoderRef  = useRef(null);
  const fitOnceRef   = useRef(false);

  const rangeHours = RANGE_OPTIONS.find(r => r.id === rangeId)?.hours || 24;

  // 공유 페이지는 항상 라이트 테마. CSS 변수가 inline style 로 박혀있어 data-theme 속성만
  // 바꾸면 색이 안 따라감 — applyTheme() 으로 변수 자체를 덮어써야 함. localStorage 도
  // 'light' 로 마킹되니, 본인 디바이스라도 다음 보통 페이지 진입 때까지 라이트로 유지될 수 있음
  // (사용자가 본 dashboard 가서 다시 다크로 토글 가능).
  useEffect(() => {
    const prev = localStorage.getItem('theme');
    // 공유 뷰어는 사용자 계정 theme 오염 방지 — persist/syncServer 둘 다 skip.
    applyTheme('light', { persist: false, syncServer: false });
    return () => {
      if (prev) applyTheme(prev, { persist: false, syncServer: false });
    };
  }, []);

  // 1) 메타 1회
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSharedView(token)
      .then(v => { if (!cancelled) setView(v); })
      .catch(e => { if (!cancelled) setError(e.message || '잘못된 링크'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  // 2) 라이브 — 30초 폴링. history 모드면 멈춤.
  useEffect(() => {
    if (!view || error || mode !== 'live') return;
    let cancelled = false;
    fitOnceRef.current = false;

    async function pull() {
      try {
        const since = new Date(Date.now() - rangeHours * 3600 * 1000).toISOString();
        const locs = await fetchSharedLocations(token, { fix_only: true, limit: 5000, since });
        if (cancelled) return;
        setPoints((locs || []).filter(p => p.lat != null && p.lng != null));
        setLastSync(Date.now());
      } catch { /* noop */ }
    }
    pull();
    const t = setInterval(pull, REFRESH_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [token, view, error, rangeHours, mode]);

  // 1초 강제 리렌더 (배지)
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // 3) 지도 초기화
  useEffect(() => {
    if (!view || error || mapRef.current) return;
    const initMap = () => {
      window.kakao.maps.load(() => {
        if (!containerRef.current || mapRef.current) return;
        const center = view.last_lat && view.last_lng
          ? new window.kakao.maps.LatLng(view.last_lat, view.last_lng)
          : new window.kakao.maps.LatLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng);
        mapRef.current = new window.kakao.maps.Map(containerRef.current, { center, level: 4 });
        if (view.last_lat && view.last_lng) {
          markerRef.current = new window.kakao.maps.Marker({
            map: mapRef.current, position: center,
            image: pinImage(view.device_color || '#5B7CFF'),
            zIndex: 9999,
          });
        }
        // 모든 점 마커가 공유하는 InfoWindow. zIndex 더 높게.
        iwRef.current = new window.kakao.maps.InfoWindow({
          content: '<div></div>',
          removable: true,
          zIndex: 10000,
        });
      });
    };
    if (window.kakao?.maps) initMap();
    else {
      const wait = setInterval(() => {
        if (window.kakao?.maps) { clearInterval(wait); initMap(); }
      }, 100);
      return () => clearInterval(wait);
    }
  }, [view, error]);

  // 4) 라이브 모드의 points 그리기. history 모드일 땐 MiniSeekerOverlay 가 onPathChange 로 통보.
  useEffect(() => {
    if (mode !== 'live') return;
    drawPath(points);
    updateMarkerToLatest(points);
    fitIfFirst(points);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, view, mode]);

  // path/마커 헬퍼 — raw kakao 호출.
  function drawPath(pts) {
    if (!mapRef.current || !window.kakao?.maps) return;
    polyRef.current?.setMap(null);
    polyRef.current = null;
    dotsRef.current.forEach(m => m.setMap(null));
    dotsRef.current = [];

    const color = view?.device_color || '#5B7CFF';
    const list  = pts || [];
    const path  = list.slice().reverse()
      .map(p => new window.kakao.maps.LatLng(p.lat, p.lng));
    if (path.length >= 2) {
      polyRef.current = new window.kakao.maps.Polyline({
        map: mapRef.current,
        path, strokeWeight: 3, strokeColor: color, strokeOpacity: 0.85, strokeStyle: 'solid',
      });
    }

    // 점 샘플링 — 너무 많으면 시각·성능 부담. 최대 ~50 개로 균등 샘플.
    const N = list.length;
    if (N > 0) {
      const target = Math.min(50, N);
      const step   = Math.max(1, Math.floor(N / target));
      const dotImg = smallDotImage(color);
      for (let i = 0; i < N; i += step) {
        const p = list[i];
        const m = new window.kakao.maps.Marker({
          map: mapRef.current,
          position: new window.kakao.maps.LatLng(p.lat, p.lng),
          image: dotImg,
          zIndex: 5,
          clickable: true,
        });
        window.kakao.maps.event.addListener(m, 'click', () => openDotInfo(m, p));
        dotsRef.current.push(m);
      }
    }
  }
  function clearPath() {
    polyRef.current?.setMap(null);
    polyRef.current = null;
    dotsRef.current.forEach(m => m.setMap(null));
    dotsRef.current = [];
    iwRef.current?.close();
  }

  // 점 클릭 시 — 즉시 시각·좌표 표기 후 비동기 주소 추가.
  function openDotInfo(marker, p) {
    if (!iwRef.current || !mapRef.current) return;
    const time = new Date(p.recorded_at).toLocaleString('ko-KR', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    function build(addr) {
      return `
        <div style="padding:8px 10px; min-width:180px; font-family: -apple-system, sans-serif;">
          <div style="font-size:12px; font-weight:700; color:#1A1A2E;">${time}</div>
          <div style="font-size:11px; color:#666; margin-top:4px;">
            ${addr ? (addr.road || addr.jibun || '주소 미상') : '주소 확인 중...'}
            ${addr?.building ? `<div style="color:#999;">${addr.building}</div>` : ''}
          </div>
          <div style="font-size:10px; color:#999; margin-top:4px;">
            ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}
          </div>
        </div>`;
    }
    iwRef.current.setContent(build(null));
    iwRef.current.open(mapRef.current, marker);
    sharedGeocode(p.lat, p.lng).then(addr => {
      // 다른 점이 클릭됐을 수 있어 — InfoWindow 가 여전히 이 마커에 열려있을 때만 갱신.
      iwRef.current?.setContent(build(addr));
    });
  }

  // 카카오 Geocoder 로 좌표 → 주소. 메모리 캐시 (4자리 양자화 ~ 11m 그리드).
  function sharedGeocode(lat, lng) {
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (sharedGeocode._cache?.has(key)) return Promise.resolve(sharedGeocode._cache.get(key));
    if (!sharedGeocode._cache) sharedGeocode._cache = new Map();
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
        sharedGeocode._cache.set(key, out);
        resolve(out);
      });
    });
  }
  function updateMarkerToLatest(pts) {
    if (!mapRef.current || !window.kakao?.maps) return;
    const latest = pts && pts[0];
    if (!latest) return;
    const pos = new window.kakao.maps.LatLng(latest.lat, latest.lng);
    if (markerRef.current) markerRef.current.setPosition(pos);
    else markerRef.current = new window.kakao.maps.Marker({
      map: mapRef.current, position: pos,
      image: pinImage(view?.device_color || '#5B7CFF'),
      zIndex: 9999,
    });
  }
  function panToPoint(p) {
    if (!mapRef.current || !p) return;
    mapRef.current.panTo(new window.kakao.maps.LatLng(p.lat, p.lng));
    if (markerRef.current) {
      markerRef.current.setPosition(new window.kakao.maps.LatLng(p.lat, p.lng));
    }
  }
  function fitIfFirst(pts) {
    if (fitOnceRef.current) return;
    if (!pts || pts.length === 0 || !mapRef.current) return;
    fitOnceRef.current = true;
    if (pts.length === 1) {
      mapRef.current.setCenter(new window.kakao.maps.LatLng(pts[0].lat, pts[0].lng));
    } else {
      const bounds = new window.kakao.maps.LatLngBounds();
      pts.forEach(p => bounds.extend(new window.kakao.maps.LatLng(p.lat, p.lng)));
      mapRef.current.setBounds(bounds);
    }
  }

  function fitToCurrent() {
    fitOnceRef.current = false;
    fitIfFirst(points);
  }
  function toggleMode() {
    setMode(m => m === 'live' ? 'history' : 'live');
    fitOnceRef.current = false;
    clearPath();
  }
  function onHWheel(e) {
    if (e.deltaY === 0) return;
    e.currentTarget.scrollLeft += e.deltaY;
    e.preventDefault();
  }

  // MiniSeekerOverlay 용 어댑터 — 공개 토큰으로 데이터 조회.
  const seekerAdapter = useMemo(() => ({
    loadDates: () => fetchSharedDailyStats(token, { limit: 30 })
      .then(rows => (rows || []).map(r => r.date)),
    loadDayPoints: (date) => fetchSharedLocations(token, {
      since: `${date}T00:00:00+09:00`,
      until: `${date}T23:59:59+09:00`,
      fix_only: true, limit: 10000,
    }),
  }), [token]);

  if (loading) return <div style={s.fullCenter}>로딩 중...</div>;
  if (error) {
    return (
      <div style={s.fullCenter}>
        <div style={{ textAlign: 'center', padding: 24 }}>
          <div style={{ marginBottom: 12, color: 'var(--text-2)' }}>
            <Icon name="warn" size={48} stroke={1.5} />
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>접근할 수 없는 링크</div>
          <div style={{ fontSize: 13, color: 'var(--text-2)' }}>{error}</div>
        </div>
      </div>
    );
  }

  const expSoon  = view && new Date(view.expires_at) - new Date() < 6 * 3600 * 1000;
  const syncAgo  = lastSync ? Math.floor((Date.now() - lastSync) / 1000) : null;
  const liveTone = mode !== 'live'        ? 'var(--text-3)'
                   : syncAgo == null      ? 'var(--text-3)'
                   : syncAgo > REFRESH_MS / 1000 + 5 ? 'var(--danger)'
                   : 'var(--accent)';

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <header style={s.header}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14 }}>
            <Icon name="mapPin" size={14} style={{ color: 'var(--primary)' }} />
            {view?.device_name || '디바이스'}
          </div>
          {view?.note && <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>{view.note}</div>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
          <div style={{ fontSize: 10, color: liveTone, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              width: 6, height: 6, borderRadius: 3, background: liveTone,
              animation: mode === 'live' && syncAgo != null && syncAgo < 2 ? 'pulse 1s ease-in-out infinite' : 'none',
            }} />
            {mode === 'history' ? '기간보기' :
             syncAgo == null    ? '갱신 대기' :
             syncAgo < 2        ? '실시간' :
             `${syncAgo}초 전 갱신`}
          </div>
          <div style={{ fontSize: 10, color: expSoon ? 'var(--danger)' : 'var(--text-3)' }}>
            만료 {fmtRelativeFuture(view?.expires_at)}
          </div>
        </div>
      </header>

      <div style={s.toolbar}>
        <button onClick={toggleMode} style={{
          ...s.modeBtn,
          ...(mode === 'live' ? s.modeBtnLive : s.modeBtnOn),
        }} title="라이브/기간보기 전환">
          <Icon name={mode === 'history' ? 'eye' : 'clock'} size={12} />
          {mode === 'history' ? '기간보기' : '라이브'}
        </button>

        {mode === 'live' && (
          <div style={{ display: 'flex', gap: 4, overflowX: 'auto', flex: 1, scrollbarWidth: 'thin' }}
               onWheel={onHWheel}>
            {RANGE_OPTIONS.map(r => (
              <button key={r.id} onClick={() => setRangeId(r.id)} style={{
                ...s.rangeBtn,
                ...(r.id === rangeId ? s.rangeBtnOn : null),
              }}>{r.label}</button>
            ))}
          </div>
        )}

        {mode === 'history' && <div style={{ flex: 1 }} />}

        <button onClick={fitToCurrent} style={s.fitBtn} title="경로에 카메라 맞춤">
          <Icon name="filter" size={12} /> 맞춤
        </button>
      </div>

      <div style={{ flex: 1, position: 'relative' }}>
        <div ref={containerRef} style={{ position: 'absolute', inset: 0, background: '#0a0a12' }} />

        {/* 시커 모드 — 컴팩트 시커가 좌하단 + 하단 strip 으로 떠 있음 */}
        {mode === 'history' && (
          <MiniSeekerOverlay
            loadDates={seekerAdapter.loadDates}
            loadDayPoints={seekerAdapter.loadDayPoints}
            onPathChange={(pts) => { drawPath(pts); fitOnceRef.current = false; fitIfFirst(pts); }}
            onPathClear={clearPath}
            onSlotSelect={panToPoint}
          />
        )}
      </div>

      <footer style={s.footer}>
        <span>마지막 위치: {fmtTime(view?.last_seen_at)}</span>
        <span style={{ color: 'var(--text-3)' }}>
          {mode === 'live' ? `${points.length}개 점 · ` : ''}read-only
        </span>
      </footer>
    </div>
  );
}

// 작은 점 마커 — 클릭 시 InfoWindow 띄우는 용도.
function smallDotImage(color) {
  const sz = 12;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${sz}" height="${sz}" viewBox="0 0 ${sz} ${sz}">
      <circle cx="${sz/2}" cy="${sz/2}" r="${sz/2 - 1.5}" fill="${color}" stroke="white" stroke-width="1.5"/>
    </svg>`;
  const url = 'data:image/svg+xml;base64,' + btoa(svg);
  return new window.kakao.maps.MarkerImage(
    url, new window.kakao.maps.Size(sz, sz),
    { offset: new window.kakao.maps.Point(sz / 2, sz / 2) },
  );
}

function pinImage(color) {
  const w = 32, h = 40;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <defs>
        <filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="1.5" flood-opacity="0.35"/>
        </filter>
      </defs>
      <path filter="url(#sh)"
            d="M16 1c-7.18 0-13 5.82-13 13 0 9.5 13 25 13 25s13-15.5 13-25C29 6.82 23.18 1 16 1z"
            fill="${color}" stroke="white" stroke-width="2"/>
      <circle cx="16" cy="14" r="5" fill="white"/>
    </svg>`;
  const url = 'data:image/svg+xml;base64,' + btoa(svg);
  return new window.kakao.maps.MarkerImage(
    url, new window.kakao.maps.Size(w, h),
    { offset: new window.kakao.maps.Point(w / 2, h - 1) },
  );
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ko-KR');
}
function fmtRelativeFuture(iso) {
  if (!iso) return '—';
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return '만료됨';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}분 후`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 후`;
  return `${Math.floor(h / 24)}일 후`;
}

const s = {
  fullCenter: {
    height: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg)', color: 'var(--text)',
  },
  header: {
    padding: '12px 16px',
    paddingTop: 'calc(env(safe-area-inset-top, 0) + 12px)',
    background: 'var(--surface)',
    borderBottom: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    flexShrink: 0,
  },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 12px',
    background: 'var(--surface)',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  modeBtn: {
    flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '5px 10px', fontSize: 11, fontWeight: 700,
    background: 'var(--surface-2)', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 6,
    cursor: 'pointer', whiteSpace: 'nowrap',
  },
  modeBtnOn: {
    background: 'var(--primary)', color: 'var(--primary-fg, white)',
    borderColor: 'var(--primary)',
  },
  // 라이브 모드 — 실시간 진행을 시각적으로 강조하기 위해 accent 녹색.
  modeBtnLive: {
    background: 'var(--accent)', color: 'white',
    borderColor: 'var(--accent)',
  },
  rangeBtn: {
    flexShrink: 0,
    padding: '5px 10px', fontSize: 11, fontWeight: 600,
    background: 'var(--surface-2)', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 6,
    cursor: 'pointer', whiteSpace: 'nowrap',
  },
  rangeBtnOn: {
    background: 'var(--primary)', color: 'var(--primary-fg, white)',
    borderColor: 'var(--primary)',
  },
  fitBtn: {
    flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '5px 10px', fontSize: 11, fontWeight: 600,
    background: 'var(--surface-2)', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 6,
    cursor: 'pointer',
  },
  footer: {
    padding: '8px 16px',
    paddingBottom: 'calc(env(safe-area-inset-bottom, 0) + 8px)',
    background: 'var(--surface)',
    borderTop: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    fontSize: 11, color: 'var(--text-2)', flexShrink: 0,
  },
};
