// 라우팅 — react-router 기반 path-routing.
//
// 외부 deep link (예: kakao 알림톡 "단말기 등록하기" 버튼) 가 안정적인 URL 패턴을
// 가져야 하므로 query-string sessionStorage 임시 방식 대신 path-based 라우팅 채택.
//
// 라우트 구조:
//   /s/:token                   → 공유 (인증 X)
//   /payments/toss/success|fail → Toss 결과 (인증 X)
//   /privacy /terms             → 약관 (인증 X)
//   /login                      → 로그인 (미인증, 인증 시 next 로 redirect)
//   /devices /devices/pair      → 단말기 (인증 필요)
//   /profile                    → 내정보 (인증 필요)
//   /admin                      → 관리자 (인증 필요)
//   /                           → 홈 / 지도 (인증 필요)
//
// 이중 base 지원: vite base = '/gps-tracker/app/' OR '/' (gps.serial.kr 빌드).
// BrowserRouter basename 으로 흡수.
import { useState, useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';

// Dashboard 는 홈이라 critical — sync import 유지.
import Dashboard from './pages/Dashboard';
import DialogHost from './components/Dialog';
import {
  ToastHost, CommandPaletteHost,
  togglePalette, registerCommands, registerDevices,
} from './components/ui';
import { useDevices } from './state';
import { toggleTheme } from './theme';
import { api, clearTokens } from './api';
import { startPhoneTracker, stopPhoneTracker } from './lib/phoneTracker';

// 나머지 라우트는 각자 진입할 때만 로드 — 초기 bundle 축소.
const Auth           = lazy(() => import('./pages/Auth'));
const SharePage      = lazy(() => import('./pages/SharePage'));
const PaymentResult  = lazy(() => import('./pages/PaymentResult'));
const LegalPage      = lazy(() => import('./pages/LegalPage'));
const DiagnosticPage = lazy(() => import('./pages/DiagnosticPage'));
const HandoffPage    = lazy(() => import('./pages/HandoffPage'));
const FleetDashboard = lazy(() => import('./pages/FleetDashboard'));

const LazyFallback = () => (
  <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
    로딩 중…
  </div>
);

const BASENAME = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

export default function App() {
  return (
    <BrowserRouter basename={BASENAME || undefined}>
      <Shell />
      <DialogHost />
      <ToastHost />
      <PaletteBridge />
      <PhoneTrackerBootstrap />
    </BrowserRouter>
  );
}

// (2026-07-29) 연구소 lab_phone_tracker=true 인 사용자의 위치 tracking 자동 재시작.
// 사용자가 새로고침 / 재접속 시 매번 Lab 탭 방문 안 하도록 mount 시 1회 프렌즈 로드.
function PhoneTrackerBootstrap() {
  useEffect(() => {
    const hasToken = !!(localStorage.getItem('access_token') || sessionStorage.getItem('access_token'));
    if (!hasToken) return;
    let cancelled = false;
    (async () => {
      try {
        const prefs = await api.getMyPrefs();
        if (cancelled || !prefs?.lab_phone_tracker) return;
        await startPhoneTracker();
      } catch (e) {
        // 조용히 실패 — 사용자가 명시적으로 다시 Lab 탭에서 켤 수 있음.
        console.warn('phone tracker auto-resume failed:', e.message || e);
      }
    })();
    return () => { cancelled = true; stopPhoneTracker(); };
  }, []);
  return null;
}

// (F5-b) Cmd+K palette host + commands 등록 + device 자동 sync.
// Shell 안에 있으면 useNavigate 사용 가능 (BrowserRouter context).
function PaletteBridge() {
  const nav = useNavigate();
  // 로그인 페이지에선 devices fetch 안 되도록 authed 조건. 간단히 localStorage 체크.
  const hasToken = () => !!(localStorage.getItem('access_token') || sessionStorage.getItem('access_token'));
  const { data: devices } = useDevices({ enabled: hasToken() });

  // Cmd+K / Ctrl+K global bind.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        togglePalette();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 정적 액션 등록.
  useEffect(() => {
    registerCommands([
      { id: 'nav-home',    label: '홈 (Dashboard)',       icon: 'home',   group: '이동', run: () => nav('/') },
      { id: 'nav-fleet',   label: 'Fleet 대시보드',        icon: 'route',  group: '이동', run: () => nav('/fleet') },
      { id: 'nav-diag',    label: '진단 콘솔',              icon: 'wrench', group: '이동', run: () => nav('/diagnostic') },
      { id: 'ui-theme',    label: '테마 전환 (다크/라이트)', icon: 'sun',    group: '설정', run: () => toggleTheme() },
      { id: 'auth-logout', label: '로그아웃',                icon: 'power',  group: '설정', run: () => { clearTokens(); window.location.href = '/login'; } },
    ]);
  }, [nav]);

  // devices 리스트 sync.
  useEffect(() => {
    registerDevices(devices || []);
  }, [devices]);

  return <CommandPaletteHost onSelectDevice={d => nav(`/fleet?device=${d.id}`)} />;
}

function Shell() {
  // remember_me=true 면 localStorage, false 면 sessionStorage — 양쪽 모두 체크.
  // 토큰 변동 추적 — 다른 탭에서 logout 등 동기화는 storage 이벤트로 (sessionStorage 는
  // 탭 분리라 동기화 안 됨 — 그것이 의도).
  const hasToken = () =>
    !!(localStorage.getItem('access_token') || sessionStorage.getItem('access_token'));
  const [authed, setAuthed] = useState(hasToken);
  useEffect(() => {
    const sync = () => setAuthed(hasToken());
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  return (
    <Suspense fallback={<LazyFallback />}>
      <Routes>
        {/* 공개 */}
        <Route path="/s/:token" element={<ShareRoute />} />
        <Route path="/handoff/:token" element={<HandoffRoute />} />
        <Route path="/payments/toss/success" element={<PaymentResult kind="success" />} />
        <Route path="/payments/toss/fail"    element={<PaymentResult kind="fail" />} />
        <Route path="/privacy" element={<LegalPage kind="privacy" />} />
        <Route path="/terms"   element={<LegalPage kind="terms" />} />

        {/* 로그인 */}
        <Route path="/login" element={
          authed
            ? <Navigate to={readNext() || '/'} replace />
            : <AuthRoute onLogin={() => setAuthed(true)} />
        } />

        {/* 14_* 진단 콘솔 — Dashboard 외부 풀스크린 */}
        <Route path="/diagnostic" element={
          authed ? <DiagnosticPage /> : <RequireAuthRedirect />
        } />

        {/* (F4-b) 신규 Unified Fleet Dashboard — beta, 참고 이미지 스타일 */}
        <Route path="/fleet" element={
          authed ? <FleetDashboard /> : <RequireAuthRedirect />
        } />

        {/* 보호된 영역 — 미인증이면 로그인으로 (next 보존) */}
        <Route path="/*" element={
          authed
            ? <Dashboard onLogout={() => setAuthed(false)} />
            : <RequireAuthRedirect />
        } />
      </Routes>
    </Suspense>
  );
}

function HandoffRoute() {
  const loc = useLocation();
  const m = loc.pathname.match(/\/handoff\/([A-Za-z0-9_-]+)/);
  return <HandoffPage token={m?.[1]} />;
}

function ShareRoute() {
  // useParams 대신 location 으로 (역호환 용이)
  const loc = useLocation();
  const m = loc.pathname.match(/\/s\/([A-Za-z0-9_-]+)/);
  return <SharePage token={m?.[1]} />;
}

function AuthRoute({ onLogin }) {
  const navigate = useNavigate();
  const next = readNext();
  return (
    <Auth
      onLogin={() => {
        onLogin();
        navigate(next || '/', { replace: true });
      }}
    />
  );
}

function RequireAuthRedirect() {
  const loc = useLocation();
  const target = loc.pathname + loc.search;
  return <Navigate to={`/login?next=${encodeURIComponent(target)}`} replace />;
}

function readNext() {
  const qs = new URLSearchParams(window.location.search);
  const next = qs.get('next');
  // 절대 URL/외부 도메인 차단 — 우리 base 안에서만 허용
  if (!next || !next.startsWith('/') || next.startsWith('//')) return null;
  return next;
}
