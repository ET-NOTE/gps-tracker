import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './index.css';
const App = React.lazy(() => import('./App'));
const DemoWorkspace = React.lazy(() => import('./pages/DemoWorkspace'));
const basename = (import.meta.env.BASE_URL || '/').replace(/\/$/, '') || undefined;

// (F5-c) Service Worker 등록 — production build 만.
// dev 에선 SW 가 asset hot-reload 를 캐시로 가려 개발 방해.
// 도메인 root 스코프에서 /sw.js 로만 등록 — legacy /gps-tracker/app/ base 는 skip.
if ('serviceWorker' in navigator && import.meta.env.PROD
    && location.pathname.startsWith('/gps-tracker/') === false) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('SW register failed', err);
    });
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter basename={basename}>
      <React.Suspense fallback={<div role="status" style={{padding:24}}>화면을 불러오는 중…</div>}>
        <Routes>
          <Route path="/demo/*" element={<DemoWorkspace />} />
          <Route path="*" element={<App />} />
        </Routes>
      </React.Suspense>
    </BrowserRouter>
  </React.StrictMode>
);
