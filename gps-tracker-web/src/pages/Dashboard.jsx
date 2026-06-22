import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { TrackerWS } from '../ws';
import KakaoMap from '../components/KakaoMap';
import ProfilePanel from '../components/ProfilePanel';
import DeviceDetail from '../components/DeviceDetail';
import BottomNav from '../components/BottomNav';
import SideRail from '../components/SideRail';
import MapControls from '../components/MapControls';
import RoadviewModal, { probeRoadview } from '../components/RoadviewModal';
import { enrichWithSpeedStops, haversineM } from '../lib/stops';
import { confirmDialog, alertDialog } from '../components/Dialog';
import DeviceFilter from '../components/DeviceFilter';
import GeofenceSheet from '../components/GeofenceSheet';
import SeekerSheet from '../components/SeekerSheet';
import MiniSeekerOverlay, { MINI_SEEKER_BOTTOM_HEIGHT } from '../components/MiniSeekerOverlay';
import HomeFenceQuick from '../components/HomeFenceQuick';
import YesterdaySummaryDialog from '../components/YesterdaySummaryDialog';
import PointInfoSheet from '../components/PointInfoSheet';
import AdminDashboard from '../components/AdminDashboard';
import CorporatePanel from '../components/CorporatePanel';
import PairTutorial, { shouldShowPairTutorial } from '../components/PairTutorial';
import UnpairModal from '../components/UnpairModal';
import Icon from '../components/Icon';
import useBreakpoint from '../useBreakpoint';
import { PALETTE, getDeviceColor, setDeviceColorLocal, isStale, isFixStale, ageString, classifyDevice } from '../colors';

// 펜스에 적용 디바이스 한 대라도 안에 있으면 true.
function isAnyDeviceInsideFence(fence, devices) {
  const targets = fence.device_id
    ? devices.filter(d => d.id === fence.device_id)
    : devices;
  const R = 6371000, r = Math.PI / 180;
  return targets.some(d => {
    if (d.last_lat == null || d.last_lng == null) return false;
    const dLa = (fence.center_lat - d.last_lat) * r;
    const dLo = (fence.center_lng - d.last_lng) * r;
    const a = Math.sin(dLa/2)**2
            + Math.cos(d.last_lat*r) * Math.cos(fence.center_lat*r) * Math.sin(dLo/2)**2;
    const dist = 2 * R * Math.asin(Math.sqrt(a));
    return dist <= fence.radius_m;
  });
}

// _isStop / _speed enrichment 은 lib/stops.js — 시커와 공유. cluster (5+ 점이 50m
// 이내 뭉침) 기반 — 실시간 / seeker 양쪽 dot 마커에 동일 빨강 색칠 트리거.

// pathname → view (route 제외 시 'home')
//   /devices, /devices/pair → 'devices'
//   /tools*                 → 'tools'
//   /profile*               → 'profile'
//   /admin*                 → 'admin'
//   /corporate*             → 'corporate'
//   else                    → 'home'
function pathToView(p) {
  if (p.startsWith('/devices'))   return 'devices';
  if (p.startsWith('/tools'))     return 'tools';
  if (p.startsWith('/profile'))   return 'profile';
  if (p.startsWith('/admin'))     return 'admin';
  if (p.startsWith('/corporate')) return 'corporate';
  return 'home';
}
function viewToPath(v) {
  return v === 'home' ? '/' : `/${v}`;
}
function calcSpeedKmh(prev, next) {
  if (!prev?.lat || !prev?.lng || !prev?.recordedAt || !next?.lat || !next?.lng || !next?.recordedAt) return null;
  const dt = new Date(next.recordedAt).getTime() - new Date(prev.recordedAt).getTime();
  if (!(dt > 0)) return null;
  const distM = haversineM(prev.lat, prev.lng, next.lat, next.lng);
  if (distM < 3) return 0;
  const speed = (distM / (dt / 1000)) * 3.6;
  return Number.isFinite(speed) ? Math.min(speed, 240) : null;
}

function speedTone(speedKmh) {
  if (speedKmh == null) return '#94A3B8';
  if (speedKmh < 5) return '#64748B';
  if (speedKmh < 30) return '#10B981';
  if (speedKmh < 70) return '#3B82F6';
  return '#F97316';
}

export default function Dashboard({ onLogout }) {
  const location = useLocation();
  const navigate = useNavigate();
  const view = pathToView(location.pathname);
  const setView = useCallback((v) => {
    navigate(viewToPath(v));
  }, [navigate]);
  const [devices, setDevices]         = useState([]);
  const [pairMode, setPairMode]       = useState('iccid');
  const [pairUid, setPairUid]         = useState('');
  const [pairIccid, setPairIccid]     = useState('');
  const [pairLabel, setPairLabel]     = useState('');
  const [pairError, setPairError]     = useState('');
  const [pairLoading, setPairLoading] = useState(false);
  const [pairOpen, setPairOpen]       = useState(false);

  // /devices/pair deep link — 카카오 알림톡 등 외부에서 진입 + 연구소 탭의 "튜토리얼 다시 보기"
  // 버튼에서 재진입까지 모두 처리. 한 번 처리 후 path 정리 (/devices) — 새로고침 시 중복 트리거 방지.
  // ref 대신 state — 재진입 시 deps 변경으로 2단계 useEffect 가 매번 fire.
  const [pairTutorialOpen, setPairTutorialOpen] = useState(false);
  const [pairDeepLinkPending, setPairDeepLinkPending] = useState(false);
  useEffect(() => {
    if (location.pathname.startsWith('/devices/pair')) {
      setPairDeepLinkPending(true);
      setPairOpen(true);
      navigate('/devices' + location.search, { replace: true });
    }
  }, [location.pathname, location.search, navigate]);

  // devices 가 첫 로드된 뒤 — deep link 였고 디바이스 0개 또는 ?tutorial=1 이면 튜토리얼 표시.
  // devices 가 useState([]) 초기값이라, "정말로 fetch 끝났는지" 별도로 tracking.
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  useEffect(() => {
    if (!pairDeepLinkPending) return;
    if (!devicesLoaded) return;
    setPairDeepLinkPending(false);
    const force = new URLSearchParams(window.location.search).get('tutorial') === '1';
    if (shouldShowPairTutorial(devices.length, force)) {
      setPairTutorialOpen(true);
    }
  }, [pairDeepLinkPending, devicesLoaded, devices]);
  const [editId, setEditId]           = useState(null);
  const [editLabel, setEditLabel]     = useState('');
  const [colorPickerId, setColorPickerId] = useState(null);
  const [detailId, setDetailId]       = useState(null);
  const [wsStatus, setWsStatus]       = useState('disconnected');
  const [roadview, setRoadview]       = useState(null);    // {lat, lng, panoId} or null
  const [toast, setToast]             = useState(null);     // 가벼운 중앙 토스트 메시지 (1초)
  const [filterDeviceId, setFilterDeviceId] = useState(null);  // null=전체, 또는 device id
  const [, setTick]                   = useState(0);
  const bp        = useBreakpoint();
  const isDesktop = bp === 'desktop';
  const [showGeofence, setShowGeofence] = useState(false);
  const [showSeeker,  setShowSeeker]    = useState(false);
  // 컴팩트 시커 — 좌측 날짜 + 하단 시간 슬롯 오버레이. 지오펜스/패널 시커와 mutex.
  // 월/일/시간 wizard 통합 (HomeMapSeeker 흡수).
  const [showMiniSeeker, setShowMiniSeeker] = useState(false);
  // 모바일 친화 마커 클릭 정보 sheet (kakao InfoWindow 대체).
  const [pointInfo, setPointInfo] = useState(null);
  const [liveSpeed, setLiveSpeed] = useState(null);
  // 라이브 추적 — 두 상태 분리:
  //   userTrackPref: 사용자가 의도한 ON/OFF (버튼·디바이스 선택으로만 변경)
  //   seekerPaused : 시커 활성 동안 일시 정지 — 시커 닫히면 자동 복원
  // 사용자가 직접 지도 드래그하면 userTrackPref=false 로 영구 끔 (다시 버튼 또는 디바이스 선택해야 부활).
  const [userTrackPref, setUserTrackPref] = useState(false);
  const [seekerPaused,  setSeekerPaused]  = useState(false);
  const trackLive = userTrackPref && !seekerPaused;
  const [me, setMe] = useState(null);
  const [accountType, setAccountType] = useState(null);   // unspecified | rentcar | corporate_fleet | delivery
  const isAdmin     = me?.role === 'admin';
  const isCorporate = accountType === 'corporate_fleet';

  // ── 사용자 UI 환경설정 (계정 귀속) ────────────────────────
  // prefs.filter_device_id — 다른 PC 에서 로그인해도 마지막 선택 디바이스 복원
  const [userPrefs, setUserPrefs]   = useState(null);
  const userPrefsRef                = useRef(null);
  const [mapReady, setMapReady]     = useState(false);
  const filterAppliedRef            = useRef(false);
  const filterSaveTimerRef          = useRef(null);
  // 사용자가 마지막으로 본 지도 view (center+level). 새로고침 후 복원에 사용.
  const mapViewSaveTimerRef         = useRef(null);
  const lastSavedMapViewRef         = useRef(null);    // 중복 PATCH 방지

  // 펜스: 시트 열림 여부와 무관하게 항상 동기화
  const [fences, setFences]   = useState([]);
  const [showFences, setShowFencesRaw] = useState(() => localStorage.getItem('show_fences') !== 'false');
  const setShowFences = useCallback((v) => {
    setShowFencesRaw(prev => {
      const next = typeof v === 'function' ? v(prev) : v;
      localStorage.setItem('show_fences', String(next));
      return next;
    });
  }, []);
  const loadFences = useCallback(async () => {
    try { setFences(await api.listGeofences()); }
    catch (e) { console.error('loadFences', e); }
  }, []);

  // 본인 정보 (role 등) — 마운트 시 한 번
  useEffect(() => {
    api.getMe().then(setMe).catch(() => {});
    api.getAccountType().then(r => setAccountType(r.account_type)).catch(() => {});
  }, []);

  // 사용자 prefs — filter_device_id 복원용
  useEffect(() => {
    api.getMyPrefs().then(p => setUserPrefs(p || {})).catch(() => setUserPrefs({}));
  }, []);

  // 펜스 알림 master switch — 서버 notification_settings.geofence_alert 와 연동.
  // off 면 푸시도 발송 안 되고 지도 표시도 강제 off (상위 호환).
  const [geofenceAlert, setGeofenceAlertRaw] = useState(true);
  const loadGeofenceAlert = useCallback(async () => {
    try {
      const s = await api.getNotificationSettings();
      setGeofenceAlertRaw(!!s.geofence_alert);
    } catch (e) { /* 기본 true 유지 */ }
  }, []);
  const toggleGeofenceAlert = useCallback(async (v) => {
    setGeofenceAlertRaw(v);   // optimistic
    try { await api.updateNotificationSettings({ geofence_alert: v }); }
    catch (e) {
      setGeofenceAlertRaw(!v);
      alert(e.message || '알림 설정 변경 실패');
    }
  }, []);

  const mapRef     = useRef(null);
  const wsRef      = useRef(null);
  const devRef     = useRef([]);
  const lastMetaRef = useRef({});
  // 간이 시커의 imperative handle — 지도 마커 클릭 시 selectByTime 으로 슬롯/월 drill 동기화.
  const miniSeekerRef = useRef(null);

  // 연구소 — 오늘 첫 열람 어제 운행 요약 팝업.
  // 트리거: userPrefs.lab_first_view_summary === true 일 때, 사용자가 디바이스 필터를
  // null → not-null 로 바꾼 첫 순간 (해당 device, 그 KST 날짜에 한해 1회).
  // 중복 방지: localStorage 키 'lab_summary_shown:<userId>:<deviceId>' = KST yyyy-mm-dd.
  const [yesterdayDialog, setYesterdayDialog] = useState(null);   // null | { deviceName, dateStr, stats }

  // 지도 컨테이너가 display:none(admin/corporate) 였다 다시 보일 때 relayout 호출.
  // 안 부르면 컨테이너 크기 0 으로 그려져있어서 회색 / 빈 화면.
  useEffect(() => {
    const isMapVisible =
      isDesktop ||
      (view !== 'admin' && view !== 'corporate');
    if (isMapVisible) {
      // 브라우저가 display 를 적용한 뒤 다음 frame 에 relayout.
      requestAnimationFrame(() => mapRef.current?.relayout?.());
    }
  }, [view, isDesktop]);

  // 디바이스 목록을 ref 에 미러링 — 콜백이 매번 리렌더되는 걸 막기 위해.
  // (WebSocket 이벤트 → setDevices → 리렌더 → MiniSeeker prop 새 fn → useEffect 재실행 →
  //  drawSeekerPath 재호출 → setBounds 가 카메라 리셋. ref 로 의존성 끊음.)
  const devicesRef = useRef(devices);
  useEffect(() => { devicesRef.current = devices; }, [devices]);
  useEffect(() => { userPrefsRef.current = userPrefs; }, [userPrefs]);

  // 시커 열림/닫힘에 따라 seekerPaused 자동 토글 — 시커 닫으면 userTrackPref 복원.
  useEffect(() => {
    setSeekerPaused(!!(showSeeker || showMiniSeeker));
  }, [showSeeker, showMiniSeeker]);

  // 시커 활성 시 라이브 history 점 (초록) 숨기기 — seeker path (파랑) 와 시각 충돌 방지.
  // 시커 닫으면 자동 복원. addHistoryPoint 가 새로 그릴 때도 mapVisible=true 면 보이게 됨.
  useEffect(() => {
    const seekerActive = !!(showSeeker || showMiniSeeker);
    mapRef.current?.setHistoryPointsVisible?.(!seekerActive);
    mapRef.current?.setLiveTrailsVisible?.(!seekerActive);
  }, [showSeeker, showMiniSeeker]);

  // 추적이 효과적으로 ON 으로 전환되는 순간 (켜자마자 / 시커 닫고 부활) 즉시 카메라를 디바이스 마지막 위치로.
  // WS 다음 갱신 기다릴 필요 없음.
  useEffect(() => {
    if (!trackLive || filterDeviceId == null) return;
    const dev = devices.find(d => d.id === filterDeviceId);
    if (dev?.last_lat != null && dev?.last_lng != null) {
      mapRef.current?.panToCoord?.(dev.last_lat, dev.last_lng);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackLive, filterDeviceId]);

  // WS 핸들러는 첫 mount 의 클로저로 박혀있어 state 직접 못 봄 → ref 미러로 최신값 노출.
  const trackLiveRef       = useRef(trackLive);
  const filterDeviceIdRef  = useRef(filterDeviceId);
  // 시커 활성 여부 — 사용자 팬을 무시할지 결정용. (시커 조작 중 발생한 드래그가 사용자 의도 깨면 안 됨.)
  const seekerActiveRef    = useRef(false);
  useEffect(() => { trackLiveRef.current = trackLive; }, [trackLive]);
  useEffect(() => { filterDeviceIdRef.current = filterDeviceId; }, [filterDeviceId]);
  useEffect(() => {
    if (filterDeviceId == null) { setLiveSpeed(null); return; }
    const dev = devicesRef.current.find(d => d.id === filterDeviceId);
    const meta = lastMetaRef.current[filterDeviceId];
    setLiveSpeed(meta ? {
      deviceId: filterDeviceId,
      label: dev?.display_name || dev?.device_uid || `#${filterDeviceId}`,
      color: dev ? getDeviceColor(dev) : '#5B7CFF',
      speedKmh: meta.speedKmh,
      recordedAt: meta.recordedAt,
    } : null);
  }, [filterDeviceId]);
  useEffect(() => {
    seekerActiveRef.current = !!(showSeeker || showMiniSeeker);
  }, [showSeeker, showMiniSeeker]);

  // MiniSeekerOverlay 핸들러 — useCallback 으로 ref 안정화.
  // filterDeviceId 만 deps. WebSocket·devices 갱신에는 영향 X.
  // 월 wizard 지원을 위해 limit 을 365 로 확장 (1년 활동일).
  const seekerLoadDates = useCallback(() =>
    filterDeviceId == null
      ? Promise.resolve([])
      : api.getDailyStats(filterDeviceId, { limit: 365 })
          .then(rows => (rows || [])
            .filter(r => (r.fix_count || 0) > 0)
            .map(r => r.date)),
  [filterDeviceId]);

  const seekerLoadDayPoints = useCallback((d) =>
    filterDeviceId == null
      ? Promise.resolve([])
      : api.listLocations(filterDeviceId, {
          since: `${d}T00:00:00+09:00`,
          until: `${d}T23:59:59+09:00`,
          fix_only: true, limit: 5000,
        }),
  [filterDeviceId]);

  // 월 wizard 용 — 해당 월의 모든 fix 점 (sample 은 drawSeekerPath 가 maxMarkers 로 처리)
  const seekerLoadMonthPoints = useCallback((monthYM) => {
    if (filterDeviceId == null) return Promise.resolve([]);
    const [y, m] = monthYM.split('-').map(Number);
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    return api.listLocations(filterDeviceId, {
      since: `${monthYM}-01T00:00:00+09:00`,
      until: `${ny}-${String(nm).padStart(2, '0')}-01T00:00:00+09:00`,
      fix_only: true, limit: 10000,
    });
  }, [filterDeviceId]);

  // opts.dense=false (month 뷰) 는 마커 적당히 (sample ~150), true (day 뷰, 기본) 는 많이 (300).
  // 월 뷰는 maxMarkers 150 으로 — drawSeekerPath 가 균등 sampling 해서 일/시간대 분포가 가시화됨.
  // 폴리라인은 항상 full path 라 패턴 자체는 다 보임.
  const seekerOnPathChange = useCallback((pts, opts = {}) => {
    mapRef.current?.drawSeekerPath?.(pts, {
      maxMarkers: opts.dense === false ? 150 : 300,
      showCursor: false,
      timeColor: opts.dense !== false,
    });
  }, []);
  const seekerOnPathClear = useCallback(() =>
    mapRef.current?.clearSeekerPath?.(),
  []);
  const seekerOnSlotSelect = useCallback((p) => {
    const dev = devicesRef.current.find(d => d.id === filterDeviceId);
    const color = dev ? getDeviceColor(dev) : '#5B7CFF';
    mapRef.current?.setSeekerPin?.(p.lat, p.lng, color);
    mapRef.current?.panToCoord?.(p.lat, p.lng);
  }, [filterDeviceId]);

  useEffect(() => {
    const ws = new TrackerWS(handleWsEvent, setWsStatus);
    ws.connect(localStorage.getItem('access_token'));
    wsRef.current = ws;

    // 새로고침 호출 디바운스 — 30초 인터벌 + visibility/focus 이벤트가 동시에 떨어지면
    // 같은 API 가 한 번에 여러 번 호출되어 quota 낭비 + 백엔드 부하. 최소 8초 간격 보장.
    let lastRefreshAt = 0;
    const refresh = (force = false) => {
      const now = Date.now();
      if (!force && now - lastRefreshAt < 8000) return;
      lastRefreshAt = now;
      setTick(x => x + 1);
      loadDevicesIncremental();
      loadFences();
    };

    const t = setInterval(() => refresh(true), 30000);

    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    return () => {
      ws.disconnect();
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  async function loadDevicesIncremental() {
    try {
      const list = await api.listDevices();
      const oldIds = new Set(devRef.current.map(d => d.id));
      const newIds = new Set(list.map(d => d.id));
      oldIds.forEach(id => {
        if (!newIds.has(id)) {
          mapRef.current?.removeMarker(id);
          delete lastMetaRef.current[id];
        }
      });
      setDevices(list);
      devRef.current = list;
      wsRef.current?.subscribe(list.map(d => d.id));
      for (const d of list) {
        if (oldIds.has(d.id)) continue;
        const locs = await api.listLocations(d.id, { limit: 500, fix_only: true });
        if (!locs?.length) continue;
        const ordered = [...locs].reverse();
        const label = d.display_name || d.device_uid;
        const color = getDeviceColor(d);
        const stale = isStale(d.last_seen_at);
        ordered.forEach((loc, i) => {
          if (!loc.lat || !loc.lng) return;
          const isLast = (i === ordered.length - 1);
          const meta = isLast
            ? { recordedAt: loc.recorded_at, sat: loc.sat, vbatMv: loc.vbat_mv, fix: loc.fix, stale, heading: loc.heading, lat: loc.lat, lng: loc.lng, speedKmh: calcSpeedKmh(i > 0 ? { lat: ordered[i - 1].lat, lng: ordered[i - 1].lng, recordedAt: ordered[i - 1].recorded_at } : null, { lat: loc.lat, lng: loc.lng, recordedAt: loc.recorded_at }) }
            : { stale, recordedAt: loc.recorded_at };   // gap polyline 분리 위해 모든 점에 timestamp 전달
          mapRef.current?.updateMarker(d.id, loc.lat, loc.lng, label, color, meta);
          if (isLast) lastMetaRef.current[d.id] = meta;
        });
        mapRef.current?.clearHistoryPoints(d.id);
        const enriched = enrichWithSpeedStops(ordered);
        enriched.slice(0, -1).forEach(loc => {
          if (!loc.lat || !loc.lng) return;
          mapRef.current?.addHistoryPoint(d.id, loc.lat, loc.lng, color, {
            recordedAt: loc.recorded_at, sat: loc.sat, vbatMv: loc.vbat_mv, fix: loc.fix,
            speedKmh: loc._speed, isStop: loc._isStop,
          });
        });
      }
    } catch (e) { console.error('refresh', e); }
  }

  const loadDevices = useCallback(async () => {
    try {
      const targetIdRaw = new URLSearchParams(window.location.search).get('device');
      const targetId = targetIdRaw ? parseInt(targetIdRaw, 10) : NaN;

      const list = await api.listDevices();
      setDevices(list);
      setDevicesLoaded(true);
      devRef.current = list;
      wsRef.current?.subscribe(list.map(d => d.id));

      for (const d of list) {
        const locs = await api.listLocations(d.id, { limit: 500, fix_only: true });
        if (!locs?.length) continue;
        const ordered = [...locs].reverse();
        const label = d.display_name || d.device_uid;
        const color = getDeviceColor(d);
        const stale = isStale(d.last_seen_at);
        // 폴리라인/메인 마커 갱신용
        ordered.forEach((loc, i) => {
          if (!loc.lat || !loc.lng) return;
          const isLast = (i === ordered.length - 1);
          const meta = isLast
            ? { recordedAt: loc.recorded_at, sat: loc.sat, vbatMv: loc.vbat_mv, fix: loc.fix, stale, heading: loc.heading, lat: loc.lat, lng: loc.lng, speedKmh: calcSpeedKmh(i > 0 ? { lat: ordered[i - 1].lat, lng: ordered[i - 1].lng, recordedAt: ordered[i - 1].recorded_at } : null, { lat: loc.lat, lng: loc.lng, recordedAt: loc.recorded_at }) }
            : { stale, recordedAt: loc.recorded_at };   // gap polyline 분리 위해 모든 점에 timestamp 전달
          mapRef.current?.updateMarker(d.id, loc.lat, loc.lng, label, color, meta);
          if (isLast) lastMetaRef.current[d.id] = meta;
        });
        // 클릭 가능한 history dot 마커 — 마지막 점 제외 (메인 마커가 그 자리에 있음)
        mapRef.current?.clearHistoryPoints(d.id);
        const enriched = enrichWithSpeedStops(ordered);
        enriched.slice(0, -1).forEach(loc => {
          if (!loc.lat || !loc.lng) return;
          mapRef.current?.addHistoryPoint(d.id, loc.lat, loc.lng, color, {
            recordedAt: loc.recorded_at, sat: loc.sat, vbatMv: loc.vbat_mv, fix: loc.fix,
            speedKmh: loc._speed, isStop: loc._isStop,
          });
        });
      }
      // 사용자가 저장한 view 가 있으면 그걸 우선 복원. (focusDevice/fitToAllMarkers 가 setBounds 로 zoom 리셋하는 것 차단)
      const sv = userPrefsRef.current?.map_view;
      if (sv && sv.lat != null && sv.lng != null) {
        mapRef.current?.setView?.(sv.lat, sv.lng, sv.level);
      } else if (!isNaN(targetId)) {
        mapRef.current?.focusDevice(targetId);
      } else {
        mapRef.current?.fitToAllMarkers(60);
      }
    } catch (e) { console.error('loadDevices', e); }
  }, []);

  const handleMapReady = useCallback(() => {
    loadDevices(); loadFences(); loadGeofenceAlert();
    setMapReady(true);
  }, [loadDevices, loadFences, loadGeofenceAlert]);

  // 저장된 filter_device_id 복원 — devices/prefs/map 모두 준비됐을 때 1회.
  useEffect(() => {
    if (filterAppliedRef.current) return;
    if (!mapReady || !userPrefs || devices.length === 0) return;
    const stored = userPrefs.filter_device_id;
    if (stored != null && devices.some(d => d.id === stored)) {
      setFilterDeviceId(stored);
      // 저장된 map_view 가 있으면 filterToDevice 의 setBounds 로 zoom 리셋되지 않게 fit skip.
      const hasSavedView = userPrefs.map_view?.lat != null;
      mapRef.current?.filterToDevice(stored, { fit: !hasSavedView });
    }
    filterAppliedRef.current = true;
  }, [mapReady, userPrefs, devices]);

  // 사용자 액션으로 필터 변경 시 — 즉시 서버 저장 (race 방지).
  // 새로고침 사이에 PATCH 가 날아가지 않도록 디바운스 X.
  // 사용자가 디바이스를 선택하면 라이브 추적도 자동 ON (디바이스 따라가기 자연스러움).
  const persistFilterDevice = useCallback((id) => {
    setFilterDeviceId(id);
    mapRef.current?.filterToDevice(id);
    if (id !== null) setUserTrackPref(true);
    if (filterAppliedRef.current) {
      api.patchMyPrefs({ filter_device_id: id })
        .then(p => setUserPrefs(p))
        .catch(() => {});
    }
  }, []);

  // 사용자가 직접 지도를 드래그한 경우 — 추적 의도 자체를 끔. 다시 버튼 또는 디바이스 선택해야 부활.
  // 단, 시커 활성 중 발생한 드래그는 무시 — 시커 조작이 일으킨 이동까지 사용자 의도로 잡으면
  // 시커 닫고 나서 추적이 의도와 다르게 OFF 인 상태로 유지됨.
  const handleUserPan = useCallback(() => {
    if (seekerActiveRef.current) return;
    setUserTrackPref(false);
  }, []);

  // KakaoMap 이 사용자 조작 (drag/zoom) 으로 view 가 바뀌었음을 알려옴 → userPrefs 에 저장.
  // 초기 복원 중엔 저장 skip (filterAppliedRef.current === false 일 때).
  // 같은 값 재저장 방지 (네트워크 절약).
  const handleMapViewChange = useCallback((view) => {
    if (!filterAppliedRef.current) return;
    if (!view || view.lat == null || view.lng == null) return;
    const last = lastSavedMapViewRef.current;
    if (last
      && Math.abs(last.lat - view.lat) < 1e-6
      && Math.abs(last.lng - view.lng) < 1e-6
      && last.level === view.level) return;
    lastSavedMapViewRef.current = view;
    clearTimeout(mapViewSaveTimerRef.current);
    mapViewSaveTimerRef.current = setTimeout(() => {
      api.patchMyPrefs({ map_view: view }).catch(() => {});
    }, 1200);
  }, []);

  // 디바운스 useEffect — 안전장치 (다른 코드 경로에서 setFilterDeviceId 호출돼도 따라잡음)
  useEffect(() => {
    if (!filterAppliedRef.current) return;
    if (userPrefs && filterDeviceId === userPrefs.filter_device_id) return;
    clearTimeout(filterSaveTimerRef.current);
    filterSaveTimerRef.current = setTimeout(() => {
      api.patchMyPrefs({ filter_device_id: filterDeviceId })
        .then(p => setUserPrefs(p))
        .catch(() => {});
    }, 200);
  }, [filterDeviceId]);   // eslint-disable-line react-hooks/exhaustive-deps

  // 연구소: 디바이스 필터 (non-null) 시 어제 운행 요약 팝업.
  // 토글 OFF (default): 디바이스별 1회만 노출 (인트로). localStorage 키로 영구 기억.
  // 토글 ON: 디바이스를 잡을 때마다 매번 노출 (대신 OFF 로 돌아가도 다시 인트로는 안 봄).
  useEffect(() => {
    if (!me?.id) return;   // me 로드 전엔 key 가 'anon' 으로 잡혀 중복 노출 위험
    if (filterDeviceId == null) return;
    if (view !== 'home') return;   // 홈 탭에서 잡았을 때만
    const on = !!userPrefs?.lab_first_view_summary;
    const key = `lab_summary_seen:${me.id}:${filterDeviceId}`;
    // OFF 모드: 이미 본 적 있으면 skip
    if (!on && localStorage.getItem(key) === '1') return;
    // 마크 — 양쪽 모드 다 set (OFF 로 돌아가도 다시 인트로 안 보게)
    localStorage.setItem(key, '1');

    const KST = 9 * 3600 * 1000;
    const yesterday = new Date(Date.now() + KST - 86400000).toISOString().slice(0, 10);
    // 어제 통계 가져옴 — 없으면 "기록 없음" 으로 노출
    api.getDailyStats(filterDeviceId, { from: yesterday, to: yesterday, limit: 1 })
      .then(rows => {
        const stats = rows?.[0]?.date === yesterday ? rows[0] : null;
        const dev = devicesRef.current.find(d => d.id === filterDeviceId);
        setYesterdayDialog({
          deviceName: dev?.display_name || dev?.device_uid || '디바이스',
          dateStr: yesterday,
          stats,
        });
      })
      .catch(() => {
        // 통신 오류 — 그래도 팝업 한 번 (empty 모드).
        const dev = devicesRef.current.find(d => d.id === filterDeviceId);
        setYesterdayDialog({
          deviceName: dev?.display_name || dev?.device_uid || '디바이스',
          dateStr: yesterday,
          stats: null,
        });
      });
  }, [filterDeviceId, userPrefs?.lab_first_view_summary, view, me?.id]);

  // 펜스 항상 그리기 — fences/devices/showFences/geofenceAlert/filterDeviceId 변경 시 재계산.
  // 표시 조건: showFences AND geofenceAlert (master). 필터된 디바이스가 있으면 그에 맞는 펜스만.
  useEffect(() => {
    if (!mapRef.current) return;
    mapRef.current.clearAllGeofences();
    if (!showFences || !geofenceAlert) return;
    fences.forEach(f => {
      if (!f.active) return;
      // 장치 필터 존중: 특정 디바이스 선택 시 그 디바이스 또는 '전체 디바이스' 펜스만
      if (filterDeviceId !== null && f.device_id !== null && f.device_id !== filterDeviceId) return;
      const inside = isAnyDeviceInsideFence(f, devices);
      mapRef.current?.drawGeofence(
        f.id, f.center_lat, f.center_lng, f.radius_m, f.name, inside,
      );
    });
  }, [fences, devices, showFences, geofenceAlert, filterDeviceId]);

  function handleWsEvent(msg) {
    if (msg.type === 'location' && msg.fix && msg.lat && msg.lng) {
      const dev = devRef.current.find(d => d.id === msg.device_id);
      const label = dev?.display_name || dev?.device_uid || `#${msg.device_id}`;
      const color = getDeviceColor(dev || { id: msg.device_id });
      const prevMeta = lastMetaRef.current[msg.device_id];
      const speedKmh = msg.speed_kmh ?? msg.speedKmh ?? calcSpeedKmh(prevMeta, {
        lat: msg.lat, lng: msg.lng, recordedAt: msg.recorded_at,
      });
      const meta = {
        recordedAt: msg.recorded_at, sat: msg.sat, vbatMv: msg.vbat_mv,
        fix: msg.fix, stale: false, heading: msg.heading, speedKmh,
        lat: msg.lat, lng: msg.lng,
      };
      mapRef.current?.updateMarker(msg.device_id, msg.lat, msg.lng, label, color, meta);
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
  }

  // ── 디바이스 액션 ─────────────────────────
  async function handlePair() {
    setPairError('');
    let body = {};
    if (pairMode === 'iccid') {
      const v = pairIccid.trim();
      if (v.length < 8) { setPairError('SIM 번호는 8자리 이상'); return false; }
      body.iccid = v;
    } else {
      const v = pairUid.trim();
      if (!v) return false;
      body.device_uid = v;
    }
    const name = pairLabel.trim();
    if (!name) { setPairError('단말기명(별명)을 입력하세요. 알림에 사용됩니다.'); return false; }
    body.display_name = name;
    setPairLoading(true);
    try {
      await api.pairDevice(body);
      setPairUid(''); setPairIccid(''); setPairLabel('');
      await loadDevices();
      return true;
    } catch (e) { setPairError(e.message); return false; }
    finally { setPairLoading(false); }
  }

  async function handleRename(id) {
    try {
      await api.updateDevice(id, { display_name: editLabel.trim() });
      setEditId(null);
      await loadDevices();
    } catch (e) { alert(e.message); }
  }

  // 페어링 해제 모달 — 단일 모달에서 보관/삭제/취소 명시 선택
  const [unpairTarget, setUnpairTarget] = useState(null);  // device 또는 null
  const [unpairBusy, setUnpairBusy]     = useState(false);
  function handleUnpair(id) {
    const dev = devices.find(d => d.id === id);
    setUnpairTarget(dev || { id });
  }
  async function performUnpair(id, purge) {
    setUnpairBusy(true);
    try {
      await api.unpairDevice(id, { purge });
      mapRef.current?.removeMarker(id);
      delete lastMetaRef.current[id];
      await loadDevices();
      setUnpairTarget(null);
      await alertDialog({
        title: '페어링 해제 완료',
        body: purge
          ? '본인 데이터까지 영구 삭제됐습니다. 결제 이력 (포인트, SIM 충전, AI 분석) 은 보존.'
          : '데이터는 보관됐습니다. 같은 계정으로 다시 페어링하면 자동 복구됩니다.',
        tone: 'success',
      });
    } catch (e) {
      await alertDialog({ title: '실패', body: e.message, tone: 'danger' });
    } finally {
      setUnpairBusy(false);
    }
  }

  async function handlePickColor(deviceId, color) {
    setDeviceColorLocal(deviceId, color);
    mapRef.current?.setMarkerColor(deviceId, color);
    setDevices(prev => prev.map(d => d.id === deviceId ? { ...d, color } : d));
    setColorPickerId(null);
    try { await api.updateDevice(deviceId, { color }); } catch {}
  }

  // 로드뷰 가용성을 먼저 probe — 50m 반경 panoId 없으면 모달 안 열고 가벼운 토스트만.
  async function tryOpenRoadview(lat, lng) {
    const panoId = await probeRoadview(lat, lng);
    if (!panoId) {
      setToast('이곳은 로드뷰가 없습니다');
      return;
    }
    setRoadview({ lat, lng, panoId });
  }

  function openRoadview() {
    const c = mapRef.current?.getCurrentCenter();
    if (c) tryOpenRoadview(c.lat, c.lng);
  }

  // toast 1초 후 자동 dismiss
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 1000);
    return () => clearTimeout(id);
  }, [toast]);

  // ── 렌더 ─────────────────────────
  // 데스크톱은 좌측 SideRail + 중앙 Map + 우측 사이드 패널 (탭 활성 시)
  // 모바일/태블릿은 BottomNav + 풀스크린 오버레이 패널
  const mapVisible = isDesktop || view === 'home' || view === 'tools';

  // 패널 콘텐츠는 desktop aside 와 mobile overlay 양쪽에서 공유
  const panel = (
    <>

        {/* 단말기 */}
        {view === 'devices' && (
          <div style={s.page}>
            <div style={s.section}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: pairOpen ? 8 : 0 }}>
                <div style={{ ...s.sectionTitle, marginBottom: 0 }}>디바이스 추가</div>
                <button onClick={() => { setPairOpen(o => !o); setPairError(''); }}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '5px 10px', fontSize: 11, fontWeight: 600,
                    background: pairOpen ? 'var(--surface-2)' : 'var(--primary)',
                    color:      pairOpen ? 'var(--text)'      : 'var(--primary-fg)',
                    border: 'none', borderRadius: 6, cursor: 'pointer',
                  }}>
                  <Icon name={pairOpen ? 'close' : 'plus'} size={12} />
                  {pairOpen ? '닫기' : '추가'}
                </button>
              </div>

              {pairOpen && (
                <>
                  <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                    {[
                      { id: 'iccid', label: 'SIM 번호' },
                      { id: 'uid',   label: 'device_uid' },
                    ].map(t => {
                      const on = pairMode === t.id;
                      return (
                        <button key={t.id} onClick={() => setPairMode(t.id)} style={{
                          flex: 1, padding: 6, fontSize: 12, borderRadius: 4, cursor: 'pointer', border: 'none',
                          background: on ? 'var(--primary)' : 'var(--surface-2)',
                          color:      on ? 'var(--primary-fg)' : 'var(--text-2)',
                          fontWeight: on ? 600 : 400,
                        }}>{t.label}</button>
                      );
                    })}
                  </div>

                  {pairMode === 'iccid' ? (
                    <>
                      <input placeholder="SIM 끝 8자리 또는 전체 ICCID"
                        value={pairIccid}
                        onChange={e => setPairIccid(e.target.value.replace(/[^0-9A-Fa-f]/g, ''))}
                        style={s.input} />
                      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                        OLED 첫 줄 「SIM ...12345678」 의 숫자
                      </div>
                    </>
                  ) : (
                    <input placeholder="device_uid  예) esp-aabbccddeeff"
                      value={pairUid} onChange={e => setPairUid(e.target.value)}
                      style={s.input} />
                  )}
                  <input placeholder="단말기 별명 (필수, 예: 1호차)"
                    value={pairLabel} required maxLength={32}
                    onChange={e => setPairLabel(e.target.value)}
                    style={{ ...s.input, marginTop: 6 }} />
                  {pairError && <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 4 }}>{pairError}</div>}
                  <button onClick={async () => { const ok = await handlePair(); if (ok) setPairOpen(false); }} disabled={pairLoading}
                    style={{ ...s.btn, marginTop: 8, opacity: pairLoading ? 0.6 : 1 }}>
                    {pairLoading ? '...' : '페어링'}
                  </button>
                </>
              )}
            </div>

            <div style={s.sectionTitle}>내 디바이스 ({devices.length})</div>
            {devices.length === 0 && (
              <div style={{ color: 'var(--text-3)', fontSize: 13, padding: '8px 0' }}>
                아직 등록된 디바이스가 없습니다.
              </div>
            )}

            {devices.map(d => {
              const color = getDeviceColor(d);
              const stale = isStale(d.last_seen_at);
              const meta  = lastMetaRef.current[d.id];
              const status = classifyDevice(d, meta);

              return (
                <div key={d.id} style={{
                  ...s.deviceCard, borderLeft: `4px solid ${color}`,
                  opacity: stale && status.id !== 'sleeping' ? 0.6 : 1,
                }}>
                  {editId === d.id ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input value={editLabel} onChange={e => setEditLabel(e.target.value)}
                        style={{ ...s.input, flex: 1 }} autoFocus />
                      <button onClick={() => handleRename(d.id)} style={s.smallBtn}>저장</button>
                      <button onClick={() => setEditId(null)} style={{ ...s.smallBtn, background: 'var(--surface-2)', color: 'var(--text)' }}>취소</button>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div onClick={() => {
                          // 데스크톱은 패널 유지 (지도가 옆에 보임). 모바일은 home 으로 전환해야
                          // 지도가 보이므로 그때만 view 변경.
                          if (!isDesktop) setView('home');
                          persistFilterDevice(d.id);
                        }}
                          style={{ flex: 1, cursor: 'pointer', minWidth: 0 }}>
                          <div style={{ fontWeight: 'bold', fontSize: 14, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span>{d.display_name || d.device_uid}</span>
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', gap: 4,
                              padding: '1px 7px', borderRadius: 8,
                              background: 'var(--surface-2)',
                              fontSize: 10, fontWeight: 500,
                              color: status.color,
                              border: `1px solid ${status.color}33`,
                            }}>
                              <span style={{ width: 6, height: 6, borderRadius: 3, background: status.color }} />
                              {status.label}
                            </span>
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{d.device_uid}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                                  title="마지막 LTE 통신">
                              <Icon name="refresh" size={11} /> {ageString(d.last_seen_at)}
                            </span>
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', gap: 4,
                              color: isFixStale(d.last_fix_at) ? 'var(--danger)' : undefined,
                            }} title="마지막 GPS 좌표 수신">
                              <Icon name="mapPin" size={11} /> {ageString(d.last_fix_at)}
                            </span>
                            {meta?.vbatMv && (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <Icon name="battery" size={11} /> {meta.vbatMv}mV
                              </span>
                            )}
                            {meta?.sat !== undefined && meta?.sat !== null && (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <Icon name="sat" size={11} /> sat {meta.sat}
                              </span>
                            )}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }}>
                          <button onClick={() => setDetailId(detailId === d.id ? null : d.id)}
                            style={{
                              ...s.detailBtn,
                              ...(detailId === d.id ? s.detailBtnActive : {}),
                            }}
                            title="통계 / 상세 정보">
                            <Icon name="bar" size={13} />
                            <span>통계</span>
                          </button>
                          <button onClick={() => setColorPickerId(colorPickerId === d.id ? null : d.id)}
                            style={{ background: color, width: 18, height: 18, borderRadius: 9, padding: 0,
                                     border: '2px solid var(--surface)', boxShadow: '0 0 0 1px var(--border)',
                                     cursor: 'pointer', flexShrink: 0 }}
                            title="색상 변경" />
                          <button onClick={() => { setEditId(d.id); setEditLabel(d.display_name || ''); }}
                            style={s.iconBtnSmall} title="이름 변경"><Icon name="edit" size={13} /></button>
                          <button onClick={() => handleUnpair(d.id)}
                            style={{ ...s.iconBtnSmall, color: 'var(--danger)' }} title="페어링 해제"><Icon name="unlink" size={13} /></button>
                        </div>
                      </div>

                      {colorPickerId === d.id && (
                        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                          {PALETTE.map(c => (
                            <button key={c} onClick={() => handlePickColor(d.id, c)}
                              style={{
                                width: 24, height: 24, borderRadius: 12, padding: 0,
                                background: c, border: c === color ? '2px solid var(--text)' : '1px solid var(--border)',
                                cursor: 'pointer',
                              }} />
                          ))}
                        </div>
                      )}

                      {detailId === d.id && (
                        <DeviceDetail device={d} onWiped={async (id) => {
                          mapRef.current?.removeMarker(id);
                          delete lastMetaRef.current[id];
                          setDetailId(null);
                          await loadDevices();
                        }} />
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* 내정보 — 서브탭 (계정 / 포인트 / 채팅 / 알림 / 테마) 은 ProfilePanel 내부 */}
        {view === 'profile' && (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <ProfilePanel onLogout={onLogout} />
          </div>
        )}

        {/* 관리자 비-admin 시 권한 안내 (admin 본 화면은 main 레벨에서 풀-화면으로 따로 렌더) */}
        {view === 'admin' && !isAdmin && (
          <div style={s.page}>
            <div style={s.section}>
              <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-2)' }}>
                권한이 없습니다.
              </div>
            </div>
          </div>
        )}
    </>
  );

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: isDesktop ? 'row' : 'column' }}>

      {/* 데스크톱 좌측 사이드 레일 */}
      {isDesktop && <SideRail active={view} onChange={setView} isAdmin={isAdmin} isCorporate={isCorporate} />}

      <main style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'row', minWidth: 0 }}>

        {/* 관리자 본문 — admin 일 땐 지도/사이드패널 모두 숨기고 풀-화면 차지 */}
        {view === 'admin' && isAdmin && (
          <div style={{
            flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
          }}>
            <AdminDashboard />
          </div>
        )}

        {/* 법인운행 본문 — admin 과 동일한 풀-화면 레이아웃 */}
        {view === 'corporate' && isCorporate && (
          <div style={{
            flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
          }}>
            <CorporatePanel devices={devices} />
          </div>
        )}

        {/* 데스크톱 사이드바 패널 — SideRail 바로 옆에서 확장.
            home/tools/admin/corporate 제외 탭일 때만 슬라이드 인.
            tools 는 home 과 동일하게 지도+FAB 만 — sheet 가 좌하단 floating 으로 뜸. */}
        {view !== 'admin' && view !== 'corporate' && isDesktop && view !== 'home' && view !== 'tools' && (
          <aside style={{
            width: 400, flexShrink: 0,
            background: 'var(--surface)',
            borderRight: '1px solid var(--border)',
            display: 'flex', flexDirection: 'column',
            animation: 'slideInLeft .18s ease-out',
          }}>
            {panel}
          </aside>
        )}

        {/* 지도 영역 — admin 이면 display:none (마운트 유지, 화면에서 제거).
            데스크톱은 항상, 모바일/태블릿은 home 일 때만 시각적 노출 */}
        <div style={{
          flex: 1, position: 'relative', minWidth: 0,
          display: ((view === 'admin' && isAdmin) || (view === 'corporate' && isCorporate)) ? 'none' : 'block',
        }}>
          <div style={{ position: 'absolute', inset: 0, visibility: mapVisible ? 'visible' : 'hidden' }}>
            <KakaoMap ref={mapRef} onReady={handleMapReady}
              onRoadview={({ lat, lng }) => tryOpenRoadview(lat, lng)}
              // 지도 마커 클릭 → 모바일: 컴팩트 PointInfoSheet + 간이 시커 슬롯 동기화 동시.
              // 데스크톱 기본: kakao InfoWindow 유지 (onPointInfo 미제공 → KakaoMap 내부 fallback).
              // 데스크톱 + 간이 시커 활성: 마커 click 활성 위해 핸들러 제공 (drawSeekerPath 가
              //   `clickable: !!onPointInfoRef.current` 로 마커를 만들기 때문에).
              //   handler 의 setPointInfo 는 desktop 에선 PointInfoSheet 미렌더라 무해.
              onPointInfo={(!isDesktop || showMiniSeeker) ? (info) => {
                setPointInfo(info);
                if (showMiniSeeker && info?.meta?.recordedAt) {
                  const dev = devicesRef.current.find(d => d.id === filterDeviceId);
                  const color = dev ? getDeviceColor(dev) : '#5B7CFF';
                  mapRef.current?.setSeekerPin?.(info.lat, info.lng, color);
                  miniSeekerRef.current?.selectByTime(info.meta.recordedAt, { skipPin: true });
                }
              } : undefined}
              onUserPan={handleUserPan}
              onViewChange={handleMapViewChange} />
            <MapControls mapRef={mapRef} onOpenRoadview={openRoadview} />
            {devices.length > 0 && (
              <DeviceFilter
                devices={devices}
                selected={filterDeviceId}
                onChange={persistFilterDevice}
              />
            )}
            {view === 'home' && trackLive && filterDeviceId !== null && (() => {
              // 알약 항상 표시 — liveSpeed 가 아직 없을 때도 device 정보로 fallback.
              // WS msg 한 번도 안 받았거나 sleep 중이라 데이터 없어도 운영자가 기능 인지 가능.
              const dev = devices.find(d => d.id === filterDeviceId);
              const label = liveSpeed?.label || dev?.display_name || dev?.device_uid || '실시간 추적';
              const color = liveSpeed?.color || (dev ? getDeviceColor(dev) : '#5B7CFF');
              const speedKmh = liveSpeed?.speedKmh;
              return (
                <div style={{
                  position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)',
                  zIndex: 13, minWidth: 168, padding: '10px 14px', borderRadius: 16,
                  background: 'rgba(255,255,255,.94)', border: '1px solid var(--border)',
                  boxShadow: '0 8px 24px rgba(15,23,42,.18)', display: 'flex',
                  alignItems: 'center', gap: 10, backdropFilter: 'blur(10px)', pointerEvents: 'none',
                }}>
                  <span style={{
                    width: 10, height: 10, borderRadius: 999, flexShrink: 0,
                    background: color || speedTone(speedKmh),
                    boxShadow: '0 0 0 4px rgba(59,130,246,.12)',
                  }} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                    <span style={{
                      maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      fontSize: 11, fontWeight: 700, color: 'var(--text-2)',
                    }}>{label}</span>
                    <span style={{
                      fontSize: 24, lineHeight: 1, fontWeight: 800, letterSpacing: '-.03em',
                      fontVariantNumeric: 'tabular-nums', color: speedTone(speedKmh),
                    }}>
                      {speedKmh == null ? '--' : Math.round(speedKmh)}
                      <small style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)' }}> km/h</small>
                    </span>
                  </div>
                </div>
              );
            })()}

            {/* 홈 — 지도 가장자리 활용 지오펜스 레이어.
                  우하단 FAB 칼럼: 펜스 ON/OFF 토글 + 새 펜스 만들기 (토글 ON 일 때만)
                  좌하단: 등록된 펜스 목록 (scrollable, 토글 ON 일 때만)
                  showFences 가 토글의 상태 — 기존 지도 펜스 원 표시 플래그와 공유.
                  알람 토글 / 이력 탭은 풀 기능 '운행' 탭의 GeofenceSheet 에. */}
            {view === 'home' && (() => {
              const stripLift = showMiniSeeker ? MINI_SEEKER_BOTTOM_HEIGHT : 0;
              // 툴팁: 모바일·PC 모두 좌측 패널 옆에 떠 — 펜스 list 와 같은 좌측 영역 점유.
              // FAB lift 는 모바일만 (PC 는 FAB 가 우측이라 충돌 X).
              // FenceList lift 는 양쪽 — tooltip 위쪽으로 list 띄움.
              const tooltipLiftForFab  = (!isDesktop && pointInfo && showMiniSeeker) ? 120 : 0;
              const tooltipLiftForList = (pointInfo && showMiniSeeker) ? 120 : 0;
              const fabBottom = (isDesktop ? 24 : 16) + stripLift + tooltipLiftForFab;
              return (
                <HomeFenceQuick
                  devices={devices}
                  mapRef={mapRef}
                  fences={fences}
                  onChange={loadFences}
                  filterDeviceId={filterDeviceId}
                  bottomLift={stripLift + tooltipLiftForList}
                  fabBottom={fabBottom}
                  enabled={showFences}
                  onToggleEnabled={setShowFences}
                  listSide={isDesktop ? 'right' : 'left'}
                />
              );
            })()}

            {/* FAB 위치 보정:
                - sheet(SeekerSheet/GeofenceSheet) 가 열린 모바일: 슬라이드 아웃 (가림 방지)
                - 컴팩트 시커 활성: 하단 strip 만큼 위로 (안 가려지게)
                - 간이 시커 + 툴팁 동시: 툴팁 높이만큼 추가로 위로 (가림 방지)
                - 홈: 펜스 토글 ON 시 + 펜스 FAB (+60 slot) 가 등장 → 위쪽 시커/라이브 FAB 를 60px 위로 밀어냄.
                  기본은 시커가 펜스 토글 바로 위 (붙어있음). */}
            {(() => {
              const sheetOpen = !isDesktop && (showSeeker || showGeofence);
              const stripLift = (showMiniSeeker && view === 'home') ? MINI_SEEKER_BOTTOM_HEIGHT : 0;
              const tooltipLift = (!isDesktop && pointInfo && showMiniSeeker && view === 'home') ? 120 : 0;
              const baseBottom = (isDesktop ? 24 : 16) + stripLift + tooltipLift;
              // 홈 펜스 cluster 점유: 펜스 토글(+0) 위에 + 펜스(+60) 가 있으면 그 위 슬롯들 60px 위로.
              const fenceCreatorLift = (view === 'home' && showFences) ? 60 : 0;
              const fabTransform = sheetOpen ? 'translateX(80px)' : 'none';
              const fabOpacity   = sheetOpen ? 0 : 1;
              const fabPointer   = sheetOpen ? 'none' : 'auto';
              const fabTransition = 'background .15s, color .15s, bottom .22s ease, transform .22s ease, opacity .18s ease';
              return (
                <>
                  {/* 라이브 추적 FAB — target 아이콘.
                      색상은 userTrackPref(사용자 의도) 반영 — 시커가 일시 정지 중이라도 ON 으로 보임 (시커 닫히면 즉시 부활).
                      paused 면 미세하게 작은 구분선 표시. */}
                  {view === 'home' && filterDeviceId !== null && (
                    <button onClick={() => setUserTrackPref(p => !p)}
                      className="btn-bounce"
                      style={{
                      position: 'absolute', right: 16,
                      // 기본 시커(+60) 위 = +120. 펜스 ON 시 +180 으로 위로 밀림.
                      bottom: baseBottom + 120 + fenceCreatorLift,
                      width: 48, height: 48, borderRadius: 24,
                      background: userTrackPref ? 'var(--accent)' : 'var(--surface)',
                      color:      userTrackPref ? 'white' : 'var(--accent)',
                      border: userTrackPref ? 'none' : '1px solid var(--border)',
                      cursor: 'pointer',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      boxShadow: '0 4px 12px rgba(0,0,0,.25)',
                      zIndex: 12,
                      transform: fabTransform, opacity: fabOpacity, pointerEvents: fabPointer,
                      transition: fabTransition,
                      // 시커로 일시 정지 중일 때만 약간 흐려 보이게 — 사용자 의도는 ON 이지만 잠시 멈춤.
                      filter: (userTrackPref && seekerPaused) ? 'saturate(0.5)' : 'none',
                    }} title={
                      !userTrackPref ? '라이브 추적 켜기'
                      : seekerPaused ? '추적 ON (시커로 일시 정지)'
                      : '추적 끄기'}>
                      <Icon name="target" size={20} />
                    </button>
                  )}

                  {/* 패널 시커 FAB — '운행' 탭에서만 노출. SeekerSheet (full panel) 띄움.
                      이전에는 home 에 있었지만 지도를 가린다는 UX 저하로 별도 탭으로 이전. */}
                  {view === 'tools' && filterDeviceId !== null && (
                    <button onClick={() => {
                      if (!isDesktop && !showSeeker) setShowGeofence(false);
                      if (!showSeeker) setShowMiniSeeker(false);  // mini 와 mutex
                      setShowSeeker(s => !s);
                    }}
                      className="btn-bounce"
                      style={{
                      position: 'absolute', right: 16,
                      bottom: baseBottom + 120,
                      width: 48, height: 48, borderRadius: 24,
                      background: showSeeker ? 'var(--primary)' : 'var(--surface)',
                      color:      showSeeker ? 'var(--primary-fg)' : 'var(--primary)',
                      border: showSeeker ? 'none' : '1px solid var(--border)',
                      cursor: 'pointer',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      boxShadow: '0 4px 12px rgba(0,0,0,.25)',
                      zIndex: 12,
                      transform: fabTransform, opacity: fabOpacity, pointerEvents: fabPointer,
                      transition: fabTransition,
                    }} title="시커 (패널)">
                      <Icon name="route" size={20} />
                    </button>
                  )}

                  {/* 컴팩트 시커 FAB — clock 아이콘. 좌/하단 미니멀 오버레이.
                      활성 상태에서도 (이전처럼) 사라지지 않음. 지오펜스 열림 시는 슬라이드 아웃.
                      슬롯 +120: 위로 trackLive(+180), 아래로 fence cluster (+60 creator, +0 toggle)
                      과 시각적 구분 — fence 가 OFF 면 slot +60 이 비어 자연스럽게 cluster 가 분리됨. */}
                  {view === 'home' && filterDeviceId !== null && (
                    <button onClick={() => {
                      if (!showMiniSeeker) {
                        // 지오펜스/패널 시커와 mutex
                        setShowGeofence(false);
                        setShowSeeker(false);
                      }
                      setShowMiniSeeker(s => !s);
                    }}
                      className="btn-bounce"
                      style={{
                      position: 'absolute', right: 16,
                      // 기본 +60 (펜스 토글 바로 위, 붙어있음). 펜스 ON → +120 으로 위로 밀림.
                      bottom: baseBottom + 60 + fenceCreatorLift,
                      width: 48, height: 48, borderRadius: 24,
                      background: showMiniSeeker ? 'var(--primary)' : 'var(--surface)',
                      color:      showMiniSeeker ? 'var(--primary-fg)' : 'var(--primary)',
                      border: showMiniSeeker ? 'none' : '1px solid var(--border)',
                      cursor: 'pointer',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      boxShadow: '0 4px 12px rgba(0,0,0,.25)',
                      zIndex: 12,
                      // mini 활성 시는 사라지지 X. 다른 sheet (지오펜스 또는 패널 시커) 열린 경우만 슬라이드 아웃.
                      transform: (!isDesktop && (showGeofence || showSeeker)) ? 'translateX(80px)' : 'none',
                      opacity:   (!isDesktop && (showGeofence || showSeeker)) ? 0 : 1,
                      pointerEvents: (!isDesktop && (showGeofence || showSeeker)) ? 'none' : 'auto',
                      transition: fabTransition,
                    }} title="컴팩트 시커">
                      <Icon name="clock" size={20} />
                    </button>
                  )}

                  {/* 지오펜스 FAB — '운행' 탭에서만 노출. */}
                  {view === 'tools' && (
                    <button onClick={() => {
                      if (!isDesktop && !showGeofence) setShowSeeker(false);
                      if (!showGeofence) setShowMiniSeeker(false);  // mini 와 mutex
                      setShowGeofence(s => !s);
                    }}
                      className="btn-bounce"
                      style={{
                      position: 'absolute', right: 16,
                      bottom: baseBottom,
                      width: 48, height: 48, borderRadius: 24,
                      background: showGeofence ? 'var(--primary)' : 'var(--surface)',
                      color:      showGeofence ? 'var(--primary-fg)' : 'var(--primary)',
                      border: showGeofence ? 'none' : '1px solid var(--border)',
                      cursor: 'pointer',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      boxShadow: '0 4px 12px rgba(0,0,0,.25)',
                      zIndex: 12,
                      transform: fabTransform, opacity: fabOpacity, pointerEvents: fabPointer,
                      transition: fabTransition,
                    }} title="지오펜스">
                      <Icon name="fence" size={20} />
                    </button>
                  )}
                </>
              );
            })()}

            {/* 지오펜스 윈도우 — '운행' 탭에서만, 데스크톱은 우상단 floating, 모바일은 bottom sheet */}
            {showGeofence && view === 'tools' && (
              <GeofenceSheet
                devices={devices} mapRef={mapRef}
                fences={fences} onChange={loadFences}
                showFences={showFences} onToggleShow={setShowFences}
                alertEnabled={geofenceAlert} onToggleAlert={toggleGeofenceAlert}
                filterDeviceId={filterDeviceId}
                onClose={() => setShowGeofence(false)} />
            )}

            {/* 시커 윈도우 — '운행' 탭에서만, 데스크톱은 좌하단 floating */}
            {showSeeker && view === 'tools' && filterDeviceId !== null && (
              <SeekerSheet
                device={devices.find(d => d.id === filterDeviceId)}
                mapRef={mapRef}
                onClose={() => {
                  setShowSeeker(false);
                  mapRef.current?.clearSeekerPath();
                }} />
            )}

            {/* 마커 클릭 sheet — home 화면 위에서만 의미.
                · 모바일: 항상 (compact 는 시커 활성 시)
                · 데스크톱: 시커 활성 시만 (시커 OFF 일 땐 kakao InfoWindow 가 fallback). */}
            {(!isDesktop || showMiniSeeker) && pointInfo && view === 'home' && (
              <PointInfoSheet
                info={pointInfo}
                onClose={() => setPointInfo(null)}
                onRoadview={({ lat, lng }) => { setPointInfo(null); tryOpenRoadview(lat, lng); }}
                compact={showMiniSeeker}
                bottomOffset={showMiniSeeker ? MINI_SEEKER_BOTTOM_HEIGHT : 0}
                leftOffset={showMiniSeeker ? 100 : 0}
              />
            )}

            {/* 컴팩트 시커 오버레이 — home + 디바이스 필터, 패널 시커/지오펜스 중복 X.
                월/일/시간 3-phase wizard 통합 (구 HomeMapSeeker 흡수). */}
            {showMiniSeeker && view === 'home' && filterDeviceId !== null && (
              <MiniSeekerOverlay
                ref={miniSeekerRef}
                loadDates={seekerLoadDates}
                loadDayPoints={seekerLoadDayPoints}
                loadMonthPoints={seekerLoadMonthPoints}
                onPathChange={seekerOnPathChange}
                onPathClear={seekerOnPathClear}
                onSlotSelect={seekerOnSlotSelect} />
            )}
          </div>

          {/* 모바일/태블릿: home/tools/admin/corporate 제외 탭은 지도 위에 풀스크린 오버레이로.
              tools 는 home 처럼 지도 노출 — 시커/지오펜스 sheet 가 지도 위 bottom sheet 로 떠야 함. */}
          {!isDesktop && view !== 'home' && view !== 'tools' && view !== 'admin' && view !== 'corporate' && (
            <div style={{
              position: 'absolute', inset: 0,
              background: 'var(--surface)',
              display: 'flex', flexDirection: 'column',
              // status bar 여백은 상위 컨테이너(브라우저 URL 바 / Flutter SafeArea)가 이미 처리.
              // 여기에 env(safe-area-inset-top) 을 또 더하면 이중 padding 으로 헤더가 멀어짐.
            }}>
              {panel}
            </div>
          )}
        </div>
      </main>

      {/* 모바일/태블릿 바텀 네비 */}
      {!isDesktop && <BottomNav active={view} onChange={setView} isAdmin={isAdmin} isCorporate={isCorporate} />}

      {/* 로드뷰 모달 — 호출 측이 probeRoadview() 로 panoId 확보 후에만 마운트 */}
      {roadview && (
        <RoadviewModal
          lat={roadview.lat} lng={roadview.lng} panoId={roadview.panoId}
          onClose={() => setRoadview(null)} />
      )}

      {/* 가벼운 중앙 토스트 — 1초 자동 dismiss */}
      {toast && (
        <div style={{
          position: 'fixed', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'rgba(0,0,0,0.78)', color: '#fff',
          padding: '10px 18px', borderRadius: 8,
          fontSize: 13, fontWeight: 500,
          zIndex: 9999, pointerEvents: 'none',
          animation: 'toastFade 1s ease forwards',
        }}>{toast}</div>
      )}

      {/* 연구소 — 어제 운행 요약 팝업 */}
      {yesterdayDialog && (
        <YesterdaySummaryDialog
          deviceName={yesterdayDialog.deviceName}
          dateStr={yesterdayDialog.dateStr}
          stats={yesterdayDialog.stats}
          onClose={() => setYesterdayDialog(null)}
        />
      )}

      {/* 페어링 해제 모달 — 보관/삭제/취소 명시 선택 */}
      {unpairTarget && (
        <UnpairModal
          deviceName={unpairTarget.display_name || unpairTarget.device_uid || `디바이스 #${unpairTarget.id}`}
          busy={unpairBusy}
          onClose={() => !unpairBusy && setUnpairTarget(null)}
          onKeep={() => performUnpair(unpairTarget.id, false)}
          onWipe={() => performUnpair(unpairTarget.id, true)}
        />
      )}

      {/* 페어링 튜토리얼 — /devices/pair 진입 + 디바이스 0개 (또는 ?tutorial=1) */}
      {pairTutorialOpen && (
        <PairTutorial
          onClose={() => setPairTutorialOpen(false)}
          onStart={() => {
            setPairTutorialOpen(false);
            // pair modal 은 이미 열려있음 (deep link 처리에서 setPairOpen(true))
            // ICCID 입력 필드로 포커스 보내기
            setTimeout(() => {
              const el = document.querySelector('input[placeholder*="ICCID"]');
              if (el) el.focus();
            }, 50);
          }}
        />
      )}
    </div>
  );
}

const s = {
  page: {
    flex: 1, minHeight: 0,
    overflowY: 'auto', padding: 16, paddingBottom: 24,
    // 부모 패널이 surface 흰색이라 같은 색으로 통일. (이전엔 var(--bg) 였음.)
    background: 'var(--surface)',
  },
  section: {
    // 흰 패널 위에 흰 카드 → 테두리로 위젯 분리.
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 10, padding: 12, marginBottom: 16,
  },
  sectionTitle: {
    fontWeight: 700, fontSize: 12, color: 'var(--text-2)',
    textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8,
  },
  input: {
    display: 'block', width: '100%', padding: '8px 10px',
    background: 'var(--surface-2)', border: '1px solid var(--border)',
    borderRadius: 6, fontSize: 13, boxSizing: 'border-box',
  },
  btn: {
    display: 'block', width: '100%', padding: 10,
    background: 'var(--primary)', color: 'var(--primary-fg)',
    border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 13,
  },
  smallBtn: {
    padding: '6px 12px', background: 'var(--primary)', color: 'var(--primary-fg)',
    border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 12,
  },
  tinyBtn: {
    background: 'transparent', border: 'none', cursor: 'pointer',
    fontSize: 16, padding: '2px 4px',
  },
  iconBtn: {
    background: 'transparent', border: 'none', cursor: 'pointer',
    color: 'var(--text-2)',
    width: 28, height: 28, borderRadius: 6,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    transition: 'background .15s, color .15s',
  },
  iconBtnSmall: {
    background: 'transparent', border: 'none', cursor: 'pointer',
    color: 'var(--text-3)',
    width: 22, height: 22, borderRadius: 5,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    transition: 'color .15s',
  },
  detailBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '5px 10px', borderRadius: 6,
    background: 'var(--primary)', color: 'var(--primary-fg)',
    border: 'none', cursor: 'pointer',
    fontSize: 12, fontWeight: 600,
    boxShadow: '0 1px 2px rgba(59,130,246,0.25)',
    transition: 'background .15s, transform .05s',
  },
  detailBtnActive: {
    background: 'var(--text)', color: 'var(--surface)',
  },
  deviceCard: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8, padding: 10, marginBottom: 8,
    transition: 'opacity .2s',
  },
};
