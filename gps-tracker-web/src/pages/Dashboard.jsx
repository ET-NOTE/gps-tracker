import {useQuery} from '@tanstack/react-query';
import { dashboardView, routeAccess } from '../lib/dashboardRoutes';
import RouteNotice from '../components/RouteNotice';
import RoutePlannerSheet from '../components/RoutePlannerSheet';
import PinnedDeviceWidget from '../components/PinnedDeviceWidget';
import OnboardingModal from '../components/OnboardingModal';
import { authScope, assertSession } from '../authSession';
import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { activeStorage, api } from '../api';
import { useMe, useAccountType, useDevices } from '../state';
import { EMPTY_DEVICES, loadDeviceSnapshot, cancelDeviceSnapshot, updateDeviceList } from '../state/devices';
import { useLiveWS } from '../hooks/useLiveWS';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import { makeWsEventHandler } from '../lib/wsEventHandler';
import { makeDeviceLoaders } from '../lib/deviceLoader';
import KakaoMap from '../components/KakaoMap';
import { PlatformRail, PlatformHeader, PortalDeviceList, PortalAccount } from '../components/portal/Portal';
import {WorkspaceHeaderContext} from '../components/business/WorkspaceHeader';
import DeviceServiceSettings from '../components/portal/DeviceServiceSettings';
import { rememberFleetOwner } from '../lib/fleetSession';
import { ownerServices, businessServices, rememberView, classifyOwnedDevices } from '../lib/platformNavigation';
import { validPosition } from '../lib/businessWorkspace';
import DeviceDetail from '../components/DeviceDetail';
import {DeviceTechnicalInfo} from '../components/DeviceCardSummary';
import PortalTerminalDetails from '../components/portal/PortalTerminalDetails';
import { sideRailItems } from '../components/SideRail';
import MapTopOverlay from '../components/MapTopOverlay';
import MapControls from '../components/MapControls';
import MapDeviceCard from '../components/portal/MapDeviceCard';
import DeviceMapMarkers from '../components/portal/DeviceMapMarkers';
import Modal from '../components/ui/Modal';
import MapActions from '../components/MapActions';
import { useHomeMapTools } from '../hooks/useHomeMapTools';
import { useNativeTracking } from '../hooks/useNativeTracking';
import RoadviewModal, { probeRoadview } from '../components/RoadviewModal';
import { confirmDialog, alertDialog } from '../components/Dialog';
import GeofenceSheet from '../components/GeofenceSheet';
import SeekerSheet from '../components/SeekerSheet';
import MiniSeekerOverlay, { MINI_SEEKER_BOTTOM_HEIGHT, MINI_SEEKER_PANEL_WIDTH } from '../components/MiniSeekerOverlay';
import HomeFenceQuick from '../components/HomeFenceQuick';
import YesterdaySummaryDialog from '../components/YesterdaySummaryDialog';
import PointInfoSheet from '../components/PointInfoSheet';
// admin / corporate 는 해당 사용자만 진입 — 초기 bundle 에서 제외.
const AdminDashboard = lazy(() => import('../components/AdminDashboard'));
const CorporatePanel = lazy(() => import('../components/CorporatePanel'));
const RentcarPanel   = lazy(() => import('../components/RentcarPanel'));
const RentalStaffDesk = lazy(() => import('../components/business/RentalStaffDesk'));
const DeliveryPanel  = lazy(() => import('../components/DeliveryPanel'));
const LazyPanelFallback = () => (
  <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
    로딩 중…
  </div>
);
import PairTutorial, { shouldShowPairTutorial, hydratePairTutorialSeen } from '../components/PairTutorial';
import UnpairModal from '../components/UnpairModal';
import Icon from '../components/Icon';
import SimRegistrationHelp from '../components/SimRegistrationHelp';
import { readDeviceLink, useDeviceDeepLink } from '../hooks/useDeviceDeepLink';
import useBreakpoint from '../useBreakpoint';
import { PALETTE, getDeviceColor, hydrateDeviceColors, setDeviceColorCache, getDeviceColorsCache, classifyDevice } from '../colors';
import { applyTheme, currentTheme } from '../theme';
import { isSeekerVisible, normalizeAggregates, monthWindow } from '../lib/seeker';

// 펜스에 적용 단말기 한 대라도 안에 있으면 true.
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
//   /profile*               → 'profile'
// Supported dashboard paths are resolved exactly by dashboardRoutes.
function viewToPath(v) {
  return v === 'home' ? '/' : v === 'delivery' ? '/cargo' : `/${v}`;
}
// (F6-a-3) 다음 helpers 는 lib/deviceLoader.js 로 이동:
//   calcSpeedKmh · computeHomeSinceISO · POLYLINE_GAP_THRESHOLD_S · computeGapMap ·
//   clickableIntervalM · computeClickableIndices · HOME_STOP_MERGE_RADIUS_M

export default function Dashboard({ onLogout }) {
  const location = useLocation();
  const navigate = useNavigate();
  const view = dashboardView(location.pathname);
  const setView = useCallback((v) => {
    navigate(viewToPath(v));
  }, [navigate]);
  // Only the map visit carries its origin. Browser Back returns to the original
  // location key; a new visit to /corporate or / starts with its own state.
  const sessionId = activeStorage()?.getItem('auth_session');
  const mapVisit = location.state?.corporateVehicleMap;
  const cargoOrigin=location.state?.cargoMap;
  const canReturnCargo=view==='home' && sessionId && cargoOrigin?.sessionId===sessionId;
  const mapOrigin = sessionId && mapVisit?.sessionId === sessionId ? mapVisit : null;
  const [pendingMapReturn, setPendingMapReturn] = useState(mapOrigin);
  useEffect(() => {
    if (view === 'home') setPendingMapReturn(mapOrigin);
    else if (view !== 'corporate') setPendingMapReturn(null);
  }, [view, mapOrigin]);
  const consumeMapReturn = useCallback(() => setPendingMapReturn(null), []);
  const pinKey = 'gps_cache_pin:' + authScope();
  const [pinnedId, setPinnedId] = useState(() => Number(localStorage.getItem(pinKey)) || null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [cachedMapSources, setCachedMapSources] = useState({});
  const onMapDataSource = useCallback((key, cached, deviceIds) => {
    setCachedMapSources(previous => {
      const next = deviceIds
        ? Object.fromEntries(Object.entries(previous).filter(([id]) => id === 'devices' || deviceIds.some(d => String(d) === id)))
        : { ...previous };
      if (cached) next[key] = true; else delete next[key];
      return next;
    });
  }, []);
  const togglePin = id => { const next = pinnedId === id ? null : id; setPinnedId(next); if (next) localStorage.setItem(pinKey, String(next)); else localStorage.removeItem(pinKey); };
  const deviceQuery = useDevices();
  const { data: devices = EMPTY_DEVICES } = deviceQuery;
  const scope = authScope();
  const setDevices = useCallback(update => updateDeviceList(update, scope), [scope]);
  const [pairSim, setPairSim] = useState('');
  const [pairLabel, setPairLabel] = useState('');
  const [pairError, setPairError] = useState('');
  const [pairLoading, setPairLoading] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);

  // /devices/pair deep link — 카카오 알림톡 등 외부에서 진입 + 연구소 탭의 "튜토리얼 다시 보기"
  // 버튼에서 재진입까지 모두 처리. 한 번 처리 후 path 정리 (/devices) — 새로고침 시 중복 트리거 방지.
  // ref 대신 state — 재진입 시 deps 변경으로 2단계 useEffect 가 매번 fire.
  const [pairTutorialOpen, setPairTutorialOpen] = useState(false);
  const [pairDeepLinkPending, setPairDeepLinkPending] = useState(false);
  useEffect(() => {
    if (location.pathname.startsWith('/devices/pair')) {
      setDetailId(null);
      setPairError('');
      setPairDeepLinkPending(true);
      setPairOpen(true);
      navigate('/devices' + location.search, { replace: true });
    }
  }, [location.pathname, location.search, navigate]);

  // devices 가 첫 로드된 뒤 — deep link 였고 단말기 0개 또는 ?tutorial=1 이면 튜토리얼 표시.
  // 장치 조회와 지도 이력 표시가 모두 끝났는지 별도로 tracking.
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
  const [pairService, setPairService] = useState('');
  const [colorPickerId, setColorPickerId] = useState(null);
  const [detailId, setDetailId]       = useState(null);
  const [roadview, setRoadview]       = useState(null);    // {lat, lng, panoId} or null
  const [toast, setToast]             = useState(null);     // 가벼운 중앙 토스트 메시지 (1초)
  const [deviceListFilters, setDeviceListFilters] = useState({term:'', status:'all', service:''});
  const [filterDeviceId, setFilterDeviceId] = useState(null);  // null=전체, 또는 device id
  const hasSelectedDevice = devices.some(device => device.id === filterDeviceId);
  const { showRoutePlanner, showGeofence, showSeeker, showMiniSeeker, fullToolOpen, openTool, closeTool, toggleMini } = useHomeMapTools(view, hasSelectedDevice);
  const [, setTick]                   = useState(0);
  const bp        = useBreakpoint();
  const isDesktop = bp === 'desktop';
  // 모바일 친화 마커 클릭 정보 sheet (kakao InfoWindow 대체).
  const [pointInfo, setPointInfo] = useState(null);
  const [liveSpeed, setLiveSpeed] = useState(null);
  // 라이브 추적 — 두 상태 분리:
  //   userTrackPref: 사용자가 의도한 ON/OFF (버튼·단말기 선택으로만 변경)
  //   seekerPaused : 시커 활성 동안 일시 정지 — 시커 닫히면 자동 복원
  // 사용자가 직접 지도 드래그하면 userTrackPref=false 로 영구 끔 (다시 버튼 또는 단말기 선택해야 부활).
  const [userTrackPref, setUserTrackPref] = useState(false);
  const seekerPaused = isSeekerVisible(view, filterDeviceId, showSeeker, showMiniSeeker);
  const trackLive = userTrackPref && !seekerPaused && !fullToolOpen;
  // (F2-a) me / accountType 을 React Query 로 이전. 이전엔 4곳에서 중복 fetch 됐음
  // (Dashboard, ProfilePanel×3). 이제 dedup + StrictMode 안전 + refetchOnWindowFocus.
  const meQuery = useMe();
  const { data: me = null } = meQuery;
  const accountQuery = useAccountType();
  const { data: accountTypeRaw } = accountQuery;
  const accountType = accountTypeRaw?.account_type ?? null;
  const isAdmin     = me?.role === 'admin';
  const memberships=useQuery({queryKey:['fleet-memberships',authScope()],queryFn:()=>api.fleetWorkspaces(),enabled:!!me,refetchInterval:30000});
  const enabledServices = ownerServices(accountTypeRaw);
  const corporateOwner = enabledServices.includes('corporate_fleet');
  const rentalOwner = enabledServices.includes('rentcar');
  const cargoOwner = enabledServices.includes('delivery');
  const isCorporate = corporateOwner || !!memberships.data?.memberships?.length;
  const rentalMemberships=useQuery({queryKey:['rental-memberships',authScope()],queryFn:()=>api.rentalTeam('GET','/memberships'),enabled:!!me,staleTime:60000});
  const staffEntry = view==='rentcar'&&new URLSearchParams(location.search).get('page')==='staff-desk';
  const isRentcar = rentalOwner || !!rentalMemberships.data?.length;
  const cargoMemberships = useQuery({queryKey:['cargo-memberships', scope], queryFn:() => api.cargoTeam('GET','/memberships'), enabled:!!me, staleTime:60000});
  const isDelivery = cargoOwner || !!cargoMemberships.data?.length;
  const availableServices = Object.keys(businessServices).filter(key => ({corporate_fleet:isCorporate, rentcar:isRentcar, delivery:isDelivery})[key]);
  const servicePaths = {rentcar:rentalOwner ? '/rentcar' : '/rentcar?page=staff-desk', delivery:cargoOwner ? '/cargo' : '/cargo?page=staff-desk'};
  const [scopeOverride, setRequestedScope] = useState(null);
  const savedScope = useMemo(() => {
    if (!me?.id) return null;
    try { return window.localStorage.getItem('portal.scope.' + me.id); } catch { return null; }
  }, [me?.id]);
  const requestedScope = scopeOverride || savedScope || 'personal';
  useEffect(() => {
    if (me?.id && scopeOverride) {
      try { window.localStorage.setItem('portal.scope.' + me.id, scopeOverride); } catch { /* Storage can be disabled. */ }
    }
  }, [me?.id, scopeOverride]);
  useEffect(() => {
    if ((view === 'corporate' && corporateOwner) || (view === 'rentcar' && rentalOwner) || (view === 'delivery' && cargoOwner)) setRequestedScope('company');
  }, [view, corporateOwner, rentalOwner, cargoOwner]);
  const portalScope = requestedScope === 'company' && enabledServices.length ? 'company' : 'personal';
  const coreView = ['home','devices','profile'].includes(view);
  const scopeOptions = [{value:'personal',label:'내 단말기'}];
  if (enabledServices.length) scopeOptions.push({value:'company',label:'내 사업장'});
  for (const membership of memberships.data?.memberships || []) {
    scopeOptions.push({value:'fleet:' + membership.owner_id, label:membership.company_name || '연결된 회사'});
  }
  function changePortalScope(value) {
    const membership = memberships.data?.memberships?.find(row => value === 'fleet:' + row.owner_id);
    if (membership) {
      rememberFleetOwner(membership.owner_id);
      navigate('/corporate');
      return;
    }
    if (value === 'company') rememberFleetOwner(null);
    setRequestedScope(value);
    setDetailId(null);
    setPointInfo(null);
    setUserTrackPref(false);
  }
  const companyMap = coreView && portalScope === 'company';
  const vehiclesForScope = useQuery({queryKey:['portal-owner-vehicles', scope], queryFn:() => api.listFleetVehicles(), enabled:companyMap && corporateOwner, staleTime:15000});
  const cargoForScope = useQuery({queryKey:['cargo-workspace', scope], queryFn:api.cargoWorkspace, enabled:companyMap && cargoOwner, staleTime:15000});
  const loadingScopeDevices = companyMap && ((corporateOwner && vehiclesForScope.isPending) || (cargoOwner && cargoForScope.isPending));
  const portalDevices = useMemo(() => {
    const rows = classifyOwnedDevices(devices, accountTypeRaw, corporateOwner ? vehiclesForScope.data : undefined, cargoOwner ? cargoForScope.data?.data?.vehicles : undefined);
    return companyMap ? rows.filter(d => d.portalServices.some(key => ownerServices(accountTypeRaw).includes(key))) : rows;
  }, [devices, accountTypeRaw, vehiclesForScope.data, cargoForScope.data, companyMap, corporateOwner, cargoOwner]);
  const visibleIds = useMemo(() => companyMap ? new Set(portalDevices.map(d => d.id)) : null, [companyMap, portalDevices]);
  const selectedPortalDevice = portalDevices.find(d => d.id === filterDeviceId);
  const portalProps = {view, availableServices, servicePaths, isAdmin, onLogout, scope:portalScope, scopeOptions, onScopeChange:changePortalScope};
  const cargoStaffEntry = view === 'delivery' && new URLSearchParams(location.search).get('page') === 'staff-desk';

  // ── 사용자 UI 환경설정 (계정 귀속) ────────────────────────
  // prefs.filter_device_id — 다른 PC 에서 로그인해도 마지막 선택 단말기 복원
  const [userPrefs, setUserPrefs]   = useState(null);
  const userPrefsRef                = useRef(null);
  const [mapReady, setMapReady]     = useState(false);
  const [mapLevel, setMapLevel] = useState(null);
  const mapAreaRef = useRef(null);
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

  // (F2-a) me/accountType 은 useMe / useAccountType hook 이 담당 (dedup + focus refetch).

  // legacy `lab_summary_seen:{userId}:{deviceId}` → userPrefs.summary_seen 마이그레이션.
  // me.id 알아야 하므로 별도 effect. 서버 값과 병합해서 push.
  useEffect(() => {
    if (!me?.id) return;
    const legacyPrefix = `lab_summary_seen:${me.id}:`;
    const collected = {};
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(legacyPrefix)) continue;
      const deviceId = k.slice(legacyPrefix.length);
      if (localStorage.getItem(k) === '1') collected[deviceId] = '2000-01-01';   // 과거 마킹 (오늘 이전 truthy)
      keysToRemove.push(k);
    }
    if (keysToRemove.length === 0) return;
    (async () => {
      let prefs;
      try { prefs = (await api.getMyPrefs()) || {}; } catch { return; }
      const merged = { ...(prefs.summary_seen || {}), ...collected };
      try {
        const updated = await api.patchMyPrefs({ summary_seen: merged });
        setUserPrefs(prev => ({ ...(prev || {}), ...(updated || {}) }));
        keysToRemove.forEach(k => { try { localStorage.removeItem(k); } catch {} });
      } catch { /* 다음 부트 재시도 */ }
    })();
  }, [me?.id]);

  // 사용자 prefs — filter_device_id + device_colors + pair_tutorial_seen 복원.
  // legacy localStorage (dev_color_*, pair_tutorial_seen) 는 1회 서버 push 후 삭제.
  useEffect(() => {
    (async () => {
      let prefs = {};
      try { prefs = (await api.getMyPrefs()) || {}; } catch { prefs = {}; }

      const patch = {};

      // dev_color_* → device_colors (기존 사용자 색 지정 유지)
      if (!prefs.device_colors) {
        const collected = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k || !k.startsWith('dev_color_')) continue;
          const id = k.slice('dev_color_'.length);
          const v = localStorage.getItem(k);
          if (v) collected[id] = v;
        }
        if (Object.keys(collected).length > 0) {
          patch.device_colors = collected;
          prefs = { ...prefs, device_colors: collected };
        }
      }

      // pair_tutorial_seen (레거시 localStorage='1' 이면 서버로 승격)
      if (prefs.pair_tutorial_seen == null) {
        try {
          if (localStorage.getItem('pair_tutorial_seen') === '1') {
            patch.pair_tutorial_seen = true;
            prefs = { ...prefs, pair_tutorial_seen: true };
          }
        } catch { /* noop */ }
      }

      // theme — 서버 값 있으면 apply, 없으면 현재(로컬 seed) 를 서버 push.
      if (prefs.theme && prefs.theme !== currentTheme()) {
        applyTheme(prefs.theme, { syncServer: false });   // 서버 값 이미 있음 — 재-push 안 함
      } else if (!prefs.theme) {
        const local = currentTheme();
        patch.theme = local;
        prefs = { ...prefs, theme: local };
      }

      hydrateDeviceColors(prefs.device_colors || null);
      hydratePairTutorialSeen(prefs.pair_tutorial_seen);
      setUserPrefs(prefs);

      if (Object.keys(patch).length > 0) {
        try {
          await api.patchMyPrefs(patch);
          if (patch.device_colors) {
            Object.keys(patch.device_colors)
              .forEach(id => { try { localStorage.removeItem(`dev_color_${id}`); } catch {} });
          }
          if (patch.pair_tutorial_seen) {
            try { localStorage.removeItem('pair_tutorial_seen'); } catch {}
          }
        } catch { /* 다음 번 부트에서 재시도 — legacy 유지 */ }
      }
    })();
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
  const nativeTracking = useNativeTracking({ mapRef, selectedId: filterDeviceId, devices, lastMetaRef,
    fences: showFences ? fences : [], cached: cachedMapSources, scope });
  // (2026-07-28) 깜빡임 fix — device.id → 마지막 로드 시 device.last_fix_at 저장.
  // 30s force refresh 에서 이 값과 서버 값이 같으면 (=신규 데이터 없음) 재구축 skip.
  const lastLoadedFixAtRef = useRef({});
  // (2026-07-01) zoom 변경 시 dot 재-render 위해 refresh 함수 노출
  const refreshFnRef      = useRef(null);
  const resyncTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(resyncTimerRef.current), []);
  const lastZoomLevelRef  = useRef(null);
  const zoomRefreshTimerRef = useRef(null);
  // (2026-06-30) WS 실시간 path 의 priority sampling — device 별 마지막 dot 위치 + 누적 거리.
  // history fetch 의 computeClickableIndices 와 동일한 30m 간격 → 사거리 통과 dot 클릭 가능.
  const wsDotAccRef = useRef({});  // { [deviceId]: { lat, lng, accM } }
  // 간이 시커의 imperative handle — 지도 마커 클릭 시 selectByTime 으로 슬롯/월 drill 동기화.
  const miniSeekerRef = useRef(null);

  // 연구소 — 오늘 첫 열람 어제 운행 요약 팝업.
  // 트리거: userPrefs.lab_first_view_summary === true 일 때, 사용자가 단말기 필터를
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

  // 단말기 목록을 ref 에 미러링 — 콜백이 매번 리렌더되는 걸 막기 위해.
  // (WebSocket 이벤트 → setDevices → 리렌더 → MiniSeeker prop 새 fn → useEffect 재실행 →
  //  drawSeekerPath 재호출 → setBounds 가 카메라 리셋. ref 로 의존성 끊음.)
  const devicesRef = useRef(devices);
  useEffect(() => { devicesRef.current = devices; }, [devices]);
  useEffect(() => { userPrefsRef.current = userPrefs; }, [userPrefs]);

  // (2026-07-27) 시커 open/close → live layer 전체 (main pin + arrow/cluster dot + solid poly +
  // dashed gap) 를 원자적으로 숨김/복원. 이전엔 setHistoryPointsVisible + setLiveTrailsVisible
  // 두 개로 pointsRef/polyRef 만 감췄고 markersRef (main pin, zIndex 200) 는 그대로 노출되어
  // 시커 위에 오늘의 라이브 pin 이 계속 떠 있었음. 30s force refresh + WS 이벤트도 seeker 무시하고
  // pin/dot/poly 재생성 → 다른 날짜 fix 가 seeker path 위에 계속 얹혀 보임 → 사용자 리포트.
  // 새 KakaoMap.setSeekerMode 는 (1) 기존 element 일괄 setMap(null), (2) 이후 생성되는
  // element 도 seekerModeRef 참조하여 map:null 로 만들어 WS/refresh 로 오늘 데이터 유입 시에도
  // seeker 위에 안 얹힘. 시커 종료 시 축적된 state 를 필터 규칙대로 즉시 복원.
  useEffect(() => {
    const seekerActive = seekerPaused;
    mapRef.current?.setSeekerMode?.(seekerActive);
  }, [seekerPaused]);

  // 추적이 효과적으로 ON 으로 전환되는 순간 (켜자마자 / 시커 닫고 부활) 즉시 카메라를 단말기 마지막 위치로.
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
  const mapToolActiveRef = useRef(false);
  useEffect(() => { mapToolActiveRef.current = fullToolOpen; }, [fullToolOpen]);
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
    seekerActiveRef.current = seekerPaused;
  }, [seekerPaused]);

  // MiniSeekerOverlay 핸들러 — useCallback 으로 ref 안정화.
  // filterDeviceId 만 deps. WebSocket·devices 갱신에는 영향 X.
  // 월 wizard 지원을 위해 limit 을 365 로 확장 (1년 활동일).
  const seekerLoadDates = useCallback((options) =>
    filterDeviceId == null
      ? Promise.resolve([])
      : api.getActiveDates(filterDeviceId, options),
  [filterDeviceId]);

  const seekerLoadDayPoints = useCallback((d, options) =>
    filterDeviceId == null
      ? Promise.resolve([])
      : api.listLocationPoints(filterDeviceId, {
          since: `${d}T00:00:00+09:00`,
          until: new Date(Date.parse(`${d}T00:00:00+09:00`) + 86400000).toISOString(),
          fix_only: true,
        }, options),
  [filterDeviceId]);

  // Monthly summaries cover the whole month instead of silently taking only the latest 10,000 posts.
  const seekerLoadMonthPoints = useCallback((monthYM, options) => {
    if (filterDeviceId == null) return Promise.resolve([]);
    const w = monthWindow(monthYM);
    return api.getDeviceLocationsAggregated(filterDeviceId, '5m', w.since, w.until, options)
      .then(normalizeAggregates);
  }, [filterDeviceId]);

  // opts.dense=false (month 뷰) 는 마커 적당히 (sample ~150), true (day 뷰, 기본) 는 많이 (300).
  // 월 뷰는 maxMarkers 150 으로 — drawSeekerPath 가 균등 sampling 해서 일/시간대 분포가 가시화됨.
  // 월간은 5분 요약, 일간은 선택 날짜의 원본 점을 표시한다.
  const seekerOnPathChange = useCallback((pts, opts = {}) => {
    mapRef.current?.drawSeekerPath?.(pts, {
      maxMarkers: opts.dense === false ? 150 : 300,
      showCursor: false,
      timeColor: opts.dense !== false,
    });
  }, []);
  const seekerOnPathClear = useCallback(() => {
    setPointInfo(null);
    mapRef.current?.clearSeekerPath?.();
  }, []);
  const seekerOnSlotSelect = useCallback((p) => {
    const dev = devicesRef.current.find(d => d.id === filterDeviceId);
    const color = dev ? getDeviceColor(dev) : '#5B7CFF';
    mapRef.current?.setSeekerPin?.(p.lat, p.lng, color);
    mapRef.current?.panToCoord?.(p.lat, p.lng);
  }, [filterDeviceId]);

  // (F6-a-1) WS lifecycle 은 useLiveWS hook 이 담당. 이 컴포넌트는 handleWsEvent 만 소유.
  const { status: wsStatus, subscribe: wsSubscribe } = useLiveWS({
    onEvent: (msg) => handleWsEvent(msg),
  });
  // legacy wsRef.current?.subscribe(...) 호출부와 호환을 위해 wsRef 유지
  // (loadDevicesIncremental / loadDevices 에서 계속 사용).
  useEffect(() => {
    wsRef.current = { subscribe: wsSubscribe };
    return () => { wsRef.current = null; };
  }, [wsSubscribe]);

  // One loader owns map snapshots across renders; late refreshes cannot repaint
  // an older history after a newer request or after this screen unmounts.
  const deviceLoader = useMemo(() => makeDeviceLoaders({
    mapRef, devRef, lastMetaRef, lastLoadedFixAtRef, wsRef,
    setDevicesLoaded, readDevices: loadDeviceSnapshot,
    onDataSource: onMapDataSource,
    onLatest: (d, meta) => {
      if (filterDeviceIdRef.current === d.id) setLiveSpeed({ deviceId: d.id,
        label: d.display_name || d.device_uid, color: getDeviceColor(d), speedKmh: meta.speedKmh, recordedAt: meta.recordedAt });
    },
  }), [onMapDataSource]);
  const { loadDevices, loadDevicesIncremental } = deviceLoader;
  useEffect(() => () => deviceLoader.cancel(), [deviceLoader]);
  async function reloadDevicesAfterMutation() {
    deviceLoader.cancel();
    await cancelDeviceSnapshot();
    assertSession(scope);
    await loadDevices();
  }

  // (F6-a-1) 30s tick + focus/visibility 는 useAutoRefresh hook 이 담당.
  const doRefresh = useCallback(async (force = false) => {
    setTick(x => x + 1);
    await Promise.all([loadDevicesIncremental(force), loadFences()]);
  }, [loadDevicesIncremental, loadFences]);
  const refreshFn = useAutoRefresh(doRefresh, { intervalMs: 30_000, minIntervalMs: 8_000 });
  useEffect(() => { refreshFnRef.current = refreshFn; }, [refreshFn]);
  useEffect(() => {
    // Browser connectivity alone is not proof of fresh data. Re-read first;
    // successful responses clear only their own saved-data notices.
    const recover = () => refreshFnRef.current?.(true);
    window.addEventListener('online', recover);
    return () => window.removeEventListener('online', recover);
  }, []);



  const handleMapReady = useCallback(() => {
    loadDevices(); loadFences(); loadGeofenceAlert();
    setMapReady(true);
  }, [loadDevices, loadFences, loadGeofenceAlert]);

  // 저장된 filter_device_id 복원 — devices/prefs/map 모두 준비됐을 때 1회.
  // (F12) 이전엔 devices.length>0 로 판정해 renderDeviceFixes 미완료 상태에서도 fit 호출
  // → bounds = main marker 단일 점 → 이상한 zoom. devicesLoaded 는 Promise.all 이후 true.
  useEffect(() => {
    if (filterAppliedRef.current || readDeviceLink(location.search).present) return;
    if (!mapReady || !userPrefs || !devicesLoaded || loadingScopeDevices) return;
    const stored = userPrefs.filter_device_id;
    if (stored != null && (!visibleIds || visibleIds.has(stored)) && devices.some(d => d.id === stored)) {
      setFilterDeviceId(stored);
      // (2026-07-03) map_view 저장 제거 → 항상 fit (selected device 전체 화면 auto zoom).
      mapRef.current?.filterToDevice(stored, { fit: true });
    }
    filterAppliedRef.current = true;
  }, [mapReady, userPrefs, devicesLoaded, devices, location.search, visibleIds, loadingScopeDevices]);

  // 사용자 액션으로 필터 변경 시 — 즉시 서버 저장 (race 방지).
  // 새로고침 사이에 PATCH 가 날아가지 않도록 디바운스 X.
  // 사용자가 단말기를 선택하면 라이브 추적도 자동 ON (단말기 따라가기 자연스러움).
  const persistFilterDevice = useCallback((id) => {
    // An explicit choice wins even if an older saved selection or history is still loading.
    filterAppliedRef.current = true;
    setFilterDeviceId(id);
    mapRef.current?.filterToDevice(id);
    if (id !== null) setUserTrackPref(true);
    api.patchMyPrefs({ filter_device_id: id })
      .then(p => setUserPrefs(p))
      .catch(() => {});
  }, []);

  const openCorporateMap = (deviceId, detail) => {
    setRequestedScope('personal');
    const origin = detail && sessionId ? { ...detail, sourceKey: location.key, sessionId } : null;
    navigate('/', { state: origin ? { corporateVehicleMap: origin } : null });
    persistFilterDevice(deviceId);
  };
  const returnToVehicle = view === 'home' && isCorporate && mapOrigin && mapOrigin.actorId === me?.id
    ? () => {
      // Embedded maps can add their own browser-history steps. The app button
      // must go directly to the corporate route even when Back would stay here.
      setPendingMapReturn(mapOrigin);
      navigate('/corporate', { replace: true, state: { returnToVehicleKey: mapOrigin.sourceKey } });
    } : undefined;
  const returningToOrigin = pendingMapReturn && (pendingMapReturn.sourceKey === location.key
    || pendingMapReturn.sourceKey === location.state?.returnToVehicleKey);
  const restoredVehicle = returningToOrigin && pendingMapReturn.sessionId === sessionId
    && pendingMapReturn.actorId === me?.id ? pendingMapReturn : null;
  const selectLinkedDevice = useCallback(id => {
    setRequestedScope('personal');
    filterAppliedRef.current = true;
    persistFilterDevice(id);
    mapRef.current?.filterToDevice(id, { fit: true });
  }, [persistFilterDevice]);
  const consumeDeviceLink = useCallback(search => {
    navigate({ pathname: location.pathname, search, hash: location.hash }, { replace: true });
  }, [navigate, location.pathname, location.hash]);
  const deviceLink = useDeviceDeepLink({ search: location.search, devices, loaded: devicesLoaded,
    ready: mapReady, onSelect: selectLinkedDevice, onConsume: consumeDeviceLink });

  // 사용자가 직접 지도를 드래그한 경우 — 추적 의도 자체를 끔. 다시 버튼 또는 단말기 선택해야 부활.
  // 단, 시커 활성 중 발생한 드래그는 무시 — 시커 조작이 일으킨 이동까지 사용자 의도로 잡으면
  // 시커 닫고 나서 추적이 의도와 다르게 OFF 인 상태로 유지됨.
  const handleUserPan = useCallback(() => {
    if (seekerActiveRef.current || mapToolActiveRef.current) return;
    setUserTrackPref(false);
  }, []);

  // KakaoMap 이 사용자 조작 (drag/zoom) 으로 view 가 바뀌었음을 알려옴 → zoom re-render 만 트리거.
  // (2026-07-03) map_view 저장 로직 제거 — 사용자 요청 "위치는 기억할 필요 없음".
  //   hard reload = 매번 auto fit (position + zoom 모두 selected device 전체 보이도록).
  //   세션 중 zoom 조작은 UI 상 유지되지만 새로고침 시 잊음. 실수로 빈 화면 봤을 때 다음 진입도
  //   빈 화면 되는 문제 해결.
  const handleMapViewChange = useCallback((view) => {
    if (view && view.level != null && lastZoomLevelRef.current !== view.level) {
      lastZoomLevelRef.current = view.level;
      clearTimeout(zoomRefreshTimerRef.current);
      zoomRefreshTimerRef.current = setTimeout(() => {
        refreshFnRef.current?.(true);
      }, 200);
    }
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

  // 연구소: 단말기 필터 (non-null) 시 어제 운행 요약 팝업.
  // 토글 OFF (default): 단말기별 1회만 노출 (인트로). userPrefs.summary_seen 로 영구 기억.
  // 토글 ON: 단말기를 잡을 때마다 매번 노출 (대신 OFF 로 돌아가도 다시 인트로는 안 봄).
  useEffect(() => {
    if (!me?.id) return;   // me 로드 전엔 매핑 애매
    if (filterDeviceId == null) return;
    if (view !== 'home') return;   // 홈 탭에서 잡았을 때만
    const on = !!userPrefs?.lab_first_view_summary;
    const seen = userPrefs?.summary_seen?.[String(filterDeviceId)];
    // OFF 모드: 이미 본 적 있으면 skip
    if (!on && seen) return;
    // 마크 — 오늘 날짜로 저장 (양쪽 모드 다 set, OFF 로 돌아가도 인트로 안 보게)
    const KST_TZ = 9 * 3600 * 1000;
    const todayKst = new Date(Date.now() + KST_TZ).toISOString().slice(0, 10);
    const nextSeen = { ...(userPrefs?.summary_seen || {}), [String(filterDeviceId)]: todayKst };
    api.patchMyPrefs({ summary_seen: nextSeen })
       .then(p => setUserPrefs(p))
       .catch(() => {});

    const KST = 9 * 3600 * 1000;
    const yesterday = new Date(Date.now() + KST - 86400000).toISOString().slice(0, 10);
    // 어제 통계 가져옴 — 없으면 "기록 없음" 으로 노출
    api.getDailyStats(filterDeviceId, { from: yesterday, to: yesterday, limit: 1 })
      .then(rows => {
        const stats = rows?.[0]?.date === yesterday ? rows[0] : null;
        const dev = devicesRef.current.find(d => d.id === filterDeviceId);
        setYesterdayDialog({
          deviceName: dev?.display_name || dev?.device_uid || '단말기',
          dateStr: yesterday,
          stats,
        });
      })
      .catch(() => {
        // 통신 오류 — 그래도 팝업 한 번 (empty 모드).
        const dev = devicesRef.current.find(d => d.id === filterDeviceId);
        setYesterdayDialog({
          deviceName: dev?.display_name || dev?.device_uid || '단말기',
          dateStr: yesterday,
          stats: null,
        });
      });
  }, [filterDeviceId, userPrefs?.lab_first_view_summary, view, me?.id]);

  // 펜스 항상 그리기 — fences/devices/showFences/geofenceAlert/filterDeviceId 변경 시 재계산.
  // 표시 조건: showFences AND geofenceAlert (master). 필터된 단말기가 있으면 그에 맞는 펜스만.
  useEffect(() => {
    if (!mapRef.current) return;
    mapRef.current.clearAllGeofences();
    if (!showFences || !geofenceAlert) return;
    fences.forEach(f => {
      if (!f.active || (visibleIds && !visibleIds.has(f.device_id))) return;
      // 장치 필터 존중: 특정 단말기 선택 시 그 단말기 또는 '전체 단말기' 펜스만
      if (filterDeviceId !== null && f.device_id !== null && f.device_id !== filterDeviceId) return;
      const inside = isAnyDeviceInsideFence(f, devices);
      mapRef.current?.drawGeofence(
        f.id, f.center_lat, f.center_lng, f.radius_m, f.name, inside,
      );
    });
  }, [fences, devices, showFences, geofenceAlert, filterDeviceId, visibleIds]);

  // (F6-a-2) handleWsEvent 는 lib/wsEventHandler.js 의 factory 로 이동.
  // 이 컴포넌트는 refs + setters 를 주입만. refs identity 는 stable 하므로 매 render
  // 새 함수 identity 여도 useLiveWS 가 onEvent 를 ref 로 잡아 재연결 없음.
  const handleWsEvent = makeWsEventHandler({
    devRef: devicesRef, mapRef, lastMetaRef, wsDotAccRef,
    filterDeviceIdRef, trackLiveRef,
    setDevices, setLiveSpeed,
    onResync: () => {
      if (resyncTimerRef.current) return;
      resyncTimerRef.current = setTimeout(() => {
        resyncTimerRef.current = null;
        lastLoadedFixAtRef.current = {}; // Backfill can change history without changing the newest fix.
        refreshFnRef.current?.(true);
      }, 250);
    },
  });

  // ── 단말기 액션 ─────────────────────────
  async function handlePair() {
    setPairError('');
    if (!/^\d{8,20}$/.test(pairSim.trim())) { setPairError('SIM 번호를 숫자 8~20자리로 입력해 주세요.'); return false; }
    const body = { iccid: pairSim.trim() };
    const name = pairLabel.trim();
    if (!name) { setPairError('단말기명(별명)을 입력하세요. 알림에 사용됩니다.'); return false; }
    body.display_name = name;
    setPairLoading(true);
    try {
      const paired = await api.pairDevice(body);
      setPairSim(''); setPairLabel('');
      if (companyMap) {
        const service = enabledServices.includes(pairService) ? pairService : enabledServices[0];
        try { await api.setDeviceAccountType(paired.id, service); }
        catch {
          setRequestedScope('personal');
          setDetailId(paired.id);
          setPairError('단말기를 연결했습니다. 업무 구분은 단말기 상세에서 다시 선택해 주세요.');
          await reloadDevicesAfterMutation();
          return false;
        }
      }
      await reloadDevicesAfterMutation();
      return true;
    } catch (e) { setPairError(e.message); return false; }
    finally { setPairLoading(false); }
  }

  async function handleRename(id, changes) {
    const updated = await api.updateDevice(id, changes);
    setDevices(ds => ds.map(d => d.id === id ? {...d,...updated} : d));
  }

  // 연결 해제 모달 — 단일 모달에서 보관/삭제/취소 명시 선택
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
      await reloadDevicesAfterMutation();
      setUnpairTarget(null);
      await alertDialog({
        title: '연결 해제 완료',
        body: purge
          ? '본인 데이터까지 영구 삭제됐습니다. 결제 이력 (포인트, SIM 충전, AI 분석) 은 보존.'
          : '데이터는 보관됐습니다. 같은 계정에서 동일 SIM을 다시 연결하면 복원됩니다. 단말기 하드웨어는 달라도 됩니다.',
        tone: 'success',
      });
    } catch (e) {
      await alertDialog({ title: '실패', body: e.message, tone: 'danger' });
    } finally {
      setUnpairBusy(false);
    }
  }

  async function handlePickColor(deviceId, color) {
    // optimistic: 로컬 캐시 + 지도 마커 + state 즉시 반영
    setDeviceColorCache(deviceId, color);
    mapRef.current?.setMarkerColor(deviceId, color);
    setDevices(prev => prev.map(d => d.id === deviceId ? { ...d, color } : d));
    setColorPickerId(null);

    // userPrefs.device_colors 서버 sync (계정 단위 — 다른 device 로그인 시 자동 반영)
    const nextMap = { ...(getDeviceColorsCache() || {}) };   // 이미 setDeviceColorCache 로 반영됨
    try {
      const updated = await api.patchMyPrefs({ device_colors: nextMap });
      if (updated?.device_colors) hydrateDeviceColors(updated.device_colors);
      setUserPrefs(prev => ({ ...(prev || {}), ...(updated || {}) }));
    } catch { /* offline — 다음 부트에서 서버 값 우세 처리 */ }

    // device.color (per-device 서버 값) 는 legacy — 유지 중이면 sync
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
  const specialized = ['admin', 'corporate', 'rentcar', 'delivery'].includes(view);
  const delegatedQuery = view === 'corporate' && !corporateOwner ? memberships
    : view === 'rentcar' && !rentalOwner && !staffEntry ? rentalMemberships
    : view === 'delivery' && !cargoOwner && !cargoStaffEntry ? cargoMemberships : null;
  const accessQuery = view === 'admin' ? meQuery : accountQuery.isSuccess && delegatedQuery ? delegatedQuery : accountQuery;
  const businessAllowed = view === 'corporate' && isCorporate || view === 'rentcar' && (isRentcar || staffEntry)
    || view === 'delivery' && (isDelivery || cargoStaffEntry);
  const routeProblem = !view ? 'missing' : specialized && (accessQuery.isPending ? 'loading' : accessQuery.isError ? 'error'
    : !(view === 'admin' ? routeAccess(view, me, accountType) : businessAllowed) ? 'denied' : null);
  const mapVisible = !routeProblem && (view === 'home' || view === 'devices');
  const positionedCount = portalDevices.filter(validPosition).length;
  const scopeCountReady = deviceQuery.isSuccess && !loadingScopeDevices &&
    !(companyMap && ((corporateOwner && vehiclesForScope.isError) || (cargoOwner && cargoForScope.isError)));
  useEffect(() => {
    if (!routeProblem && accountQuery.isSuccess) rememberView(me?.id, location.pathname, location.search);
  }, [routeProblem, accountQuery.isSuccess, me?.id, location.pathname, location.search]);
  useEffect(() => {
    if (mapVisible && mapReady) {
      const frame = requestAnimationFrame(() => mapRef.current?.relayout?.());
      return () => cancelAnimationFrame(frame);
    }
  }, [mapVisible, mapReady, view, isDesktop]);
  useEffect(() => {
    if (loadingScopeDevices) return;
    if (visibleIds && filterDeviceId != null && !visibleIds.has(filterDeviceId)) {
      setFilterDeviceId(null);
      setPointInfo(null);
      setUserTrackPref(false);
    } else if (mapReady) {
      mapRef.current?.filterToDevice(filterDeviceId, {fit:false});
    }
  }, [visibleIds, filterDeviceId, mapReady, loadingScopeDevices]);
  const scopedFences = companyMap ? fences.filter(f => f.device_id != null && visibleIds.has(f.device_id)) : fences;

  // 패널 콘텐츠는 desktop aside 와 mobile overlay 양쪽에서 공유
  const renderDeviceTools = d => {
    const color = getDeviceColor(d);
    const meta  = lastMetaRef.current[d.id];
    return (
      <div className="pt-device-tools">
            <div className="pt-terminal-actions">
              <button type="button" className="pt-button" onClick={()=>togglePin(d.id)}>{pinnedId===d.id?'홈 고정 해제':'홈에 고정'}</button>
              <button type="button" className="pt-button" onClick={()=>window.open('/diagnostic/device?uid='+encodeURIComponent(d.device_uid),'_blank','noopener')}>수신 로그</button>
              <button type="button" className="pt-button" aria-expanded={colorPickerId===d.id} onClick={()=>setColorPickerId(colorPickerId===d.id?null:d.id)}>색상 변경</button>
              <button type="button" className="pt-button" onClick={()=>handleUnpair(d.id)}>연결 해제</button>
            </div>
            <DeviceTechnicalInfo device={d} meta={meta}/>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              {[['next_service_date','정비'],['insurance_expiry','보험'],['inspection_expiry','검사']].map(([key,label]) => {
                if (!d[key]) return null;
                const days = Math.ceil((new Date(d[key] + 'T00:00:00') - new Date()) / 86400000);
                return days <= 30 ? <span key={key} style={{ fontSize: 13, color: days < 0 ? 'var(--danger)' : 'var(--text-2)' }}>{label} {days < 0 ? `${-days}일 경과` : `D-${days}`}</span> : null;
              })}
            </div>
            {colorPickerId === d.id && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                {PALETTE.map(c => (
                  <button key={c} aria-label={`단말기 색상 ${c}`} aria-pressed={c === color} onClick={() => handlePickColor(d.id, c)}
                    style={{
                      width: 44, height: 44, borderRadius: 22, padding: 0,
                      background: c, border: c === color ? '2px solid var(--text)' : '1px solid var(--border)',
                      cursor: 'pointer',
                    }} />
                ))}
              </div>
            )}

            {detailId === d.id && (
              <DeviceDetail device={d} meta={meta} onUpdated={updated => setDevices(ds => ds.map(x => x.id === updated.id ? updated : x))} onWiped={async (id) => {
                mapRef.current?.removeMarker(id);
                delete lastMetaRef.current[id];
                setDetailId(null);
                await reloadDevicesAfterMutation();
              }} />
            )}
      </div>
    );
  };
  const detailDevice = mapVisible && portalDevices.find(device=>device.id===detailId);
  function closeTerminal() {setDetailId(null);setColorPickerId(null);}
  const panel = (
    <>
      {view === 'devices' && <PortalDeviceList {...portalProps} devices={portalDevices} availableServices={enabledServices} scopeLabel={scopeOptions.find(option => option.value === portalScope)?.label}
        filters={deviceListFilters} onFiltersChange={setDeviceListFilters}
        meta={lastMetaRef.current} selectedId={filterDeviceId} detailId={detailId} loading={deviceQuery.isPending || loadingScopeDevices} error={deviceQuery.isError} onRetry={deviceQuery.refetch}
        onSelect={id => { persistFilterDevice(id); if (!isDesktop) mapAreaRef.current?.scrollIntoView({block:'start'}); }}
        onDetail={setDetailId}
        onPair={() => {setDetailId(null); setPairOpen(true); setPairError('');}}>
        {pairOpen && <Modal open mobileForm size={530} className="pt-standard-dialog" title="단말기 등록" subtitle={companyMap?'회사 단말기에 추가합니다.':'내 단말기에 추가합니다.'}
          onClose={pairLoading ? undefined : () => setPairOpen(false)}
          footer={<div className="pt-dialog-actions">
            <button type="button" className="pt-button" disabled={pairLoading} onClick={() => setPairOpen(false)}>취소</button>
            <button type="submit" form="portal-pair-terminal" disabled={pairLoading} className="pt-button pt-primary">{pairLoading?'연결 중…':'등록'}</button>
          </div>}>
          <form id="portal-pair-terminal" className="pt-terminal-fields" onSubmit={async event => {event.preventDefault(); if (!pairLoading && await handlePair()) setPairOpen(false);}}>
                {companyMap && <label>업무 구분<select value={enabledServices.includes(pairService) ? pairService : enabledServices[0]} onChange={e=>setPairService(e.target.value)}>
                  {enabledServices.map(key=><option key={key} value={key}>{{corporate_fleet:'법인운행',rentcar:'렌트카 운영',delivery:'화물배차'}[key]}</option>)}
                </select></label>}
                <label>단말기 이름
                  <input placeholder="예: 1호차" value={pairLabel} maxLength={32} required
                    onChange={e=>setPairLabel(e.target.value)} />
                </label>
                <div className="pt-terminal-sim-field"><SimRegistrationHelp inputId="pair-sim-number" />
                <input id="pair-sim-number" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={20}
                  placeholder="SIM 끝 8자리 (1NCE 화면 기준)" value={pairSim}
                  onChange={e => setPairSim(e.target.value)} /></div>
                {pairError && <div role="alert">{pairError}</div>}
          </form></Modal>}
      </PortalDeviceList>}
      {view === 'profile' && <PortalAccount {...portalProps}/>}
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

  if (routeProblem === 'denied' && view !== 'admin') return <Navigate replace to="/profile?tab=services" />;
  return (
    <div className="dashboard-layout pt-member-shell" data-view={view} style={{ height: '100dvh', display: 'flex' }}>

      {deviceLink.notice && <div role="alert" style={{ position: 'fixed', zIndex: 45,
        left: isDesktop ? 84 : 12, right: 12, bottom: isDesktop ? 20 : 'calc(76px + env(safe-area-inset-bottom, 0px))',
        maxWidth: 420, padding: 16, background: 'var(--surface)', color: 'var(--text)',
        border: '1px solid var(--border)', borderRadius: 12, boxShadow: 'var(--shadow-lg)', fontSize: 13 }}>
        <div>{deviceLink.notice}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button type="button" style={s.smallBtn} onClick={() => { deviceLink.dismiss(); setView('devices'); }}>단말기 목록</button>
          <button type="button" style={s.smallBtn} onClick={deviceLink.dismiss}>닫기</button>
        </div>
      </div>}

      <PlatformRail {...portalProps} onShowGuide={() => setShowOnboarding(true)}/>
      <div style={{display:'flex',flexDirection:'column',flex:1,minWidth:0,minHeight:0}}>
        {coreView && <PlatformHeader {...portalProps} me={me} devices={portalDevices} meta={lastMetaRef.current} onDevice={id => {persistFilterDevice(id); setDetailId(null); setView('home');}}/>}
      <WorkspaceHeaderContext.Provider value={{name:me?.display_name?.trim()||me?.email,openProfile:()=>setView('profile'),options:scopeOptions,selected:'company',onChange:value=>{
        changePortalScope(value);
        if(value==='personal')navigate('/devices');
      }}}>
      <main className="pt-main-area" style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'row', minWidth: 0 }}>

        {routeProblem && <RouteNotice kind={routeProblem} onRetry={routeProblem === 'error' ? () => accessQuery.refetch() : undefined} />}

        {/* 관리자 본문 — admin 일 땐 지도/사이드패널 모두 숨기고 풀-화면 차지 */}
        {!routeProblem && view === 'admin' && isAdmin && (
          <div style={{
            flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
          }}>
            <Suspense fallback={<LazyPanelFallback />}>
              <AdminDashboard />
            </Suspense>
          </div>
        )}

        {/* 법인운행 본문 — admin 과 동일한 풀-화면 레이아웃 */}
        {!routeProblem && view === 'corporate' && isCorporate && (
          <div style={{
            flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
          }}>
            <Suspense fallback={<LazyPanelFallback />}>
              <CorporatePanel defaultOwner={corporateOwner ? undefined : memberships.data?.memberships?.[0]?.owner_id} allowedMemberships={memberships.data?.memberships} devices={devices} onNavigate={setView} globalNavigation={sideRailItems({isAdmin,isCorporate,isRentcar,isDelivery}).filter(item=>item.id!=='corporate')} meta={lastMetaRef.current} onMap={openCorporateMap}
                routeSearch={location.search}
                onRoute={(page,section)=>{
                  const query=new URLSearchParams(location.search);
                  query.set('page',page);
                  if(section)query.set('section',section);else query.delete('section');
                  const search='?'+query.toString();
                  if(search!==location.search) navigate({pathname:location.pathname,search},{state:location.state,preventScrollReset:true});
                }}
                mapReturn={restoredVehicle}
                onMapReturnUsed={consumeMapReturn} onDevice={id => { setRequestedScope('personal'); setDetailId(id); setView('devices'); }} onVehiclesChange={reloadDevicesAfterMutation} />
            </Suspense>
          </div>
        )}

        {/* 렌트카 본문 — 풀-화면. corporate 와 같은 shell. */}
        {!routeProblem && view === 'rentcar' && (staffEntry||(!rentalOwner&&isRentcar)) && <Suspense fallback={<LazyPanelFallback/>}><RentalStaffDesk onHome={()=>setView('profile')}/></Suspense>}
        {!routeProblem && view === 'rentcar' && rentalOwner && !staffEntry && (
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <Suspense fallback={<LazyPanelFallback />}>
              <RentcarPanel devices={devices} onNavigate={setView} meta={lastMetaRef.current}
                page={new URLSearchParams(location.search).get('page')}
                onPage={id=>navigate({pathname:'/rentcar',search:id==='fleet'?'':'?page='+encodeURIComponent(id)})}
                destinations={sideRailItems({isAdmin,isCorporate,isRentcar,isDelivery}).filter(item=>item.id!=='rentcar')}
                onDevicesChange={reloadDevicesAfterMutation} onManageVehicle={id=>{setRequestedScope('personal');setDetailId(id);setView('devices');}}
                onMap={id => { setRequestedScope('personal'); setView('home'); persistFilterDevice(id); }} />
            </Suspense>
          </div>
        )}

        {/* 배송 본문 — 풀-화면. */}
        {!routeProblem && view === 'delivery' && (isDelivery || cargoStaffEntry) && (
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <Suspense fallback={<LazyPanelFallback />}>
              <DeliveryPanel devices={devices} page={cargoOwner || cargoStaffEntry ? new URLSearchParams(location.search).get('page') : 'staff-desk'}
                onPage={page=>navigate({pathname:'/cargo',search:page==='cargo-dashboard'?'':'?page='+encodeURIComponent(page)})}
                destinations={sideRailItems({isAdmin,isCorporate,isRentcar,isDelivery}).filter(item=>item.id!=='delivery')}
                onRegisterDevice={()=>navigate('/devices/pair')} onNavigate={setView} onMap={id=>{setRequestedScope('personal');persistFilterDevice(id ?? null);navigate('/',{state:{cargoMap:{sessionId,actor:me?.id,search:location.search}}});}} />
            </Suspense>
          </div>
        )}

        {/* 데스크톱 사이드바 패널 — SideRail 바로 옆에서 확장.
            홈/관리/법인 외 탭일 때만 슬라이드 인. */}
        {!routeProblem && (view === 'devices' || view === 'profile' && isDesktop) && (
          <aside className={view === 'devices' ? 'pt-device-sidebar' : undefined} style={{
            width: view === 'profile' ? '100%' : undefined, flexShrink: 0, minHeight:0,
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
        <div ref={mapAreaRef} className="pt-live-map-area" style={{
          flex: 1, position: 'relative', minWidth: 0,
          display: (routeProblem || specialized || isDesktop && view === 'profile') ? 'none' : 'flex', flexDirection: 'column',
        }}>
          {canReturnCargo&&isDelivery&&cargoOrigin.actor===me?.id&&<nav className="map-vehicle-return-bar" aria-label="화물 지도 탐색"><button type="button" className="map-return-vehicle" onClick={()=>navigate({pathname:"/cargo",search:cargoOrigin.search},{replace:true})}><Icon name="chevron-left" size={16}/>화물배차로 돌아가기</button></nav>}
          {returnToVehicle && <nav className="map-vehicle-return-bar" aria-label="차량 지도 탐색"><button type="button" className="map-return-vehicle" onClick={returnToVehicle}><Icon name="chevron-left" size={16}/>차량 상세로 돌아가기</button></nav>}
          <div style={{ position: 'relative', flex: 1, minHeight: 0, visibility: mapVisible ? 'visible' : 'hidden' }}>
            <KakaoMap ref={mapRef} visibleDeviceIds={visibleIds} onReady={handleMapReady}
              deviceMap={view === 'devices' ? {devices:portalDevices, selectedId:filterDeviceId, onSelect:persistFilterDevice, history:seekerPaused, markerLayer:DeviceMapMarkers} : null}
              onRoadview={({ lat, lng }) => tryOpenRoadview(lat, lng)}
              // 지도 마커 클릭 → 모바일: 컴팩트 PointInfoSheet + 간이 시커 슬롯 동기화 동시.
              // 데스크톱 기본: kakao InfoWindow 유지 (onPointInfo 미제공 → KakaoMap 내부 fallback).
              // 데스크톱 + 간이 시커 활성: 마커 click 활성 위해 핸들러 제공 (drawSeekerPath 가
              //   `clickable: !!onPointInfoRef.current` 로 마커를 만들기 때문에).
              //   handler 의 setPointInfo 는 desktop 에선 PointInfoSheet 미렌더라 무해.
              onPointInfo={!fullToolOpen && (!isDesktop || showMiniSeeker) ? (info) => {
                setPointInfo(info);
                if (showMiniSeeker && info?.meta?.recordedAt) {
                  const dev = devicesRef.current.find(d => d.id === filterDeviceId);
                  const color = dev ? getDeviceColor(dev) : '#5B7CFF';
                  mapRef.current?.setSeekerPin?.(info.lat, info.lng, color);
                  miniSeekerRef.current?.selectByTime(info.meta.recordedAt, { skipPin: true });
                }
              } : undefined}
              onUserPan={handleUserPan}
              onViewChange={handleMapViewChange} onZoomLevelChange={setMapLevel} />
            {!fullToolOpen && !pointInfo && <MapTopOverlay
              externalControls
              devices={portalDevices} selected={filterDeviceId} onSelect={persistFilterDevice}
              onPair={() => navigate('/devices/pair')}
              mapRef={mapRef} onOpenRoadview={openRoadview}
              showSpeed={view === 'home' && trackLive && filterDeviceId !== null}
              historyMode={showMiniSeeker}
              following={trackLive && selectedPortalDevice?.last_lat != null && selectedPortalDevice?.last_lng != null}
              liveSpeed={liveSpeed} cachedSources={cachedMapSources}
            >
              {view === 'home' && deviceQuery.isSuccess && !portalDevices.length && <div className="pt-map-empty">
                <strong>{companyMap ? '사업장 단말기가 없습니다' : '연결된 단말기가 없습니다'}</strong>
                <button type="button" className="pt-text-button" onClick={() => navigate('/devices/pair')}>단말기 등록</button>
              </div>}
            </MapTopOverlay>}

            {/* 홈 — 지도 가장자리 활용 지오펜스 레이어.
                  우하단 FAB 칼럼: 펜스 ON/OFF 토글 + 새 펜스 만들기 (토글 ON 일 때만)
                  좌하단: 등록된 펜스 목록 (scrollable, 토글 ON 일 때만)
                  showFences 가 토글의 상태 — 기존 지도 펜스 원 표시 플래그와 공유.
                  알람 토글 / 이력은 홈의 운행 도구 → 지오펜스 관리에서 확인. */}
            {mapVisible && !fullToolOpen && !pointInfo && (() => {
              const stripLift = showMiniSeeker ? MINI_SEEKER_BOTTOM_HEIGHT : 0;
              const fabBottom = (view === 'devices' ? (isDesktop ? 48 : 43) : isDesktop ? 24 : 16) + stripLift;
              return (
                <HomeFenceQuick
                  devices={portalDevices}
                  mapRef={mapRef}
                  fences={scopedFences}
                  onChange={loadFences}
                  filterDeviceId={filterDeviceId}
                  bottomLift={stripLift}
                  fabBottom={fabBottom}
                  addBelow={view === 'devices'}
                  enabled={showFences}
                  onToggleEnabled={setShowFences}
                  listSide={isDesktop ? 'right' : 'left'}
                  showList={view === 'home' && !showMiniSeeker}
                />
              );
            })()}

            {!fullToolOpen && !pointInfo && <div className="pt-map-command-stack" style={{
              '--pt-seeker-offset': (showMiniSeeker ? MINI_SEEKER_BOTTOM_HEIGHT : 0) + 'px',
              '--pt-command-bottom': ((view === 'devices' ? (isDesktop ? 48 : 43) : isDesktop ? 24 : 16) + (showMiniSeeker ? MINI_SEEKER_BOTTOM_HEIGHT : 0) + (view === 'devices' ? (showFences ? 114 : 57) : (showFences ? 120 : 60))) + 'px',
            }}>
              <MapControls mapRef={mapRef} selected={selectedPortalDevice?.id} onOpenRoadview={openRoadview} deviceLayout={view === 'devices'} zoomLevel={mapReady ? mapLevel : null}/>
              {mapVisible && <MapActions simple={view === 'devices'}
                hasDevice={Boolean(selectedPortalDevice)} tracking={userTrackPref} paused={seekerPaused}
                canTrack={view === 'home' ? Boolean(selectedPortalDevice) : selectedPortalDevice?.last_lat != null && selectedPortalDevice?.last_lng != null}
                onNativeTracking={nativeTracking.available ? async () => {
                  const error = await nativeTracking.open();
                  if (error) await alertDialog({ title: '진행 방향 추적', body: error });
                } : undefined}
                miniOpen={showMiniSeeker}
                onTracking={() => {
                  setUserTrackPref(p => !p);
                  if (!seekerPaused) mapRef.current?.focusDevice?.(filterDeviceId, { level: 3 });
                }}
                onMini={() => { setPointInfo(null); toggleMini(); }}
                onTool={tool => { setPointInfo(null); openTool(tool); }}
              />}
            </div>}

            {showRoutePlanner && view === 'home' && <RoutePlannerSheet mapRef={mapRef} onClose={() => closeTool()} />}
            {mapVisible && !showMiniSeeker && !fullToolOpen && !pointInfo && <div className="pt-map-card-stack">
              <MapDeviceCard vehicles={portalDevices} device={selectedPortalDevice} meta={lastMetaRef.current[filterDeviceId]}
                onDetail={setDetailId} onList={() => setView('devices')}/>
            {view === 'home' && <PinnedDeviceWidget embedded
              device={portalDevices.find(d => d.id === pinnedId)} deviceColor={getDeviceColor(devices.find(d => d.id === pinnedId) || {})}
              deviceMeta={lastMetaRef.current[pinnedId]} deviceStatus={devices.find(d => d.id === pinnedId) ? classifyDevice(devices.find(d => d.id === pinnedId), lastMetaRef.current[pinnedId]) : null}
              onPress={() => { const d = devices.find(d => d.id === pinnedId); if (d?.last_lat != null) mapRef.current?.panToCoord?.(d.last_lat, d.last_lng); }}
              onUnpin={() => togglePin(pinnedId)} />}
            </div>}
            {/* 홈 운행 도구: 한 번에 한 패널만 열어 지도와 상단 정보의 겹침 방지. */}
            {showGeofence && view === 'home' && (
              <GeofenceSheet
                devices={portalDevices} mapRef={mapRef}
                fences={scopedFences} onChange={loadFences}
                showFences={showFences} onToggleShow={setShowFences}
                alertEnabled={geofenceAlert} onToggleAlert={toggleGeofenceAlert}
                filterDeviceId={filterDeviceId}
                onClose={() => closeTool()} />
            )}

            {/* 상세 시커: 라이브 추적을 일시 정지하고 닫으면 사용자 추적 설정 복원. */}
            {showSeeker && view === 'home' && filterDeviceId !== null && (
              <SeekerSheet
                key={filterDeviceId}
                device={devices.find(d => d.id === filterDeviceId)}
                mapRef={mapRef}
                onClose={() => {
                  closeTool();
                  mapRef.current?.clearSeekerPath();
                }} />
            )}

            {/* 마커 클릭 sheet — home 화면 위에서만 의미.
                · 모바일: 항상 (compact 는 시커 활성 시)
                · 데스크톱: 시커 활성 시만 (시커 OFF 일 땐 kakao InfoWindow 가 fallback). */}
            {!fullToolOpen && (!isDesktop || showMiniSeeker) && pointInfo && mapVisible && (
              <PointInfoSheet
                info={pointInfo}
                onClose={() => setPointInfo(null)}
                onRoadview={({ lat, lng }) => { setPointInfo(null); tryOpenRoadview(lat, lng); }}
                compact={showMiniSeeker}
                bottomOffset={showMiniSeeker ? MINI_SEEKER_BOTTOM_HEIGHT : 0}
                leftOffset={showMiniSeeker ? MINI_SEEKER_PANEL_WIDTH : 0}
              />
            )}

            {/* 컴팩트 시커 오버레이 — home + 단말기 필터, 패널 시커/지오펜스 중복 X.
                월/일/시간 3-phase wizard 통합 (구 HomeMapSeeker 흡수). */}
            {showMiniSeeker && mapVisible && filterDeviceId !== null && (
              <MiniSeekerOverlay
                key={filterDeviceId}
                ref={miniSeekerRef}
                loadDates={seekerLoadDates}
                loadDayPoints={seekerLoadDayPoints}
                loadMonthPoints={seekerLoadMonthPoints}
                onPathChange={seekerOnPathChange}
                onPathClear={seekerOnPathClear}
                onSlotSelect={seekerOnSlotSelect} />
            )}
          </div>

          {mapVisible && !fullToolOpen && !showMiniSeeker && !pointInfo && <div className="pt-map-footer">
            <span>{scopeCountReady && <>위치 {positionedCount}개 · 등록 {portalDevices.length}개</>}</span>
            <button type="button" disabled={!scopeCountReady || !mapReady || !positionedCount}
              title="현재 조회 범위의 단말기 위치에 맞춰 지도 범위를 복원합니다."
              onClick={() => {if (mapRef.current?.fitDeviceScope(portalDevices)) setUserTrackPref(false);}}>지도 원래대로</button>
          </div>}
          {/* 모바일/태블릿: 홈 지도 외 탭은 전체 화면 패널로 표시. */}
          {!routeProblem && !isDesktop && view === 'profile' && (
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
      {detailDevice && !pairOpen && <PortalTerminalDetails key={detailDevice.id} device={detailDevice} meta={lastMetaRef.current[detailDevice.id]}
        scopeLabel={scopeOptions.find(option=>option.value===portalScope)?.label || '내 단말기'}
        onClose={closeTerminal} onSave={handleRename} renderAdvanced={renderDeviceTools}
        onMap={id=>{closeTerminal();persistFilterDevice(id);if(view!=='home')setView('home');}}
        connection={enabledServices.length>0 && <DeviceServiceSettings device={detailDevice} services={enabledServices} onNavigate={closeTerminal}
          onChanged={record=>setDevices(ds=>ds.map(item=>item.id===detailDevice.id?{...item,account_type_override:record.override_type}:item))}/>}/>}
      </WorkspaceHeaderContext.Provider>

      </div>

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

      {/* 연결 해제 모달 — 보관/삭제/취소 명시 선택 */}
      {unpairTarget && (
        <UnpairModal
          deviceName={unpairTarget.display_name || unpairTarget.device_uid || `단말기 #${unpairTarget.id}`}
          busy={unpairBusy}
          onClose={() => !unpairBusy && setUnpairTarget(null)}
          onKeep={() => performUnpair(unpairTarget.id, false)}
          onWipe={() => performUnpair(unpairTarget.id, true)}
        />
      )}

      {showOnboarding && <OnboardingModal onDone={() => setShowOnboarding(false)} />}
      {/* 연결 튜토리얼 — /devices/pair 진입 + 단말기 0개 (또는 ?tutorial=1) */}
      {pairTutorialOpen && (
        <PairTutorial
          onClose={() => setPairTutorialOpen(false)}
          onStart={() => {
            setPairTutorialOpen(false);
            // pair modal 은 이미 열려있음 (deep link 처리에서 setPairOpen(true))
            // ICCID 입력 필드로 포커스 보내기
            setTimeout(() => {
              const el = document.getElementById('pair-sim-number');
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
  deviceCard: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8, padding: 10, marginBottom: 8,
    transition: 'opacity .2s',
  },
};
