// (2026-07-28) Phase F4-b — Unified Fleet Dashboard.
//
// 참고 이미지 (cartax-style) 대응: 상단 요약 chips + 좌측 device list (react-window virtualize)
// + 중앙 map (MarkerClusterer 활성) + 우측 event feed.
//
// 기존 Dashboard 는 그대로 유지, 이 페이지는 별도 `/fleet` 라우트. 사용자가 두 뷰 비교 후
// 정착되면 기존 Dashboard 를 대체 예정 (F4-c 이후).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useDevices } from '../state';
import { api } from '../api';
import KakaoMap from '../components/KakaoMap';
import SummaryChips, { classifyDevice } from '../components/fleet/SummaryChips';
import DeviceListPanel from '../components/fleet/DeviceListPanel';
import EventFeedPanel from '../components/fleet/EventFeedPanel';
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

  // 필터 적용된 device 목록 — SummaryChips 는 원본 count, List/Map 는 filtered.
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
  // Fleet overview 는 last_lat/last_lng 만 표시 (히스토리 polyline 은 상세 뷰에서).
  // devices 목록/last position 변할 때만 marker 재배치. WS live 갱신은 Dashboard 쪽에 위임 예정.
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !m.updateMarker) return;
    for (const d of devices) {
      if (d.last_lat == null || d.last_lng == null) continue;
      const label = d.license_plate || d.display_name || d.device_uid;
      const meta = {
        recordedAt: d.last_fix_at || d.last_seen_at,
        lat: d.last_lat, lng: d.last_lng,
      };
      m.updateMarker(d.id, d.last_lat, d.last_lng, label, d.device_color || '#5B7CFF', meta);
    }
    // 첫 배치 시 전체 fit.
    if (!mapReadyRef.current) {
      mapReadyRef.current = true;
      m.filterToDevice?.(null, { fit: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices.length, devices.map(d => `${d.id}:${d.last_fix_at || ''}`).join(',')]);

  // 선택 시 map focus (KakaoMap.filterToDevice).
  useEffect(() => {
    if (!mapRef.current) return;
    if (selectedId != null) mapRef.current.filterToDevice?.(selectedId, { fit: true });
    else                    mapRef.current.filterToDevice?.(null,       { fit: false });
  }, [selectedId]);

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
          Beta — F4-b 신규 뷰. 기존 Dashboard 는 홈 버튼으로 이동.
        </div>
      </div>
      <SummaryChips devices={devices} filter={filter} onChange={setFilter} />

      {/* 3-panel body */}
      <div style={{
        flex: 1, minHeight: 0,
        display: 'grid',
        gridTemplateColumns: 'minmax(280px, 340px) 1fr minmax(280px, 340px)',
      }}>
        <DeviceListPanel
          devices={filtered}
          selectedId={selectedId}
          onSelect={d => setSelectedId(d.id)}
          query={query}
          onQuery={setQuery}
        />
        <div style={{ position: 'relative', minWidth: 0, minHeight: 0 }}>
          <KakaoMap ref={mapRef} />
        </div>
        <EventFeedPanel
          events={events}
          selectedDevice={selectedDevice}
          loading={evLoading}
        />
      </div>
    </div>
  );
}
