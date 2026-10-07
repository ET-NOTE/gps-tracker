// Local visual fixture. All API methods are replaced before rendering; never sends data.
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '../src/index.css';
import { initTheme, applyTheme, currentTheme } from '../src/theme';
import MapTopOverlay from '../src/components/MapTopOverlay';
import MapActions from '../src/components/MapActions';
import BottomNav from '../src/components/BottomNav';
import HomeFenceQuick from '../src/components/HomeFenceQuick';
import SeekerSheet from '../src/components/SeekerSheet';
import GeofenceSheet from '../src/components/GeofenceSheet';
import RoutePlannerSheet from '../src/components/RoutePlannerSheet';
import DeviceCardSummary from '../src/components/DeviceCardSummary';
import DeviceDetail from '../src/components/DeviceDetail';
import ProfilePanel from '../src/components/ProfilePanel';
import PointInfoSheet from '../src/components/PointInfoSheet';
import MiniSeekerOverlay from '../src/components/MiniSeekerOverlay';
import { useHomeMapTools } from '../src/hooks/useHomeMapTools';
import { classifyDevice } from '../src/colors';
import { kstDate } from '../src/lib/seeker';
import { api } from '../src/api';
for (const name of Object.keys(api)) api[name] = async () => { throw Error('No backend in visual fixture'); };
Object.assign(api, {
  getMe: async () => ({ id: 1, email: 'preview@example.invalid', display_name: '미리보기', role: 'user' }),
  getAccountType: async () => ({ account_type: 'personal' }), listPhones: async () => [],
  getSimInfo: async () => ({ configured: false }),
  getMyPrefs: async () => ({ seeker: { speed_color: false, show_stops: true } }), patchMyPrefs: async () => ({}),
  getDailyStats: async () => [{ date: kstDate(), distance_m: 0, moving_s: 0, stop_count: 0, max_speed_kmh: 0 }],
  getActiveDates: async () => [], getDeviceEvents: async () => [], listAiAnalyses: async () => [], aiUsageToday: async () => ({}),
  geofenceHistoryAll: async () => [], getDeviceLocationsAggregated: async () => [], listLocationPoints: async () => [],
});
initTheme();
function Preview() {
  const [selected, setSelected] = useState(1), [cached, setCached] = useState(false), [longName, setLongName] = useState(false);
  const [view, setView] = useState('home'), [tracking, setTracking] = useState(true), [fences, setFences] = useState(false);
  const [point, setPoint] = useState(false), [detail, setDetail] = useState(null), [action, setAction] = useState('');
  const mapRef = useRef(null), tools = useHomeMapTools(view, selected != null);
  const now = Date.now();
  const devices = [{ id: 1, device_uid: 'preview-device-001', last_seen_at: new Date(now).toISOString(), last_vbat_mv: 4100,
    display_name: longName ? '운행 검증용 아주 긴 이름의 단말기 743490' : '단말-743490', license_plate: longName ? '서울 123가 4567' : '', last_fix_at: new Date(now).toISOString() },
    { id: 2, device_uid: 'preview-device-002', display_name: '다른 단말기', last_seen_at: new Date(now - 86400000).toISOString() }];
  return <main style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
    <div style={{ padding: 8, flexShrink: 0, fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: 12 }}>
      <label><input type="checkbox" checked={cached} onChange={e => setCached(e.target.checked)} /> 저장 경로</label>
      <label><input type="checkbox" checked={longName} onChange={e => setLongName(e.target.checked)} /> 긴 단말기 이름</label>
      <button onClick={() => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', { syncServer: false, persist: false })}>테마 전환</button>
      <button onClick={() => setPoint(v => !v)}>위치 상세</button>
    </div>
    {view === 'home' && <div style={{ flex: 1, minHeight: 0, position: 'relative', background: 'repeating-linear-gradient(140deg,#f1f5f7 0px,#f1f5f7 100px,#fff 101px,#fff 114px,#e3e9ed 115px,#f1f5f7 118px)' }}>
      {!tools.fullToolOpen && !point && <MapTopOverlay devices={devices} selected={selected} onSelect={setSelected} mapRef={mapRef} showSpeed={tracking && !tools.showMiniSeeker}
        historyMode={tools.showMiniSeeker} liveSpeed={{ deviceId: 1, speedKmh: 21, recordedAt: new Date(now).toISOString() }} now={now} cachedSources={cached ? { 1: true } : {}} />}
      {!tools.fullToolOpen && !point && <>
        <HomeFenceQuick devices={devices} mapRef={mapRef} enabled={fences} onToggleEnabled={setFences} showList={!tools.showMiniSeeker} fabBottom={16 + (tools.showMiniSeeker ? 56 : 0)} />
        <MapActions hasDevice={selected != null} bottom={76 + (fences ? 60 : 0) + (tools.showMiniSeeker ? 56 : 0)} tracking={tracking} paused={tools.showMiniSeeker}
          miniOpen={tools.showMiniSeeker} onTracking={() => setTracking(v => !v)} onMini={tools.toggleMini} onTool={tools.openTool} />
      </>}
      {tools.showSeeker && <SeekerSheet device={devices.find(d => d.id === selected)} mapRef={mapRef} onClose={tools.closeTool} />}
      {tools.showGeofence && <GeofenceSheet devices={devices} mapRef={mapRef} filterDeviceId={selected} showFences={fences}
        onToggleShow={setFences} alertEnabled={true} onClose={tools.closeTool} />}
      {tools.showRoutePlanner && <RoutePlannerSheet mapRef={mapRef} onClose={tools.closeTool} />}
      {tools.showMiniSeeker && <MiniSeekerOverlay loadDates={async () => [kstDate()]} loadDayPoints={async () => []} loadMonthPoints={async () => []} onPathChange={() => {}} onPathClear={() => {}} onSlotSelect={() => {}} />}
      {point && <PointInfoSheet info={{ kind: 'main', label: devices[0].display_name, color: '#2563eb', lat: 37.5, lng: 127,
        meta: { recordedAt: new Date(now).toISOString(), speedKmh: 21, vbatMv: 4100, cbcMv: 4080, sat: 8 }, addr: { road: '검증용 모의 주소' } }}
        compact={tools.showMiniSeeker} bottomOffset={tools.showMiniSeeker ? 56 : 0} leftOffset={tools.showMiniSeeker ? 128 : 0} onClose={() => setPoint(false)} onRoadview={() => setAction('로드뷰')} />}
      <p style={{ position: 'absolute', bottom: 0, left: 16, color: '#666', fontSize: 12, pointerEvents: 'none' }}>레이아웃 검증용 · 모의 데이터</p>
    </div>}
    {view === 'devices' && <div style={{ flex: 1, overflow: 'auto', padding: 16, background: 'var(--bg)' }}>
      <h2 style={{ fontSize: 20, marginBottom: 16 }}>내 단말기</h2><p role="status">{action}</p>
      {devices.map(d => <article key={d.id} style={{ padding: 16, background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: '4px solid var(--primary)', borderRadius: 12, marginBottom: 12 }}>
        <DeviceCardSummary device={d} status={classifyDevice(d)} color="#2563eb" detailOpen={detail === d.id}
          onView={() => { setView('home'); setSelected(d.id); }} onDetail={() => setDetail(detail === d.id ? null : d.id)}
          onPin={() => setAction('고정')} onReceive={() => setAction('수신 로그')} onColor={() => setAction('색상 변경')}
          onRename={() => setAction('이름 변경')} onUnpair={() => setAction('연결 해제 확인 진입')} />
        {detail === d.id && <DeviceDetail device={d} onUpdated={() => {}} />}
      </article>)}
    </div>}
    {view === 'profile' && <div style={{ flex: 1, minHeight: 0 }}><ProfilePanel onLogout={() => {}} /></div>}
    <BottomNav active={view} onChange={setView} isCorporate />
  </main>;
}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><Preview /></MemoryRouter></QueryClientProvider>);
