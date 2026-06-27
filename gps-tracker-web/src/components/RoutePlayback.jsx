// 경로 재생 — 날짜 + 디바이스 선택 → 시간 슬라이더로 fix 점 스크럽.
// 클라이언트가 하루치 fix 데이터를 한 번에 받고, 슬라이더는 인덱스 이동만 (서버 round-trip 없음).
import { useEffect, useRef, useState, useMemo } from 'react';
import { api } from '../api';
import { getDeviceColor } from '../colors';
import Icon from './Icon';

export default function RoutePlayback({ devices }) {
  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? null);
  const [date, setDate]         = useState(todayStr());
  const [points, setPoints]     = useState([]);
  const [loading, setLoading]   = useState(false);
  const [idx, setIdx]           = useState(0);
  const [playing, setPlaying]   = useState(false);
  const [speed, setSpeed]       = useState(60);   // 60x: 1초 실시간 = 1분 재생
  const [stats, setStats]       = useState(null);
  const [aiText, setAiText]     = useState(null);
  const [aiBusy, setAiBusy]     = useState(false);
  const [aiError, setAiError]   = useState(null);
  const [aiUsage, setAiUsage]   = useState(null);   // { used_today, limit, unlimited }

  const containerRef = useRef(null);
  const mapRef       = useRef(null);
  const polyRef      = useRef(null);
  const cursorRef    = useRef(null);
  const playTimerRef = useRef(null);

  const device = devices.find(d => d.id === deviceId);
  const color  = device ? getDeviceColor(device) : '#5B7CFF';

  // 데이터 로드 (날짜 변경 / 디바이스 변경 시)
  useEffect(() => {
    if (!deviceId) return;
    setLoading(true);
    setPlaying(false);
    setIdx(0);
    const start = `${date}T00:00:00+09:00`;
    const end   = `${date}T23:59:59+09:00`;
    api.listLocationsGrouped(deviceId, {
      since: start, until: end, fix_only: true, limit: 1000,
    }).then(groups => {
      const rows = api.flattenGrouped(groups);
      // recorded_at 오름차순으로 정렬
      const sorted = rows
        .filter(p => p.lat != null && p.lng != null)
        .slice()
        .sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
      setPoints(sorted);
      // 통계도 같이
      api.getDailyStats(deviceId, { from: date, to: date, limit: 1 })
        .then(s => setStats(s[0] || null))
        .catch(() => setStats(null));
    }).catch(() => setPoints([])).finally(() => setLoading(false));
    // 같은 날짜/디바이스로 다시 불러올 때 이전 분석 비움.
    setAiText(null);
    setAiError(null);
  }, [deviceId, date]);

  // AI 사용량 한 번 조회
  useEffect(() => {
    api.aiUsageToday().then(setAiUsage).catch(() => {});
  }, []);

  async function handleAnalyze() {
    if (!deviceId) return;
    setAiBusy(true);
    setAiError(null);
    setAiText(null);
    try {
      const r = await api.analyzeRoute(deviceId, date);
      setAiText(r.analysis);
      setAiUsage({ used_today: r.used_today, limit: r.limit, unlimited: r.unlimited });
    } catch (e) {
      setAiError(e.message || 'AI 분석 실패');
    } finally {
      setAiBusy(false);
    }
  }

  // 지도 init
  useEffect(() => {
    const initMap = () => {
      window.kakao.maps.load(() => {
        if (!containerRef.current || mapRef.current) return;
        mapRef.current = new window.kakao.maps.Map(containerRef.current, {
          center: new window.kakao.maps.LatLng(37.5665, 126.978), level: 4,
        });
      });
    };
    if (window.kakao?.maps) initMap();
    else {
      const wait = setInterval(() => {
        if (window.kakao?.maps) { clearInterval(wait); initMap(); }
      }, 100);
      return () => clearInterval(wait);
    }
  }, []);

  // 경로 라인 그리기 (points 변경 시)
  useEffect(() => {
    if (!mapRef.current || !window.kakao?.maps) return;
    polyRef.current?.setMap(null);
    polyRef.current = null;
    cursorRef.current?.setMap(null);
    cursorRef.current = null;

    if (points.length === 0) return;

    const path = points.map(p => new window.kakao.maps.LatLng(p.lat, p.lng));
    polyRef.current = new window.kakao.maps.Polyline({
      map: mapRef.current, path,
      strokeWeight: 3, strokeColor: color, strokeOpacity: 0.7, strokeStyle: 'solid',
    });

    const bounds = new window.kakao.maps.LatLngBounds();
    path.forEach(p => bounds.extend(p));
    mapRef.current.setBounds(bounds);

    cursorRef.current = new window.kakao.maps.Marker({
      map: mapRef.current,
      position: path[0],
      image: cursorImage(color),
    });
    setIdx(0);
  }, [points, color]);

  // 슬라이더 idx 변경 시 커서 이동
  useEffect(() => {
    if (!cursorRef.current || !points[idx]) return;
    const p = points[idx];
    const pos = new window.kakao.maps.LatLng(p.lat, p.lng);
    cursorRef.current.setPosition(pos);
  }, [idx, points]);

  // 재생 타이머 — speed 배 가속.
  useEffect(() => {
    if (!playing || points.length < 2) return;
    const tick = () => {
      setIdx(i => {
        if (i >= points.length - 1) { setPlaying(false); return i; }
        const cur = new Date(points[i].recorded_at).getTime();
        const nxt = new Date(points[i + 1].recorded_at).getTime();
        const realMs = nxt - cur;
        const playMs = realMs / speed;
        playTimerRef.current = setTimeout(tick, Math.max(50, Math.min(2000, playMs)));
        return i + 1;
      });
    };
    playTimerRef.current = setTimeout(tick, 100);
    return () => clearTimeout(playTimerRef.current);
  }, [playing, points, speed]);

  // 슬라이더 + 통계 표시용 데이터
  const cur = points[idx];
  const totalKm = useMemo(() => {
    if (points.length < 2) return 0;
    let m = 0;
    const R = 6371000, r = Math.PI / 180;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
      const v = Math.sin(dLa/2)**2 + Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dLo/2)**2;
      m += 2 * R * Math.asin(Math.sqrt(v));
    }
    return m / 1000;
  }, [points]);

  return (
    <div style={s.wrap}>
      {/* 컨트롤 */}
      <div style={s.controls}>
        <select value={deviceId ?? ''} onChange={e => setDeviceId(Number(e.target.value))} style={s.input}>
          {devices.map(d => (
            <option key={d.id} value={d.id}>{d.display_name || d.device_uid}</option>
          ))}
        </select>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={s.input} />
        <button onClick={() => setDate(shiftDate(date, -1))} style={s.iconBtn} title="전날">
          <Icon name="prev" size={14} />
        </button>
        <button onClick={() => setDate(shiftDate(date, +1))} style={s.iconBtn} title="다음날">
          <Icon name="next" size={14} />
        </button>
      </div>

      {/* 통계 요약 */}
      <div style={s.statsRow}>
        <Stat label="포인트" v={`${points.length}`} />
        <Stat label="이동거리" v={`${totalKm.toFixed(2)} km`} />
        {stats && <Stat label="정지" v={`${stats.stop_count}회`} />}
        {stats && <Stat label="최고속" v={`${stats.max_speed_kmh.toFixed(0)} km/h`} />}
      </div>

      {/* 지도 */}
      <div ref={containerRef} style={s.map}>
        {loading && <div style={s.overlayMsg}>로딩...</div>}
        {!loading && points.length === 0 && <div style={s.overlayMsg}>이 날짜의 fix 데이터가 없습니다</div>}
      </div>

      {/* 슬라이더 + 재생 + AI 분석 */}
      {points.length > 0 && (
        <div style={s.player}>
          <div style={s.playerTop}>
            <button onClick={() => setPlaying(p => !p)} style={s.playBtn} title={playing ? '일시정지' : '재생'}>
              <Icon name={playing ? 'pause' : 'play'} size={14} fill={playing ? 'currentColor' : 'currentColor'} />
            </button>
            <input type="range"
              min={0} max={points.length - 1} value={idx}
              onChange={e => { setPlaying(false); setIdx(Number(e.target.value)); }}
              style={{ flex: 1, accentColor: 'var(--primary)' }} />
            <select value={speed} onChange={e => setSpeed(Number(e.target.value))} style={s.smallInput}>
              <option value={30}>30x</option>
              <option value={60}>60x</option>
              <option value={120}>120x</option>
              <option value={300}>300x</option>
              <option value={600}>600x</option>
            </select>
          </div>
          {cur && (
            <div style={s.cursorInfo}>
              <span>{new Date(cur.recorded_at).toLocaleTimeString('ko-KR')}</span>
              <span style={{ color: 'var(--text-3)' }}>{idx + 1} / {points.length}</span>
            </div>
          )}

          {/* AI 분석 영역 */}
          <div style={s.aiBlock}>
            <div style={s.aiHeader}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
                <Icon name="spark" size={14} style={{ color: 'var(--primary)' }} />
                AI 분석
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-3)' }}>
                {aiUsage
                  ? aiUsage.unlimited
                    ? '무제한'
                    : `오늘 ${aiUsage.used_today} / ${aiUsage.limit}`
                  : ''}
              </span>
            </div>
            {!aiText && !aiError && (
              <button onClick={handleAnalyze} disabled={aiBusy}
                style={{ ...s.aiBtn, opacity: aiBusy ? 0.6 : 1 }}>
                {aiBusy ? '분석 중...' : '이 날짜의 운행을 분석'}
              </button>
            )}
            {aiError && (
              <div style={{ fontSize: 12, color: 'var(--danger)', padding: '6px 8px' }}>
                {aiError}
                <button onClick={handleAnalyze} style={{ ...s.aiBtn, marginTop: 6 }}>다시 시도</button>
              </div>
            )}
            {aiText && (
              <>
                <div style={s.aiText}>{aiText}</div>
                <button onClick={handleAnalyze} disabled={aiBusy}
                  style={{ ...s.aiBtn, background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', marginTop: 4 }}>
                  다시 분석
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, v }) {
  return (
    <div style={{ flex: 1, textAlign: 'center' }}>
      <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{v}</div>
    </div>
  );
}

function todayStr() {
  const d = new Date();
  const tz = -d.getTimezoneOffset();
  const local = new Date(d.getTime() + tz * 60000);
  return local.toISOString().slice(0, 10);
}
function shiftDate(s, d) {
  const dt = new Date(s + 'T12:00:00');
  dt.setDate(dt.getDate() + d);
  return dt.toISOString().slice(0, 10);
}
function cursorImage(color) {
  const sz = 18;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sz}" height="${sz}" viewBox="0 0 ${sz} ${sz}">
    <circle cx="${sz/2}" cy="${sz/2}" r="${sz/2 - 2}" fill="${color}" stroke="white" stroke-width="3"/>
  </svg>`;
  return new window.kakao.maps.MarkerImage(
    'data:image/svg+xml;base64,' + btoa(svg),
    new window.kakao.maps.Size(sz, sz),
    { offset: new window.kakao.maps.Point(sz/2, sz/2) },
  );
}

const s = {
  wrap: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' },
  controls: {
    display: 'flex', gap: 6, padding: 8, background: 'var(--surface)',
    borderBottom: '1px solid var(--border)', flexShrink: 0,
  },
  input: {
    flex: 1, padding: 6, fontSize: 12, background: 'var(--surface-2)',
    border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)',
  },
  smallInput: {
    padding: 4, fontSize: 11, background: 'var(--surface-2)',
    border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)',
  },
  iconBtn: {
    padding: '6px 10px', fontSize: 12, background: 'var(--surface-2)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
  },
  statsRow: {
    display: 'flex', padding: '8px 4px', background: 'var(--surface)',
    borderBottom: '1px solid var(--border)', flexShrink: 0,
  },
  map: { flex: 1, position: 'relative', background: '#0a0a12' },
  overlayMsg: {
    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'var(--text-3)', fontSize: 13,
  },
  player: {
    background: 'var(--surface)', borderTop: '1px solid var(--border)',
    padding: 8, flexShrink: 0,
  },
  playerTop: { display: 'flex', alignItems: 'center', gap: 8 },
  playBtn: {
    width: 36, height: 36, borderRadius: 18, border: 'none',
    background: 'var(--primary)', color: 'var(--primary-fg)',
    fontSize: 14, cursor: 'pointer',
  },
  cursorInfo: {
    display: 'flex', justifyContent: 'space-between',
    fontSize: 11, color: 'var(--text-2)', marginTop: 4,
  },
  aiBlock: {
    marginTop: 10, paddingTop: 10,
    borderTop: '1px solid var(--border)',
  },
  aiHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    fontSize: 11, color: 'var(--text-2)',
    textTransform: 'uppercase', letterSpacing: '0.04em',
    marginBottom: 6,
  },
  aiBtn: {
    width: '100%', padding: 9,
    background: 'var(--primary)', color: 'var(--primary-fg)',
    border: 'none', borderRadius: 6, cursor: 'pointer',
    fontSize: 12, fontWeight: 600,
  },
  aiText: {
    fontSize: 12, lineHeight: 1.65,
    color: 'var(--text)',
    background: 'var(--surface-2)',
    padding: 10, borderRadius: 6,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    maxHeight: 240, overflowY: 'auto',
  },
};
