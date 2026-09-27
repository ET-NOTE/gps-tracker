import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { create, act } from 'react-test-renderer';
import { transform } from 'esbuild';
import { isSeekerVisible, kstDate, bucket10min, seekerBucket } from '../src/lib/seeker.js';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const point = (at, lat = 37.5) => ({ recorded_at: at, lat, lng: 127, speed_kmh: 18, speed_source: 'server_coordinate_v1' });
const row = (at, lat = 37.5) => ({ recorded_at_last: at, lat_last: lat, lng_last: 127, speed_kmh: 18, speed_max_kmh: 25, speed_source: 'server_coordinate_v1', fix_count: 60 });
const text = r => JSON.stringify(r.toJSON());
const button = (r, label) => r.root.findAllByType('button').find(b => b.children.join('') === label || b.props['aria-label'] === label);

async function fixture(api = {}) {
  const defaults = { getMyPrefs: async () => ({ seeker: { speed_color: false, show_stops: true } }), patchMyPrefs: async () => ({}),
    getDailyStats: async () => [], getActiveDates: async () => [], aiUsageToday: async () => ({}), listAiAnalyses: async () => [], getDeviceEvents: async () => [], ...api };
  const values = new Map();
  const storage = { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k, v) };
  const window = new EventTarget();
  const document = new EventTarget(); document.visibilityState = 'visible';
  const styles = new Map(); const attrs = new Map();
  document.documentElement = { style: { setProperty: (k,v) => styles.set(k,v) }, setAttribute: (k,v) => attrs.set(k,v), getAttribute: k => attrs.get(k) };
  const context = vm.createContext({ console, window, document, localStorage: storage, sessionStorage: storage,
    navigator: {}, Event, DOMException, AbortController, setTimeout, clearTimeout });
  const cache = new Map();
  function synthetic(exports) { return new vm.SyntheticModule(Object.keys(exports), function() { for (const [k,v] of Object.entries(exports)) this.setExport(k,v); }, { context }); }
  async function load(file) {
    if (cache.has(file)) return cache.get(file);
    const pending = (async () => {
    let m;
    if (file === 'react') m = synthetic(React);
    else if (file === 'react/jsx-runtime') m = synthetic(jsx);
    else if (file.endsWith('/api.js')) m = synthetic({ api: defaults });
    else if (file.endsWith('/authSession.js')) m = synthetic({ authScope: () => 'test-session' });
    else if (file.endsWith('/Icon.jsx')) m = synthetic({ default: () => null });
    else if (file.endsWith('/useBreakpoint.js')) m = synthetic({ default: () => 'desktop' });
    else if (file.endsWith('/useSwipeDownClose.js')) m = synthetic({ default: () => ({}) });
    else if (file.endsWith('/Dialog.jsx')) m = synthetic({ confirmDialog: async () => false, alertDialog: async () => {} });
    else {
      let source = await readFile(file, 'utf8');
      if (file.endsWith('.jsx')) source = (await transform(source, { loader: 'jsx', jsx: 'automatic', format: 'esm' })).code;
      m = new vm.SourceTextModule(source, { context, identifier: file });
    }
    await m.link(async (specifier, parent) => {
      if (!specifier.startsWith('.')) return load(specifier);
      let target = path.resolve(path.dirname(parent.identifier), specifier).replaceAll('\\', '/');
      if (!/\.(js|jsx)$/.test(target)) {
        try { await readFile(target + '.js'); target += '.js'; } catch { target += '.jsx'; }
      }
      return load(target);
    });
    return m;
    })();
    cache.set(file, pending);
    return pending;
  }
  return { window, context, styles, module: async name => { const m = await load(path.resolve(src, name).replaceAll('\\', '/')); await m.evaluate(); return m.namespace; } };
}

test('shared time/sampling contract: KST midnight, explicit monthly 1m, visible seeker only', () => {
  assert.equal(kstDate('2026-09-23T15:01:00Z'), '2026-09-24');
  assert.equal(bucket10min('2026-09-23T15:11:00Z'), '00:10');
  assert.equal(seekerBucket('month', '1m'), '1m');
  assert.equal(seekerBucket('month', 'auto'), '1h');
  assert.equal(isSeekerVisible('home', 1, true, false), false);
  assert.equal(isSeekerVisible('tools', 1, false, true), false);
  assert.equal(isSeekerVisible('home', 1, false, true), true);
  assert.equal(isSeekerVisible('home', null, true, true), false);
});

test('compact: loading/error/empty are distinct, retry works, late month cannot replace day', async () => {
  const f = await fixture(); const Mini = (await f.module('components/MiniSeekerOverlay.jsx')).default;
  const dates = deferred(), month = deferred(), day = deferred(); const drawn = [];
  let calls = 0, monthSignal, daySignal;
  const props = { loadDates: () => dates.promise, loadMonthPoints: (_, options) => { monthSignal = options.signal; return month.promise; },
    loadDayPoints: (_, options) => { daySignal = options.signal; calls++; return calls === 1 ? day.promise : Promise.resolve([]); },
    onPathChange: rows => drawn.push(rows), onPathClear: () => {} };
  let r; await act(async () => { r = create(React.createElement(Mini, props)); });
  assert.match(text(r), /날짜 불러오는 중/); assert.doesNotMatch(text(r), /활동 기록 없음/);
  await act(async () => dates.resolve(['2026-09-24']));
  await act(async () => button(r, '2026-09 일별 기록 열기').props.onClick());
  assert.equal(monthSignal.aborted, true);
  assert.doesNotMatch(text(r), /이 날에 기록이 없습니다/);
  await act(async () => month.resolve([point('2026-09-24T00:00:00Z')]));
  assert.equal(drawn.length, 0);
  await act(async () => day.reject(new Error('연결 끊김')));
  assert.match(text(r), /연결 끊김/); assert.doesNotMatch(text(r), /이 날에 기록이 없습니다/);
  await act(async () => button(r, '다시 시도').props.onClick());
  assert.match(text(r), /이 날에 기록이 없습니다/); assert.equal(calls, 2);
  await act(async () => r.unmount()); assert.equal(daySignal.aborted, true);
});

test('compact: failed date index exposes retry without claiming no records', async () => {
  const f = await fixture(); const Mini = (await f.module('components/MiniSeekerOverlay.jsx')).default;
  let calls = 0, r;
  const props = { loadDates: async () => { if (++calls === 1) throw Error('목록 실패'); return []; } };
  await act(async () => { r = create(React.createElement(Mini, props)); });
  assert.match(text(r), /목록 실패/); assert.doesNotMatch(text(r), /활동 기록 없음/);
  await act(async () => button(r, '다시 시도').props.onClick());
  assert.match(text(r), /활동 기록 없음/); assert.equal(calls, 2);
  await act(async () => r.unmount());
});

test('compact: marker drill-down changes date and selects a point from that date', async () => {
  const f = await fixture(); const Mini = (await f.module('components/MiniSeekerOverlay.jsx')).default;
  const ref = React.createRef(), selected = [], dates = [];
  const props = { ref, loadDates: async () => ['2026-09-24', '2026-09-23'], loadMonthPoints: async () => [],
    loadDayPoints: async d => { dates.push(d); return [point(`${d}T01:00:00Z`)]; },
    onSlotSelect: p => selected.push(p), onPathClear: () => {} };
  let r; await act(async () => { r = create(React.createElement(Mini, props)); });
  await act(async () => ref.current.selectByTime('2026-09-24T01:00:00Z'));
  await act(async () => ref.current.selectByTime('2026-09-23T01:00:00Z'));
  assert.deepEqual(dates, ['2026-09-24', '2026-09-23']);
  assert.equal(selected.at(-1).recorded_at, '2026-09-23T01:00:00Z');
  await act(async () => r.unmount());
});

test('detailed: selected empty morning stays selected, failed precision refresh clears path and exports', async () => {
  const slow = deferred(), calls = [], drawn = []; let cleared = 0;
  const f = await fixture({ getDeviceLocationsAggregated: (...args) => { calls.push(args); return calls.length === 1
    ? Promise.resolve([row(`${kstDate()}T08:30:00Z`), row(`${kstDate()}T08:31:00Z`,37.503)]) : slow.promise; } });
  const Seeker = (await f.module('components/SeekerSheet.jsx')).default;
  const props = { device: { id: 1, color: '#123456' }, mapRef: { current: { clearSeekerPath() { cleared++; }, drawSeekerPath(p) { drawn.push(p); return { setCursor() {} }; } } }, onClose() {} };
  let r; await act(async () => { r = create(React.createElement(Seeker, props)); });
  const nativeSpace = new Event('keydown', { cancelable: true });
  Object.defineProperty(nativeSpace, 'key', { value: ' ' });
  f.window.closest = () => ({});
  f.window.dispatchEvent(nativeSpace);
  assert.equal(nativeSpace.defaultPrevented, false);
  await act(async () => button(r, '오전 (06~12)').props.onClick());
  assert.equal(r.root.findByProps({ 'aria-label': '시작 시각 (한국 시간)' }).props.value, 36);
  assert.match(text(r), /이 시간 범위에 데이터 없음/);
  await act(async () => button(r, '24시간').props.onClick());
  assert.equal(r.root.findByProps({ 'aria-label': '시작 시각 (한국 시간)' }).props.value, 0);
  await act(async () => button(r, '5분').props.onClick());
  assert.match(text(r), /경로 불러오는 중/); assert.doesNotMatch(text(r), /GPX/);
  await act(async () => slow.reject(new Error('네트워크 실패')));
  assert.match(text(r), /네트워크 실패/); assert.doesNotMatch(text(r), /GPX/); assert.ok(cleared > 0);
  assert.equal(calls[1][1], '5m');
  await act(async () => r.unmount());
});

test('detailed: late result is ignored after mode change; monthly 1m really requests 1m', async () => {
  const slow = deferred(), calls = [];
  const f = await fixture({ getDeviceLocationsAggregated: (...args) => { calls.push(args); return calls.length === 1 ? slow.promise : Promise.resolve([]); } });
  const Seeker = (await f.module('components/SeekerSheet.jsx')).default;
  const mapRef = { current: { clearSeekerPath() {}, drawSeekerPath() { throw Error('late day rendered'); } } };
  let r; await act(async () => { r = create(React.createElement(Seeker, { device: { id:1, color:'#123456' }, mapRef, onClose() {} })); });
  await act(async () => button(r, '월간').props.onClick());
  assert.equal(calls[0][4].signal.aborted, true);
  await act(async () => slow.resolve([row(`${kstDate()}T08:30:00Z`)]));
  await act(async () => button(r, '1분').props.onClick());
  assert.equal(calls.at(-1)[1], '1m');
  await act(async () => r.unmount());
});

test('monthly calendar keeps raw activity selectable while daily statistics catch up', async () => {
  const f = await fixture({ getDeviceLocationsAggregated: async () => [], getActiveDates: async () => [kstDate()] });
  const Seeker = (await f.module('components/SeekerSheet.jsx')).default;
  let r; await act(async () => { r = create(React.createElement(Seeker, { device: { id:1, color:'#123456' }, mapRef: { current: { clearSeekerPath() {} } }, onClose() {} })); });
  await act(async () => button(r, '월간').props.onClick());
  assert.equal(button(r, `${kstDate()} 일간 경로`).props.disabled, false);
  assert.match(text(r), /일별 통계 집계를 기다리는 중/);
  await act(async () => button(r, `${kstDate()} 일간 경로`).props.onClick());
  assert.equal(button(r, '일간').props['aria-pressed'], true);
  await act(async () => r.unmount());
});

test('theme: invalid names normalize, storage failure still renders, foregrounds have readable contrast', async () => {
  const f = await fixture(); const theme = await f.module('theme.js');
  let changes = 0; f.window.addEventListener('gps-theme-changed', () => changes++);
  theme.applyTheme('invalid', { syncServer: false }); assert.equal(theme.currentTheme(), 'dark');
  f.context.localStorage.setItem = () => { throw Error('storage unavailable'); };
  theme.applyTheme('light', { syncServer: false }); assert.equal(theme.currentTheme(), 'light'); assert.equal(changes, 2);
  const luminance = hex => {
    let h = hex.slice(1); if (h.length === 3) h = [...h].map(c => c+c).join('');
    const rgb = [0,2,4].map(i => parseInt(h.slice(i,i+2),16)/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4);
    return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
  };
  const ratio = (a,b) => (Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
  for (const tokens of Object.values(theme.THEMES)) {
    assert.ok(ratio(tokens['--primary'], tokens['--primary-fg']) >= 4.5);
    assert.ok(ratio(tokens['--text-3'], tokens['--surface']) >= 4.5);
    assert.ok(ratio(tokens['--text-3'], tokens['--surface-2']) >= 4.5);
  }
});
