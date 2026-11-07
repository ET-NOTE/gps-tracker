import useBreakpoint from '../useBreakpoint';
import './FleetDashboard.css';
// (2026-07-28) Phase F4-b — Unified Fleet Dashboard.
//
// 참고 이미지 (cartax-style) 대응: 상단 요약 chips + 좌측 device list (react-window virtualize)
// + 중앙 map (MarkerClusterer 활성) + 우측 SelectedDevicePanel (이벤트/운행 이력 tabs).
//
// F4-b-1: shell + 3-panel + last position markers
// F4-b-2: WS live 갱신 + map marker click sync + trip 클릭 → seeker path

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useDevices } from '../state';
import { api } from '../api';
import { serverSpeed } from '../lib/speed';
import { TrackerWS } from '../ws';
import KakaoMap from '../components/KakaoMap';
import SummaryChips from '../components/fleet/SummaryChips';
import { fleetStatusGroup, FLEET_GROUPS } from '../lib/fleetStatus';
import { vehicleName } from '../lib/business';
import { latestFleetPosition, validFleetPosition } from '../lib/fleetPositions';
import DeviceListPanel from '../components/fleet/DeviceListPanel';
import SelectedDevicePanel from '../components/fleet/SelectedDevicePanel';
import Icon from '../components/Icon';

export default function FleetDashboard() {
  const nav = useNavigate();
  const compact = useBreakpoint() !== 'desktop';
  const [mobilePanel, setMobilePanel] = useState('list');
  const [selectionNotice, setSelectionNotice] = useState('');
  const loc = useLocation();
  // URL is the source of truth, including same-page links and browser Back.
  const qs = new URLSearchParams(loc.search);
  const filter = FLEET_GROUPS.some(group => group.id === qs.get('filter')) ? qs.get('filter') : 'all';
  const deviceParam = qs.get('device');
  const parsedId = /^\d+$/.test(deviceParam ?? '') ? Number(deviceParam) : NaN;
  const selectedId = qs.getAll('device').length === 1 && Number.isSafeInteger(parsedId) && parsedId > 0 ? parsedId : null;
  const query = qs.get('q') || '';
  const updateSearch = useCallback((key, value) => {
    const next = new URLSearchParams(loc.search);
    if (value == null || value === '') next.delete(key); else next.set(key, String(value));
    nav({ pathname: loc.pathname, search: next.toString(), hash: loc.hash }, { replace: true });
  }, [nav, loc.pathname, loc.search, loc.hash]);
  const setSelectedId = useCallback(id => updateSearch('device', id), [updateSearch]);
  const setQuery = value => updateSearch('q', value);
  const setFilter = value => updateSearch('filter', value === 'all' ? null : value);

  const { data: devices = [], isSuccess, isPending, isError, refetch } = useDevices({ refetchInterval: 30_000 });
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);

  // 필터 적용된 device 목록.
  const filtered = useMemo(() => {
    if (filter === 'all') return devices;
    return devices.filter(d => fleetStatusGroup(d, now) === filter);
  }, [devices, filter, now]);

  const selectedDevice = useMemo(
    () => devices.find(d => d.id === selectedId) || null,
    [devices, selectedId]
  );

  useEffect(() => {
    if (isSuccess && deviceParam != null && !selectedDevice) {
      setSelectedId(null);
      setSelectionNotice('이 계정에서 확인할 수 없는 단말기입니다. 목록에서 다시 선택해 주세요.');
      setMobilePanel('list');
    }
  }, [isSuccess, deviceParam, selectedDevice, setSelectedId]);
  useEffect(() => { if (selectedDevice) setMobilePanel('detail'); }, [selectedDevice?.id]);

  // Failed refreshes retain the last successful result for this device only.
  const [eventState, setEventState] = useState({ deviceId: null, data: null, loading: false, error: false });
  const eventRevision = useRef(0);
  const [eventRefresh, setEventRefresh] = useState(0);
  useEffect(() => {
    const id = selectedDevice?.id;
    if (!id) { setEventState({ deviceId: null, data: null, loading: false, error: false }); return; }
    let cancelled = false;
    const load = async () => {
      const revision = ++eventRevision.current;
      setEventState(prev => ({ deviceId: id, data: prev.deviceId === id ? prev.data : null, loading: true, error: false }));
      try {
        const data = await api.getDeviceEvents(id, { limit: 20 });
        if (!cancelled && revision === eventRevision.current) setEventState({ deviceId: id, data: data || [], loading: false, error: false });
      } catch {
        if (!cancelled && revision === eventRevision.current) setEventState(prev => ({ ...prev, loading: false, error: true }));
      }
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => { cancelled = true; eventRevision.current++; clearInterval(timer); };
  }, [selectedDevice?.id, eventRefresh]);
  const currentEvents = eventState.deviceId === selectedDevice?.id ? eventState : { data: null, loading: !!selectedDevice, error: false };

  // KakaoMap 인스턴스 & marker 배치.
  const mapRef = useRef(null);
  const mapReadyRef = useRef(false);
  const [mapReady, setMapReady] = useState(0);
  const handleMapReady = useCallback(() => { mapReadyRef.current = false; drawnMarkers.current.clear(); setMapReady(value => value + 1); }, []);
  const selectDevice = useCallback(id => {
    setSelectedId(id); setSelectionNotice(''); setMobilePanel('detail');
  }, [setSelectedId]);

  // (F4-b-2) map marker click → selectedId sync.
  // KakaoMap onPointInfo prop 은 marker/dot click 시 { kind, deviceId, ... } 콜백.
  const handlePointInfo = useCallback((p) => {
    if (p?.kind === 'main' && p?.meta?.deviceId != null) {
      selectDevice(p.meta.deviceId);
    }
  }, [selectDevice]);

  const tripRevision = useRef(0);
  useEffect(() => () => { tripRevision.current++; }, []);

  // (F4-b-2) 선택된 trip → seeker path.
  // (F7-a) ?canvas=1 URL flag 로 canvas overlay 시험 사용. 안정성 검증 후 default 전환.
  const useCanvasSeeker = qs.get('canvas') === '1';
  const [selectedTrip, setSelectedTrip] = useState(null);   // 전체 trip 객체 (TripDetailTab 이 참조)
  const [tripPoints, setTripPoints] = useState(null);
  const [tripLoad, setTripLoad] = useState({ status: 'idle' });
  const selectedTripKey = selectedTrip?.started_at ?? null;

  // 선택 시 map focus.
  useEffect(() => {
    tripRevision.current++;
    if (!mapRef.current) return;
    if (selectedId != null) mapRef.current.filterToDevice?.(selectedId, { fit: false });
    else                    mapRef.current.filterToDevice?.(null,       { fit: false });
    // trip 선택 초기화
    setSelectedTrip(null);
    setTripPoints(null);
    setTripLoad({ status: 'idle' });
    mapRef.current.clearSeekerPathCanvas?.();
    mapRef.current.clearSeekerPath?.();
    mapRef.current.setSeekerMode?.(false);
  }, [selectedId, selectedDevice?.id, mapReady, useCanvasSeeker]);

  const [positions, setPositions] = useState({});
  const drawnMarkers = useRef(new Map());
  const lastFocusId = useRef(null);
  const positionKey = devices.map(d => `${d.id}:${d.last_fix_at || ''}:${d.last_lat}:${d.last_lng}:${vehicleName(d)}:${d.device_color}`).join(',');
  useEffect(() => {
    setPositions(previous => {
      const next = {};
      for (const d of devices) {
        const snapshot = Number.isFinite(Date.parse(d.last_fix_at)) ? { lat: d.last_lat, lng: d.last_lng, recordedAt: d.last_fix_at } : null;
        const point = latestFleetPosition(previous[d.id], snapshot);
        if (point) next[d.id] = point;
      }
      return next;
    });
  }, [positionKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const m = mapRef.current;
    if (!mapReady || !m?.updateMarker) return;
    if (lastFocusId.current !== selectedId) { mapReadyRef.current = false; lastFocusId.current = selectedId; }
    const owned = new Set(devices.map(d => d.id));
    for (const id of drawnMarkers.current.keys()) {
      if (!owned.has(id)) { m.removeMarker?.(id); drawnMarkers.current.delete(id); }
    }
    for (const d of devices) {
      const point = positions[d.id];
      if (!point) continue;
      const label = vehicleName(d);
      const color = d.device_color || '#5B7CFF';
      const signature = JSON.stringify([point, label, color]);
      if (drawnMarkers.current.get(d.id) !== signature) {
        m.updateMarker(d.id, point.lat, point.lng, label, color, { ...point, deviceId: d.id, deviceLabel: label });
        drawnMarkers.current.set(d.id, signature);
      }
    }
    // An empty initial fetch must not consume the one-time fit. This also
    // handles the first GNSS fix arriving over WS after the map is ready.
    if (!owned.size) mapReadyRef.current = false;
    const canFit = selectedId != null ? !!positions[selectedId] : devices.some(d => positions[d.id]);
    if (!mapReadyRef.current && canFit) {
      mapReadyRef.current = true;
      m.filterToDevice?.(selectedId, { fit: true });
    }
  }, [positionKey, positions, mapReady, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // (F4-b-2) WS live 갱신 — 새 fix 오면 map marker 즉시 이동.
  const wsRef = useRef(null);
  const devicesRef = useRef(devices);
  devicesRef.current = devices;
  const refreshRef = useRef(refetch);
  refreshRef.current = refetch;
  const [connection, setConnection] = useState('connecting');
  useEffect(() => {
    const ws = new TrackerWS((msg) => {
      if (msg?.type === 'resync') { refreshRef.current?.(); setEventRefresh(value => value + 1); return; }
      if (msg?.type !== 'location') return;
      // (F11) LTE-only / legacy fw 단일 fix POST 는 msg.fixes 없이 top-level lat/lng 만.
      // 이전엔 fixes 배열 없으면 조용히 drop → Fleet 뷰에서 그런 device 는 영원히 안 움직임.
      // + 배치 순서 뒤엉킴 방어 sort (F9 wsEventHandler 와 동일 규칙).
      let lat, lng, meta;
      if (Array.isArray(msg.fixes) && msg.fixes.length > 0) {
        const sorted = msg.fixes
          .filter(f => validFleetPosition(f) && Number.isFinite(Date.parse(f.recorded_at)))
          .slice()
          .sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
        const last = sorted[sorted.length - 1];
        if (!last) return;
        lat = last.lat; lng = last.lng;
        meta = {
          recordedAt: last.recorded_at, sat: last.sat, fix: true,
          heading: last.heading, speedKmh: serverSpeed(last), lat, lng,
        };
      } else if (msg.fix && msg.lat != null && msg.lng != null) {
        lat = msg.lat; lng = msg.lng;
        meta = {
          recordedAt: msg.recorded_at, sat: msg.sat, fix: msg.fix,
          heading: msg.heading, speedKmh: serverSpeed(msg), lat, lng,
        };
      } else {
        return;
      }
      const d = devicesRef.current.find(x => x.id === msg.device_id);
      if (!d) return;
      if (!validFleetPosition({ lat, lng }) || !Number.isFinite(Date.parse(meta.recordedAt))) return;
      setPositions(previous => {
        const point = latestFleetPosition(previous[msg.device_id], meta);
        return point === previous[msg.device_id] ? previous : { ...previous, [msg.device_id]: point };
      });
    }, setConnection);
    ws.connect(null);
    wsRef.current = ws;
    return () => ws.disconnect();
  }, []);
  const subscriptionKey = devices.map(d => d.id).join(',');
  // Subscribe only when ownership membership changes, not on each fix.
  useEffect(() => {
    wsRef.current?.subscribe(devices.map(d => d.id));
  }, [subscriptionKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  const handleTripSelect = useCallback(async (trip, retry = false) => {
    const m = mapRef.current;
    setMobilePanel('map');
    if (!m || !selectedDevice || !mapReady) {
      setTripLoad({ status: 'unavailable', message: '지도를 준비한 뒤 운행을 다시 선택해 주세요.' });
      return;
    }
    const revision = ++tripRevision.current;
    const key = trip.started_at;
    // Clear the previous path before starting a different request.
    m.clearSeekerPathCanvas?.();
    m.clearSeekerPath?.();
    m.setSeekerMode?.(false);
    setSelectedTrip(null);
    setTripPoints(null);
    setTripLoad({ status: 'idle' });
    if (!retry && (selectedTripKey === key || (tripLoad.status === 'loading' && tripLoad.trip?.started_at === key))) {
      // 재클릭 = 취소. The revision above also invalidates an in-flight load.
      return;
    }
    setTripLoad({ status: 'loading', trip });
    try {
      const from = trip.started_at;
      const to   = trip.ended_at || new Date().toISOString();
      const groups = await api.listLocationsGrouped(selectedId, { since: from, until: to, fix_only: true, limit: 5000 });
      if (revision !== tripRevision.current) return;
      const points = api.flattenGroupedAsc(groups).filter(validFleetPosition);
      if (!points.length) {
        setTripLoad({ status: 'empty', trip, message: '이 운행에 표시할 위치 기록이 없습니다.' });
        return;
      }
      const color = devices.find(d => d.id === selectedId)?.device_color || '#5B7CFF';
      setSelectedTrip(trip);
      setTripPoints(points);
      setTripLoad({ status: 'idle' });
      m.setSeekerMode?.(true);
      if (useCanvasSeeker) {
        m.drawSeekerPathCanvas(points, { color, refit: true, showStops: true, showCursor: true });
      } else {
        m.drawSeekerPath(points, { color, refit: true, showStops: true, showCursor: true });
      }
    } catch {
      if (revision !== tripRevision.current) return;
      m.clearSeekerPathCanvas?.();
      m.clearSeekerPath?.();
      m.setSeekerMode?.(false);
      setSelectedTrip(null);
      setTripPoints(null);
      setTripLoad({ status: 'error', trip, message: '운행 경로를 불러오지 못했습니다.' });
    }
  }, [selectedId, selectedDevice, mapReady, selectedTripKey, devices, useCanvasSeeker, tripLoad]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100dvh', minWidth: 0, background: 'var(--bg)',
    }}>
      {/* 상단 헤더 + 요약 chips */}
      <div style={{
        padding: 'var(--space-3) var(--space-4)',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
        background: 'var(--surface)',
      }}>
        <button onClick={() => nav('/')} style={{
          background: 'transparent', border: 'none', color: 'var(--text-2)',
          cursor: 'pointer', padding: 'var(--space-1) var(--space-2)',
          display: 'inline-flex', alignItems: 'center', gap: 4,
          borderRadius: 'var(--radius-sm)', fontSize: 12, minHeight: 44,
        }}>
          <Icon name="chevron-left" size={14} /> 홈
        </button>
        <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>
          Fleet 대시보드
        </div>
        {!compact && <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-3)' }}>차량 현황 · 이동 기록</div>}
      </div>
      <SummaryChips devices={devices} filter={filter} onChange={setFilter} now={now} />

      {connection === 'disconnected' && <div role="status" className="fleet-notice">실시간 연결을 복구하고 있습니다. 차량 현황은 30초마다 새로 확인합니다.</div>}
      {selectionNotice && <div role="alert" className="fleet-notice">{selectionNotice}</div>}
      {isPending && <div role="status" className="fleet-notice">차량 목록을 불러오는 중…</div>}
      {isError && <div role="alert" className="fleet-notice">차량 목록을 불러오지 못했습니다. <button onClick={() => refetch()}>다시 시도</button></div>}
      {compact && <nav className="fleet-panel-nav" aria-label="Fleet 화면 선택">
        {[['list', '차량 목록'], ['map', '지도'], ['detail', '차량 상세']].map(([id, label]) =>
          <button type="button" key={id} aria-pressed={mobilePanel === id} onClick={() => setMobilePanel(id)}>{label}</button>)}
      </nav>}
      <div className="fleet-body">
        <section className="fleet-pane" aria-label="차량 목록" hidden={compact && mobilePanel !== 'list'}>
        <DeviceListPanel
          devices={filtered}
          selectedId={selectedId}
          onSelect={d => selectDevice(d.id)}
          query={query}
          onQuery={setQuery}
          now={now}
        />
        </section>
        <section className="fleet-pane fleet-map-pane" aria-label="차량 지도" hidden={compact && mobilePanel !== 'map'}>
          <div className="fleet-map-messages" aria-live="polite">
            {isSuccess && !selectedDevice && !devices.some(d => positions[d.id]) && <div className="fleet-map-message">{devices.length ? '아직 수신된 위치가 없습니다. 차량 상세에서 통신 상태를 확인해 주세요.' : '등록된 차량이 없습니다. 단말기를 연결하면 위치가 표시됩니다.'}</div>}
            {selectedDevice && !selectedTrip && !positions[selectedId] && <div className="fleet-map-message">{vehicleName(selectedDevice)}의 최근 위치가 아직 수신되지 않았습니다. 통신 상태와 위치 수신은 별도로 확인합니다.</div>}
            {tripLoad.status !== 'idle' && <div className="fleet-map-message" role={tripLoad.status === 'error' ? 'alert' : 'status'}>
              {tripLoad.status === 'loading' ? '선택한 운행 경로를 불러오는 중…' : tripLoad.message}
              {['error', 'empty'].includes(tripLoad.status) && <button type="button" className="fleet-retry" onClick={() => handleTripSelect(tripLoad.trip, true)}>다시 시도</button>}
            </div>}
          </div>
          <KakaoMap ref={mapRef} onReady={handleMapReady} onPointInfo={handlePointInfo} />
        </section>
        <section className="fleet-pane" aria-label="차량 상세" hidden={compact && mobilePanel !== 'detail'}>
        {compact && <div className="fleet-detail-actions"><button type="button" onClick={() => setMobilePanel('list')}>목록 보기</button>
          <button type="button" onClick={() => setMobilePanel('map')}>지도 보기</button></div>}
        <SelectedDevicePanel
          selectedDevice={selectedDevice}
          events={currentEvents.data}
          evLoading={currentEvents.loading}
          evError={currentEvents.error}
          onEventsRetry={() => setEventRefresh(value => value + 1)}
          onTripSelect={handleTripSelect}
          selectedTrip={selectedTrip}
          tripPoints={tripPoints}
          selectedTripKey={selectedTripKey}
          mapRef={mapRef}
        />
        </section>
      </div>
    </div>
  );
}
