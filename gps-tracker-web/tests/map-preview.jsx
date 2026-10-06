// Local visual fixture; not an entry point of the production build. No API calls.
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import { initTheme } from '../src/theme';
import MapTopOverlay from '../src/components/MapTopOverlay';
import MapActions from '../src/components/MapActions';
import BottomNav from '../src/components/BottomNav';
import HomeFenceQuick from '../src/components/HomeFenceQuick';
import SeekerSheet from '../src/components/SeekerSheet';
import GeofenceSheet from '../src/components/GeofenceSheet';
import RoutePlannerSheet from '../src/components/RoutePlannerSheet';
import { useHomeMapTools } from '../src/hooks/useHomeMapTools';
import { api } from '../src/api';

// All calls stay in memory, including preference writes made by real panels.
for (const name of Object.keys(api)) api[name] = async () => { throw Error('No backend in visual fixture'); };
Object.assign(api, {
  getMyPrefs: async () => ({ seeker: { speed_color: false, show_stops: true } }), patchMyPrefs: async () => ({}),
  getDailyStats: async () => [], getActiveDates: async () => [], getDeviceEvents: async () => [],
  listAiAnalyses: async () => [], aiUsageToday: async () => ({}), geofenceHistoryAll: async () => [],
  getDeviceLocationsAggregated: async () => [], listLocationPoints: async () => [],
});

initTheme();
function Preview() {
  const [selected, setSelected] = useState(1);
  const [cached, setCached] = useState(false);
  const [longName, setLongName] = useState(false);
  const [view, setView] = useState('home');
  const [tracking, setTracking] = useState(true);
  const [fences, setFences] = useState(false);
  const mapRef = useRef(null);
  const tools = useHomeMapTools(view, selected != null);
  const now = Date.now();
  const devices = [{ id: 1, display_name: longName ? '운행 검증용 아주 긴 이름의 단말기 743490' : '단말-743490', license_plate: longName ? '서울 123가 4567' : '', last_fix_at: new Date(now).toISOString() }, { id: 2, display_name: '다른 단말기' }];
  return <main style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
    <div style={{ padding: 12, fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: 12 }}>
      <label><input type="checkbox" checked={cached} onChange={e => setCached(e.target.checked)} /> 저장 경로</label>
      <label><input type="checkbox" checked={longName} onChange={e => setLongName(e.target.checked)} /> 긴 단말기 이름</label>
    </div>
    <div style={{ flex: 1, minHeight: 0, position: 'relative', background: 'repeating-linear-gradient(140deg,#f1f5f7 0px,#f1f5f7 100px,#fff 101px,#fff 114px,#e3e9ed 115px,#f1f5f7 118px)' }}>
      {!tools.fullToolOpen && <MapTopOverlay devices={devices} selected={selected} onSelect={setSelected} mapRef={mapRef} showSpeed={tracking && !tools.showMiniSeeker}
        liveSpeed={{ deviceId: 1, speedKmh: 21, recordedAt: new Date(now).toISOString() }} now={now} cachedSources={cached ? { 1: true } : {}} />}
      {view === 'home' && !tools.fullToolOpen && <>
        <HomeFenceQuick devices={devices} mapRef={mapRef} enabled={fences} onToggleEnabled={setFences} />
        <MapActions hasDevice={selected != null} bottom={76 + (fences ? 60 : 0)} tracking={tracking} paused={tools.showMiniSeeker}
          miniOpen={tools.showMiniSeeker} onTracking={() => setTracking(v => !v)} onMini={tools.toggleMini} onTool={tools.openTool} />
      </>}
      {tools.showSeeker && <SeekerSheet device={devices.find(d => d.id === selected)} mapRef={mapRef} onClose={tools.closeTool} />}
      {tools.showGeofence && <GeofenceSheet devices={devices} mapRef={mapRef} filterDeviceId={selected} showFences={fences}
        onToggleShow={setFences} alertEnabled={true} onClose={tools.closeTool} />}
      {tools.showRoutePlanner && <RoutePlannerSheet mapRef={mapRef} onClose={tools.closeTool} />}
      <p style={{ position: 'absolute', bottom: 20, left: 16, color: 'var(--text-3)', fontSize: 12, pointerEvents: 'none' }}>레이아웃 검증용 · 모의 데이터</p>
    </div>
    <BottomNav active={view} onChange={setView} isCorporate />
  </main>;
}
createRoot(document.getElementById('root')).render(<Preview />);
