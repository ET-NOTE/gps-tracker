// 실시간 내비게이션 — OSRM 경로 계산 + 브라우저 Geolocation + turn-by-turn 안내.
// 카카오 Places 로 목적지 검색 → OSRM driving route → watchPosition 으로 실시간 추적.
import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { haversineM } from '../lib/stops';
import useBreakpoint from '../useBreakpoint';

// ── OSRM 공개 라우팅 API ─────────────────────────────────────────────
const OSRM = 'https://router.project-osrm.org/route/v1/driving';
async function fetchRoute(fromLng, fromLat, toLng, toLat) {
  const url = `${OSRM}/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson&steps=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('경로 조회 실패');
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error('경로를 찾을 수 없습니다');
  return data.routes[0];
}

// ── 카카오 Places 검색 ───────────────────────────────────────────────
function searchPlaces(keyword) {
  return new Promise((resolve) => {
    const svc = window.kakao?.maps?.services;
    if (!svc) { resolve([]); return; }
    new svc.Places().keywordSearch(keyword, (result, status) => {
      if (status !== svc.Status.OK || !result?.length) { resolve([]); return; }
      resolve(result.slice(0, 5).map(r => ({
        label: r.place_name,
        addr:  r.road_address_name || r.address_name,
        lat:   parseFloat(r.y),
        lng:   parseFloat(r.x),
      })));
    });
  });
}

// ── 현재 위치 (Promise) ──────────────────────────────────────────────
function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('위치 서비스 미지원')); return; }
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, heading: p.coords.heading }),
      e => reject(new Error('위치 권한이 필요합니다')),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });
}

// ── 방향 아이콘 ──────────────────────────────────────────────────────
function ManeuverIcon({ type, modifier, size = 56 }) {
  // modifier: left, right, slight left, slight right, straight, sharp left, sharp right, uturn
  const isLeft   = modifier?.includes('left');
  const isRight  = modifier?.includes('right');
  const isU      = modifier === 'uturn';
  const isSlight = modifier?.startsWith('slight');
  const isSharp  = modifier?.startsWith('sharp');

  let rotation = 0;
  if (isLeft)  rotation = isSlight ? -30 : isSharp ? -120 : -90;
  if (isRight) rotation = isSlight ?  30 : isSharp ?  120 :  90;
  if (isU)     rotation = 180;

  const color = '#fff';
  return (
    <svg width={size} height={size} viewBox="0 0 56 56" fill="none">
      {type === 'arrive' ? (
        <path d="M28 8 L28 40 M16 28 L28 40 L40 28" stroke={color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
      ) : type === 'depart' ? (
        <path d="M28 48 L28 16 M16 28 L28 16 L40 28" stroke={color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
      ) : isU ? (
        <path d="M20 40 L20 22 Q20 10 32 10 Q44 10 44 22 L44 40 M32 30 L44 40 L32 50" stroke={color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
      ) : (
        <g transform={`rotate(${rotation} 28 28)`}>
          <path d="M28 48 L28 14" stroke={color} strokeWidth="4" strokeLinecap="round"/>
          <path d="M16 26 L28 14 L40 26" stroke={color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
        </g>
      )}
    </svg>
  );
}

// ── 거리 포맷 ────────────────────────────────────────────────────────
function fmtDist(m) {
  if (m < 1000) return `${Math.round(m)}m`;
  return `${(m / 1000).toFixed(1)}km`;
}
function fmtTime(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  return `${h}시간 ${m % 60}분`;
}

// 현재 위치에서 가장 가까운 step 인덱스
function findCurrentStep(steps, lat, lng) {
  let best = 0, bestDist = Infinity;
  steps.forEach((step, i) => {
    const [sLng, sLat] = step.maneuver.location;
    const d = haversineM(lat, lng, sLat, sLng);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

// 두 좌표 사이 방향각(degree)
function bearingDeg(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const dLng = (lng2 - lng1) * r;
  const y = Math.sin(dLng) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

export default function NavigationSheet({ mapRef, onClose }) {
  const bp        = useBreakpoint();
  const isDesktop = bp === 'desktop';

  const [phase, setPhase]           = useState('setup');   // 'setup' | 'loading' | 'navigating'
  const [query, setQuery]           = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [destination, setDestination] = useState(null);
  const [route, setRoute]           = useState(null);       // OSRM route object
  const [steps, setSteps]           = useState([]);
  const [stepIdx, setStepIdx]       = useState(0);
  const [distToStep, setDistToStep] = useState(null);
  const [remainDist, setRemainDist] = useState(null);
  const [remainTime, setRemainTime] = useState(null);
  const [speedKmh, setSpeedKmh]     = useState(null);
  const [error, setError]           = useState(null);
  const [arrived, setArrived]       = useState(false);

  const watchRef    = useRef(null);
  const debounceRef = useRef(null);
  const prevPosRef  = useRef(null);

  // 검색 debounce
  const handleQuery = useCallback((e) => {
    const v = e.target.value;
    setQuery(v);
    setSuggestions([]);
    clearTimeout(debounceRef.current);
    if (!v.trim()) return;
    debounceRef.current = setTimeout(async () => {
      const res = await searchPlaces(v.trim());
      setSuggestions(res);
    }, 400);
  }, []);

  const selectDest = useCallback((place) => {
    setDestination(place);
    setQuery(place.label);
    setSuggestions([]);
  }, []);

  // 내비게이션 시작
  const startNav = useCallback(async () => {
    if (!destination) return;
    setError(null);
    setPhase('loading');
    try {
      const pos = await getCurrentPosition();
      const r = await fetchRoute(pos.lng, pos.lat, destination.lng, destination.lat);

      // OSRM steps 수집
      const allSteps = r.legs.flatMap(leg => leg.steps);
      const allCoords = r.geometry.coordinates; // [[lng, lat], ...]

      setRoute(r);
      setSteps(allSteps);
      setRemainDist(r.distance);
      setRemainTime(r.duration);
      setStepIdx(0);
      setArrived(false);
      setPhase('navigating');

      // 지도에 경로 + 목적지 마커
      mapRef.current?.drawNavRoute?.(allCoords);
      mapRef.current?.setNavDestination?.(destination.lat, destination.lng);
      mapRef.current?.setNavPosition?.(pos.lat, pos.lng, pos.heading ?? 0);

      // 실시간 위치 추적
      watchRef.current = navigator.geolocation.watchPosition(
        (gp) => {
          const { latitude: lat, longitude: lng, heading, speed } = gp.coords;
          const hdg = heading ?? (prevPosRef.current
            ? bearingDeg(prevPosRef.current.lat, prevPosRef.current.lng, lat, lng)
            : 0);
          prevPosRef.current = { lat, lng };

          // 속도
          setSpeedKmh(speed != null ? Math.round(speed * 3.6) : null);

          // 현재 step 찾기
          const idx = findCurrentStep(allSteps, lat, lng);
          setStepIdx(idx);

          // 다음 step까지 거리
          if (idx < allSteps.length) {
            const [sLng, sLat] = allSteps[idx].maneuver.location;
            const d = haversineM(lat, lng, sLat, sLng);
            setDistToStep(d);
          }

          // 목적지까지 남은 거리 추정
          const destDist = haversineM(lat, lng, destination.lat, destination.lng);
          setRemainDist(destDist);

          // 도착 판정 (50m 이내)
          if (destDist < 50) {
            setArrived(true);
            navigator.geolocation.clearWatch(watchRef.current);
          }

          // 지도 업데이트
          mapRef.current?.setNavPosition?.(lat, lng, hdg);
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 1000 },
      );
    } catch (e) {
      setError(e.message);
      setPhase('setup');
    }
  }, [destination, mapRef]);

  // 내비게이션 종료
  const stopNav = useCallback(() => {
    if (watchRef.current != null) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }
    mapRef.current?.clearNavigation?.();
    setPhase('setup');
    setRoute(null);
    setSteps([]);
    setArrived(false);
  }, [mapRef]);

  // 언마운트 시 정리
  useEffect(() => () => {
    if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current);
    mapRef.current?.clearNavigation?.();
  }, [mapRef]);

  const currentStep = steps[stepIdx] ?? null;
  const nextStep    = steps[stepIdx + 1] ?? null;

  // ── 도착 화면 ──────────────────────────────────────────────────────
  if (arrived) {
    return (
      <div style={overlayStyle(isDesktop, true)}>
        <div style={{ textAlign: 'center', padding: '32px 24px' }}>
          <div style={{ fontSize: 64, marginBottom: 12 }}>🎉</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#10B981', marginBottom: 8 }}>목적지 도착!</div>
          <div style={{ fontSize: 14, color: 'var(--text-2)', marginBottom: 24 }}>{destination?.label}</div>
          <button onClick={() => { stopNav(); onClose(); }} style={btnStyle('#10B981')}>
            내비게이션 종료
          </button>
        </div>
      </div>
    );
  }

  // ── 내비게이션 중 ─────────────────────────────────────────────────
  if (phase === 'navigating' && currentStep) {
    const maneuver = currentStep.maneuver;
    return (
      <div style={overlayStyle(isDesktop, false)}>
        {/* 상단 방향 안내 */}
        <div style={{
          background: '#4f46e5', borderRadius: isDesktop ? '16px 16px 0 0' : 0,
          padding: '20px 20px 16px',
          display: 'flex', alignItems: 'center', gap: 16,
        }}>
          <div style={{
            width: 80, height: 80, borderRadius: 16,
            background: 'rgba(255,255,255,0.12)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <ManeuverIcon type={maneuver.type} modifier={maneuver.modifier} size={52} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 36, fontWeight: 900, color: '#fff', lineHeight: 1 }}>
              {distToStep != null ? fmtDist(distToStep) : '—'}
            </div>
            <div style={{ fontSize: 15, color: 'rgba(255,255,255,0.85)', marginTop: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {currentStep.name || maneuverLabel(maneuver.type, maneuver.modifier)}
            </div>
          </div>
        </div>

        {/* 다음 방향 (있는 경우) */}
        {nextStep && (
          <div style={{
            background: '#3730a3', padding: '10px 20px',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <ManeuverIcon type={nextStep.maneuver.type} modifier={nextStep.maneuver.modifier} size={24} />
            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>
              그 다음: {nextStep.name || maneuverLabel(nextStep.maneuver.type, nextStep.maneuver.modifier)}
            </span>
          </div>
        )}

        {/* 하단 정보 바 */}
        <div style={{
          background: 'var(--surface)', borderTop: '1px solid var(--border)',
          padding: '14px 20px',
          display: 'flex', alignItems: 'center', gap: 0,
        }}>
          <InfoChip label="남은 거리" value={remainDist != null ? fmtDist(remainDist) : '—'} />
          <Divider />
          <InfoChip label="예상 시간" value={remainTime != null ? fmtTime(remainDist / (route?.distance || 1) * (route?.duration || 0)) : '—'} />
          {speedKmh != null && <>
            <Divider />
            <InfoChip label="속도" value={`${speedKmh} km/h`} accent={speedKmh > 80} />
          </>}
          <div style={{ flex: 1 }} />
          <button onClick={stopNav} style={{
            background: '#EF4444', color: '#fff', border: 'none',
            borderRadius: 10, padding: '8px 14px', fontWeight: 700, fontSize: 13, cursor: 'pointer',
          }}>
            종료
          </button>
        </div>
      </div>
    );
  }

  // ── 설정 화면 ─────────────────────────────────────────────────────
  return (
    <div style={setupPanelStyle(isDesktop)}>
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: '#4f46e520', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="navigation" size={18} style={{ color: '#4f46e5' }} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>내비게이션</div>
          <div style={{ fontSize: 11, color: 'var(--text-2)' }}>목적지를 검색하세요</div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-2)', padding: 4 }}>
          <Icon name="x" size={20} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* 검색창 */}
        <div style={{ position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
            <Icon name="search" size={15} style={{ color: 'var(--text-2)', flexShrink: 0 }} />
            <input
              value={query}
              onChange={handleQuery}
              placeholder="목적지 검색 (건물명, 주소…)"
              autoFocus
              style={{ flex: 1, border: 'none', background: 'none', outline: 'none', fontSize: 14, color: 'var(--text)' }}
            />
            {query && (
              <button onClick={() => { setQuery(''); setSuggestions([]); setDestination(null); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-2)', padding: 0 }}>
                <Icon name="x" size={14} />
              </button>
            )}
          </div>
          {/* 드롭다운 */}
          {suggestions.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 10, marginTop: 4, boxShadow: '0 4px 16px rgba(0,0,0,.15)', overflow: 'hidden',
            }}>
              {suggestions.map((s, i) => (
                <button key={i} onClick={() => selectDest(s)} style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '10px 14px', border: 'none', background: 'none', cursor: 'pointer',
                  borderBottom: i < suggestions.length - 1 ? '1px solid var(--border)' : 'none',
                }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{s.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>{s.addr}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 선택된 목적지 */}
        {destination && (
          <div style={{
            background: '#4f46e510', border: '1px solid #4f46e530',
            borderRadius: 10, padding: '12px 14px',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: '#EF4444', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Icon name="map-pin" size={16} style={{ color: '#fff' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{destination.label}</div>
              {destination.addr && <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{destination.addr}</div>}
            </div>
          </div>
        )}

        {error && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: '#DC2626' }}>
            {error}
          </div>
        )}

        {destination && phase !== 'loading' && (
          <button onClick={startNav} style={btnStyle('#4f46e5')}>
            <Icon name="navigation" size={16} />
            안내 시작
          </button>
        )}

        {phase === 'loading' && (
          <div style={{ textAlign: 'center', padding: '16px 0', color: 'var(--text-2)', fontSize: 14 }}>
            경로 계산 중…
          </div>
        )}

        {/* 안내 */}
        <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6, marginTop: 4 }}>
          • 정확한 경로 안내를 위해 위치 권한을 허용하세요<br />
          • OSRM 기반 오픈소스 라우팅 (도로 데이터: OpenStreetMap)
        </div>
      </div>
    </div>
  );
}

// ── 내부 UI 컴포넌트 ──────────────────────────────────────────────────
function InfoChip({ label, value, accent }) {
  return (
    <div style={{ textAlign: 'center', padding: '0 14px' }}>
      <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: accent ? '#EF4444' : 'var(--text)' }}>{value}</div>
    </div>
  );
}
function Divider() {
  return <div style={{ width: 1, height: 28, background: 'var(--border)', flexShrink: 0 }} />;
}

// ── 스타일 헬퍼 ───────────────────────────────────────────────────────
function overlayStyle(isDesktop, arrived) {
  return isDesktop ? {
    position: 'absolute', bottom: 16, left: 16,
    width: 360,
    borderRadius: 16,
    boxShadow: '0 8px 32px rgba(0,0,0,.25)',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    overflow: 'hidden',
    zIndex: 20,
  } : {
    position: 'fixed', bottom: 0, left: 0, right: 0,
    borderRadius: arrived ? 20 : '0',
    boxShadow: '0 -4px 24px rgba(0,0,0,.2)',
    background: 'var(--surface)',
    overflow: 'hidden',
    zIndex: 200,
  };
}
function setupPanelStyle(isDesktop) {
  return isDesktop ? {
    position: 'absolute', top: 80, left: 16,
    width: 340, maxHeight: 'calc(100vh - 120px)',
    borderRadius: 16, boxShadow: '0 8px 32px rgba(0,0,0,.22)',
    background: 'var(--surface)', border: '1px solid var(--border)',
    display: 'flex', flexDirection: 'column', zIndex: 20, overflow: 'hidden',
  } : {
    position: 'fixed', bottom: 0, left: 0, right: 0,
    maxHeight: '75vh', borderRadius: '20px 20px 0 0',
    boxShadow: '0 -4px 24px rgba(0,0,0,.18)',
    background: 'var(--surface)', border: '1px solid var(--border)',
    display: 'flex', flexDirection: 'column', zIndex: 200, overflow: 'hidden',
  };
}
function btnStyle(bg) {
  return {
    width: '100%', padding: '12px 0', borderRadius: 12,
    background: bg, color: '#fff', border: 'none',
    fontWeight: 700, fontSize: 15, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
  };
}

function maneuverLabel(type, modifier) {
  if (type === 'depart')  return '출발';
  if (type === 'arrive')  return '목적지 도착';
  if (modifier === 'left')        return '좌회전';
  if (modifier === 'right')       return '우회전';
  if (modifier === 'slight left') return '약간 좌회전';
  if (modifier === 'slight right') return '약간 우회전';
  if (modifier === 'sharp left')  return '급좌회전';
  if (modifier === 'sharp right') return '급우회전';
  if (modifier === 'uturn')       return 'U턴';
  if (modifier === 'straight')    return '직진';
  return '직진';
}
