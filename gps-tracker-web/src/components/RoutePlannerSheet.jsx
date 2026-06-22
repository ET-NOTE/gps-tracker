// 경로 계획 (Route Planner) — 여러 목적지 입력 → 최단 순서 최적화 → 지도 표시.
// 알고리즘: nearest-neighbor TSP (client-side, haversine 거리).
// 주소 검색: kakao.maps.services.Places (키워드 검색).
import { useCallback, useRef, useState } from 'react';
import Icon from './Icon';
import { haversineM } from '../lib/stops';
import useBreakpoint from '../useBreakpoint';
import { BOTTOM_NAV_HEIGHT } from './BottomNav';

// ── TSP: nearest-neighbor heuristic ─────────────────────────────────
function nearestNeighborTSP(points) {
  const n = points.length;
  if (n <= 2) return points.map((_, i) => i);
  const visited = new Array(n).fill(false);
  const order   = [0];
  visited[0]    = true;
  for (let step = 1; step < n; step++) {
    const last = order[order.length - 1];
    let nearest = -1, minDist = Infinity;
    for (let j = 0; j < n; j++) {
      if (!visited[j]) {
        const d = haversineM(points[last].lat, points[last].lng, points[j].lat, points[j].lng);
        if (d < minDist) { minDist = d; nearest = j; }
      }
    }
    order.push(nearest);
    visited[nearest] = true;
  }
  return order;
}

function totalRouteKm(waypoints) {
  if (waypoints.length < 2) return 0;
  let m = 0;
  for (let i = 1; i < waypoints.length; i++) {
    m += haversineM(waypoints[i - 1].lat, waypoints[i - 1].lng, waypoints[i].lat, waypoints[i].lng);
  }
  return m / 1000;
}

// ── 주소 검색 (Kakao Places) ─────────────────────────────────────────
function searchPlaces(keyword) {
  return new Promise((resolve) => {
    const kakao = window.kakao?.maps?.services;
    if (!kakao) { resolve([]); return; }
    const ps = new kakao.Places();
    ps.keywordSearch(keyword, (result, status) => {
      if (status !== kakao.Status.OK || !result?.length) { resolve([]); return; }
      resolve(result.slice(0, 5).map(r => ({
        label: r.place_name,
        addr:  r.road_address_name || r.address_name,
        lat:   parseFloat(r.y),
        lng:   parseFloat(r.x),
      })));
    });
  });
}

export default function RoutePlannerSheet({ mapRef, onClose }) {
  const bp        = useBreakpoint();
  const isDesktop = bp === 'desktop';

  const [waypoints,    setWaypoints]    = useState([]);  // { id, label, addr, lat, lng }
  const [query,        setQuery]        = useState('');
  const [suggestions,  setSuggestions]  = useState([]);
  const [searching,    setSearching]    = useState(false);
  const [optimized,    setOptimized]    = useState(false);
  const [totalKm,      setTotalKm]      = useState(null);
  const nextId = useRef(1);
  const debounceRef = useRef(null);

  const handleQueryChange = useCallback((e) => {
    const v = e.target.value;
    setQuery(v);
    setSuggestions([]);
    clearTimeout(debounceRef.current);
    if (!v.trim()) return;
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      const res = await searchPlaces(v.trim());
      setSuggestions(res);
      setSearching(false);
    }, 400);
  }, []);

  const addWaypoint = useCallback((place) => {
    setWaypoints(prev => [...prev, { id: nextId.current++, ...place }]);
    setQuery('');
    setSuggestions([]);
    setOptimized(false);
    setTotalKm(null);
    mapRef.current?.clearRoutePlan?.();
  }, [mapRef]);

  const removeWaypoint = useCallback((id) => {
    setWaypoints(prev => prev.filter(w => w.id !== id));
    setOptimized(false);
    setTotalKm(null);
    mapRef.current?.clearRoutePlan?.();
  }, [mapRef]);

  const optimize = useCallback(() => {
    if (waypoints.length < 2) return;
    const order = nearestNeighborTSP(waypoints);
    const sorted = order.map(i => waypoints[i]);
    const km = totalRouteKm(sorted);
    setWaypoints(sorted);
    setTotalKm(km);
    setOptimized(true);
    mapRef.current?.drawRoutePlan?.(sorted);
  }, [waypoints, mapRef]);

  const showOnMap = useCallback(() => {
    if (waypoints.length < 1) return;
    mapRef.current?.drawRoutePlan?.(waypoints);
    setTotalKm(totalRouteKm(waypoints));
  }, [waypoints, mapRef]);

  const reset = useCallback(() => {
    setWaypoints([]);
    setQuery('');
    setSuggestions([]);
    setOptimized(false);
    setTotalKm(null);
    mapRef.current?.clearRoutePlan?.();
  }, [mapRef]);

  const panelStyle = isDesktop ? {
    position: 'absolute', top: 80, left: 16,
    width: 340, maxHeight: 'calc(100vh - 120px)',
    borderRadius: 16, boxShadow: '0 8px 32px rgba(0,0,0,.22)',
    background: 'var(--surface)', border: '1px solid var(--border)',
    display: 'flex', flexDirection: 'column', zIndex: 20, overflow: 'hidden',
  } : {
    position: 'fixed', bottom: BOTTOM_NAV_HEIGHT, left: 0, right: 0,
    maxHeight: `calc(80vh - ${BOTTOM_NAV_HEIGHT}px)`,
    borderRadius: '20px 20px 0 0',
    boxShadow: '0 -4px 24px rgba(0,0,0,.18)',
    background: 'var(--surface)', border: '1px solid var(--border)',
    display: 'flex', flexDirection: 'column', zIndex: 200, overflow: 'hidden',
  };

  return (
    <div style={panelStyle}>
      {/* 헤더 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: '#4f46e520', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon name="map-pin" size={18} style={{ color: '#4f46e5' }} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>경로 계획</div>
          <div style={{ fontSize: 11, color: 'var(--text-2)' }}>목적지 추가 후 최적화</div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-2)', padding: 4 }}>
          <Icon name="x" size={20} />
        </button>
      </div>

      {/* 스크롤 영역 */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* 검색 입력 */}
        <div style={{ position: 'relative' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            borderRadius: 10, padding: '8px 12px',
          }}>
            <Icon name="search" size={15} style={{ color: 'var(--text-2)', flexShrink: 0 }} />
            <input
              value={query}
              onChange={handleQueryChange}
              placeholder="목적지 검색 (건물명, 주소…)"
              style={{
                flex: 1, border: 'none', background: 'none', outline: 'none',
                fontSize: 14, color: 'var(--text)',
              }}
            />
            {searching && (
              <span style={{ fontSize: 10, color: 'var(--text-2)' }}>검색 중…</span>
            )}
          </div>
          {/* 검색 결과 드롭다운 */}
          {suggestions.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 10, marginTop: 4, boxShadow: '0 4px 16px rgba(0,0,0,.15)',
              overflow: 'hidden',
            }}>
              {suggestions.map((s, i) => (
                <button key={i} onClick={() => addWaypoint(s)} style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '10px 14px', border: 'none', background: 'none',
                  cursor: 'pointer', borderBottom: i < suggestions.length - 1 ? '1px solid var(--border)' : 'none',
                }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{s.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>{s.addr}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 경유지 목록 */}
        {waypoints.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {waypoints.map((w, i) => (
              <div key={w.id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                background: 'var(--surface-2)', border: '1px solid var(--border)',
                borderRadius: 10, padding: '8px 12px',
              }}>
                <div style={{
                  width: 26, height: 26, borderRadius: 13, flexShrink: 0,
                  background: i === 0 ? '#10B981' : i === waypoints.length - 1 ? '#EF4444' : '#4f46e5',
                  color: '#fff', fontWeight: 700, fontSize: 12,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {i + 1}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.label}</div>
                  {w.addr && <div style={{ fontSize: 11, color: 'var(--text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.addr}</div>}
                </div>
                <button onClick={() => removeWaypoint(w.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-2)', padding: 2 }}>
                  <Icon name="x" size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-2)', fontSize: 13 }}>
            위 검색창에서 목적지를 추가하세요
          </div>
        )}

        {/* 총 거리 */}
        {totalKm != null && (
          <div style={{
            background: optimized ? '#4f46e510' : 'var(--surface-2)',
            border: `1px solid ${optimized ? '#4f46e540' : 'var(--border)'}`,
            borderRadius: 10, padding: '10px 14px',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <Icon name="route" size={15} style={{ color: optimized ? '#4f46e5' : 'var(--text-2)' }} />
            <span style={{ fontSize: 13, color: 'var(--text)' }}>
              총 거리: <strong>{totalKm.toFixed(1)} km</strong>
              {optimized && <span style={{ fontSize: 11, color: '#4f46e5', marginLeft: 6 }}>• 최적화됨</span>}
            </span>
          </div>
        )}

        {/* 액션 버튼 */}
        {waypoints.length >= 2 && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={optimize} style={{
              flex: 1, padding: '10px 0', borderRadius: 10,
              background: '#4f46e5', color: '#fff', border: 'none',
              fontWeight: 700, fontSize: 13, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}>
              <Icon name="zap" size={14} />
              최적화
            </button>
            <button onClick={showOnMap} style={{
              flex: 1, padding: '10px 0', borderRadius: 10,
              background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)',
              fontWeight: 600, fontSize: 13, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}>
              <Icon name="map" size={14} />
              지도 표시
            </button>
          </div>
        )}

        {waypoints.length > 0 && (
          <button onClick={reset} style={{
            padding: '8px 0', borderRadius: 10,
            background: 'none', color: 'var(--text-2)', border: '1px solid var(--border)',
            fontWeight: 600, fontSize: 12, cursor: 'pointer',
          }}>
            초기화
          </button>
        )}
      </div>
    </div>
  );
}
