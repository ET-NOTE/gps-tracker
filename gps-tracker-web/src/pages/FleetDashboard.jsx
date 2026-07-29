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
import { TrackerWS } from '../ws';
import KakaoMap from '../components/KakaoMap';
import SummaryChips, { classifyDevice } from '../components/fleet/SummaryChips';
import DeviceListPanel from '../components/fleet/DeviceListPanel';
import SelectedDevicePanel from '../components/fleet/SelectedDevicePanel';
import Icon from '../components/Icon';

export default function FleetDashboard() {
  const nav = useNavigate();
  const loc = useLocation();
  // URL query: ?filter=all|active|idle|offline&device=<id>&q=<search>
  const qs = new URLSearchParams(loc.search);
  const [filter,     setFilter]     = useState(qs.get('filter') || 'all');
  const [selectedId, setSelectedId] = useState(qs.get('device') ? Number(qs.get('device')) : null);
  const [query,      setQuery]      = useState(qs.get('q') || '');

  // URL sync — 새로고침·공유 시 상태 복원.
  useEffect(() => {
    const q = new URLSearchParams();
    if (filter !== 'all') q.set('filter', filter);
    if (selectedId != null) q.set('device', String(selectedId));
    if (query) q.set('q', query);
    const s = q.toString();
    const next = s ? `?${s}` : '';
    if (next !== loc.search) nav({ pathname: loc.pathname, search: next }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, selectedId, query]);

  const { data: devices = [] } = useDevices();

  // 필터 적용된 device 목록.
  const filtered = useMemo(() => {
    if (filter === 'all') return devices;
    return devices.filter(d => classifyDevice(d) === filter);
  }, [devices, filter]);

  const selectedDevice = useMemo(
    () => devices.find(d => d.id === selectedId) || null,
    [devices, selectedId]
  );

  // 선택된 device 의 최근 이벤트 fetch — 60s poll.
  const [events, setEvents]   = useState(null);
  const [evLoading, setEvLoading] = useState(false);
  useEffect(() => {
    if (!selectedId) { setEvents(null); return; }
    let cancelled = false;
    setEvLoading(true);
    const load = () => api.getDeviceEvents(selectedId, { limit: 20 })
      .then(evs => { if (!cancelled) { setEvents(evs || []); setEvLoading(false); } })
      .catch(() => { if (!cancelled) { setEvents([]); setEvLoading(false); } });
    load();
    const iv = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [selectedId]);

  // KakaoMap 인스턴스 & marker 배치.
  const mapRef = useRef(null);
  const mapReadyRef = useRef(false);

  // (F4-b-2) map marker click → selectedId sync.
  // KakaoMap onPointInfo prop 은 marker/dot click 시 { kind, deviceId, ... } 콜백.
  const handlePointInfo = useCallback((p) => {
    if (p?.kind === 'main' && p?.meta?.deviceId != null) {
      setSelectedId(p.meta.deviceId);
    }
  }, []);

  // last position marker 배치. devices id·last_fix_at 이 실제 변할 때만 재-loop (deps stable).
  const positionKey = devices.map(d => `${d.id}:${d.last_fix_at || ''}`).join(',');
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !m.updateMarker) return;
    for (const d of devices) {
      if (d.last_lat == null || d.last_lng == null) continue;
      const label = d.license_plate || d.display_name || d.device_uid;
      const meta = {
        recordedAt: d.last_fix_at || d.last_seen_at,
        lat: d.last_lat, lng: d.last_lng,
        deviceId: d.id, deviceLabel: label,   // (F4-b-2) onPointInfo 콜백에서 참조
      };
      m.updateMarker(d.id, d.last_lat, d.last_lng, label, d.device_color || '#5B7CFF', meta);
    }
    if (!mapReadyRef.current) {
      mapReadyRef.current = true;
      m.filterToDevice?.(null, { fit: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionKey]);

  // (F4-b-2) WS live 갱신 — 새 fix 오면 map marker 즉시 이동.
  const wsRef = useRef(null);
  const devicesRef = useRef(devices);
  useEffect(() => { devicesRef.current = devices; }, [devices]);
  useEffect(() => {
    const ws = new TrackerWS((msg) => {
      if (msg?.type !== 'location') return;
      const m = mapRef.current;
      if (!m || !m.updateMarker) return;
      // (F11) LTE-only / legacy fw 단일 fix POST 는 msg.fixes 없이 top-level lat/lng 만.
      // 이전엔 fixes 배열 없으면 조용히 drop → Fleet 뷰에서 그런 device 는 영원히 안 움직임.
      // + 배치 순서 뒤엉킴 방어 sort (F9 wsEventHandler 와 동일 규칙).
      let lat, lng, meta;
      if (Array.isArray(msg.fixes) && msg.fixes.length > 0) {
        const sorted = msg.fixes
          .filter(f => f && f.lat != null && f.lng != null && f.recorded_at)
          .slice()
          .sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
        const last = sorted[sorted.length - 1];
        if (!last) return;
        lat = last.lat; lng = last.lng;
        meta = {
          recordedAt: last.recorded_at, sat: last.sat, fix: true,
          heading: last.heading, speedKmh: msg.speed_kmh, lat, lng,
        };
      } else if (msg.fix && msg.lat != null && msg.lng != null) {
        lat = msg.lat; lng = msg.lng;
        meta = {
          recordedAt: msg.recorded_at, sat: msg.sat, fix: msg.fix,
          heading: msg.heading, speedKmh: msg.speed_kmh, lat, lng,
        };
      } else {
        return;
      }
      const d = devicesRef.current.find(x => x.id === msg.device_id);
      const label = d?.license_plate || d?.display_name || d?.device_uid || String(msg.device_id);
      const color = d?.device_color || '#5B7CFF';
      meta.deviceId = msg.device_id;
      meta.deviceLabel = label;
      m.updateMarker(msg.device_id, lat, lng, label, color, meta);
    }, () => {/* onStatus */});
    ws.connect(null);
    wsRef.current = ws;
    return () => ws.disconnect();
  }, []);
  // subscribe 는 devices 배열 변경 시.
  useEffect(() => {
    wsRef.current?.subscribe(devices.map(d => d.id));
  }, [positionKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  // 선택 시 map focus.
  useEffect(() => {
    if (!mapRef.current) return;
    if (selectedId != null) mapRef.current.filterToDevice?.(selectedId, { fit: true });
    else                    mapRef.current.filterToDevice?.(null,       { fit: false });
    // trip 선택 초기화
    setSelectedTrip(null);
    mapRef.current.clearSeekerPath?.();
    mapRef.current.setSeekerMode?.(false);
  }, [selectedId]);

  // (F4-b-2) 선택된 trip → seeker path.
  // (F7-a) ?canvas=1 URL flag 로 canvas overlay 시험 사용. 안정성 검증 후 default 전환.
  const useCanvasSeeker = new URLSearchParams(window.location.search).get('canvas') === '1';
  const [selectedTrip, setSelectedTrip] = useState(null);   // 전체 trip 객체 (TripDetailTab 이 참조)
  const selectedTripKey = selectedTrip?.started_at ?? null;
  const handleTripSelect = useCallback(async (trip) => {
    const m = mapRef.current;
    if (!m || !selectedId) return;
    const key = trip.started_at;
    if (selectedTripKey === key) {
      // 재클릭 = 취소.
      if (useCanvasSeeker) m.clearSeekerPathCanvas?.();
      else                 m.clearSeekerPath?.();
      m.setSeekerMode?.(false);
      setSelectedTrip(null);
      return;
    }
    setSelectedTrip(trip);
    try {
      const from = trip.started_at;
      const to   = trip.ended_at || new Date().toISOString();
      const groups = await api.listLocationsGrouped(selectedId, { since: from, until: to, fix_only: true, limit: 5000 });
      const points = api.flattenGroupedAsc(groups);
      const color = devices.find(d => d.id === selectedId)?.device_color || '#5B7CFF';
      m.setSeekerMode?.(true);
      if (useCanvasSeeker) {
        m.drawSeekerPathCanvas(points, { color, refit: true, showStops: true, showCursor: true });
      } else {
        m.drawSeekerPath(points, { color, refit: true, showStops: true, showCursor: true });
      }
    } catch (e) {
      console.error('trip seeker load', e);
      setSelectedTrip(null);
    }
  }, [selectedId, selectedTripKey, devices, useCanvasSeeker]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100vh', background: 'var(--bg)',
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
          borderRadius: 'var(--radius-sm)', fontSize: 12,
        }}>
          <Icon name="chevron-left" size={14} /> 홈
        </button>
        <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>
          Fleet 대시보드
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-3)' }}>
          Beta — 홈 버튼으로 기존 Dashboard 이동
        </div>
      </div>
      <SummaryChips devices={devices} filter={filter} onChange={setFilter} />

      {/* 3-panel body */}
      <div style={{
        flex: 1, minHeight: 0,
        display: 'grid',
        gridTemplateColumns: 'minmax(280px, 340px) 1fr minmax(300px, 360px)',
      }}>
        <DeviceListPanel
          devices={filtered}
          selectedId={selectedId}
          onSelect={d => setSelectedId(d.id)}
          query={query}
          onQuery={setQuery}
        />
        <div style={{ position: 'relative', minWidth: 0, minHeight: 0 }}>
          <KakaoMap ref={mapRef} onPointInfo={handlePointInfo} />
        </div>
        <SelectedDevicePanel
          selectedDevice={selectedDevice}
          events={events}
          evLoading={evLoading}
          onTripSelect={handleTripSelect}
          selectedTrip={selectedTrip}
          selectedTripKey={selectedTripKey}
          mapRef={mapRef}
        />
      </div>
    </div>
  );
}
