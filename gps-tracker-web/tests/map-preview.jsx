// Local visual fixture; not an entry point of the production build. No API calls.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import { initTheme } from '../src/theme';
import MapTopOverlay from '../src/components/MapTopOverlay';

initTheme();
function Preview() {
  const [selected, setSelected] = useState(1);
  const [cached, setCached] = useState(false);
  const [longName, setLongName] = useState(false);
  const now = Date.now();
  const devices = [{ id: 1, display_name: longName ? '운행 검증용 아주 긴 이름의 단말기 743490' : '단말-743490', license_plate: longName ? '서울 123가 4567' : '', last_fix_at: new Date(now).toISOString() }, { id: 2, display_name: '다른 단말기' }];
  return <main style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
    <div style={{ padding: 12, fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: 12 }}>
      <label><input type="checkbox" checked={cached} onChange={e => setCached(e.target.checked)} /> 저장 경로</label>
      <label><input type="checkbox" checked={longName} onChange={e => setLongName(e.target.checked)} /> 긴 단말기 이름</label>
    </div>
    <div style={{ flex: 1, minHeight: 320, position: 'relative', background: 'repeating-linear-gradient(140deg,#f1f5f7 0px,#f1f5f7 100px,#fff 101px,#fff 114px,#e3e9ed 115px,#f1f5f7 118px)' }}>
      <MapTopOverlay devices={devices} selected={selected} onSelect={setSelected} mapRef={{ current: null }} showSpeed
        liveSpeed={{ deviceId: 1, speedKmh: 21, recordedAt: new Date(now).toISOString() }} now={now} cachedSources={cached ? { 1: true } : {}} />
      <p style={{ position: 'absolute', bottom: 20, left: 16, color: 'var(--text-3)', fontSize: 12 }}>레이아웃 검증용 · 모의 데이터</p>
    </div>
  </main>;
}
createRoot(document.getElementById('root')).render(<Preview />);
