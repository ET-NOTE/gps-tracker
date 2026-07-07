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

// 나머지 라우트는 각자 진입할 때만 로드 — 초기 bundle 축소.
const Auth           = lazy(() => import('./pages/Auth'));
const SharePage      = lazy(() => import('./pages/SharePage'));
const PaymentResult  = lazy(() => import('./pages/PaymentResult'));
const LegalPage      = lazy(() => import('./pages/LegalPage'));
const DiagnosticPage = lazy(() => import('./pages/DiagnosticPage'));

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
    </BrowserRouter>
  );
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
