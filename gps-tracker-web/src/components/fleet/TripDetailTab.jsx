// (2026-07-28) Phase F4-c — 선택된 trip 의 waypoint 상세 (참고 이미지 좌측 timeline 스타일).
//
// 상단 요약 (총거리 · 시간 · 평균속도) + waypoint 목록 (번호 · 시간 · 속도 · 경과).
// 속도 이상치 (SPEED_ANOMALY_KMH 이상) 는 자동 빨간색 하이라이트.
// waypoint 클릭 → 지도 cursor 이동 (mapRef.moveSeekerCursor).

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { haversineM } from '../../lib/stops';
import Icon from '../Icon';

// 참고 이미지의 555 km/h 같은 명백 이상치. GPS 튀는 값 잡음 필터.
const SPEED_ANOMALY_KMH = 200;
// waypoint 클릭 가능한 dot 을 얼마나 촘촘히 표시할지 — 100개 하드 캡.
const MAX_WAYPOINTS = 120;

const SPEEDS = [1, 2, 4, 8];   // 재생 속도 배율

export default function TripDetailTab({ deviceId, trip, mapRef }) {
  const [points, setPoints] = useState(null);   // ASC 정렬 fix 배열
  const [error, setError] = useState(null);
  const [activeIdx, setActiveIdx] = useState(null);
  const [playing, setPlaying]     = useState(false);
  const [speedX,  setSpeedX]      = useState(2);   // 기본 2배속
  const rowRefs = useRef({});
  const playTimerRef = useRef(null);

  // trip 변경 시 fixes fetch.
  useEffect(() => {
    if (!trip || !deviceId) { setPoints(null); return; }
    let cancelled = false;
    setError(null); setPoints(null);
    const from = trip.started_at;
    const to   = trip.ended_at || new Date().toISOString();
    api.listLocationsGrouped(deviceId, { since: from, until: to, fix_only: true, limit: 5000 })
      .then(groups => {
        if (cancelled) return;
        const asc = api.flattenGroupedAsc(groups)
          .filter(p => p.lat != null && p.lng != null);
        setPoints(asc);
      })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [deviceId, trip?.started_at, trip?.ended_at]);

  // 속도 + 누적 거리 계산 (haversine + Δt).
  const enriched = useMemo(() => {
    if (!points || points.length === 0) return [];
    const out = [];
    let cumM = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const prev = i > 0 ? points[i - 1] : null;
      let speed = null, dm = 0, dt = 0;
      if (prev) {
        dm = haversineM(prev.lat, prev.lng, p.lat, p.lng);
        dt = (new Date(p.recorded_at) - new Date(prev.recorded_at)) / 1000;
        if (dt > 0.1) speed = (dm / dt) * 3.6;   // km/h
      }
      cumM += dm;
      out.push({ ...p, _speed: speed, _cumM: cumM });
    }
    return out;
  }, [points]);

  // 균등 샘플링 — waypoint 목록은 최대 MAX_WAYPOINTS 개만 보여줌. 원본 인덱스 함께 보존.
  const samples = useMemo(() => {
    if (enriched.length === 0) return [];
    if (enriched.length <= MAX_WAYPOINTS) return enriched.map((p, i) => ({ ...p, _srcIdx: i }));
    const step = enriched.length / MAX_WAYPOINTS;
    const out = [];
    // 첫·마지막 포함, 사이는 균등.
    for (let k = 0; k < MAX_WAYPOINTS; k++) {
      const idx = Math.min(enriched.length - 1, Math.round(k * step));
      out.push({ ...enriched[idx], _srcIdx: idx });
    }
    return out;
  }, [enriched]);

  const totals = useMemo(() => {
    if (enriched.length === 0) return null;
    const first = enriched[0], last = enriched[enriched.length - 1];
    const durS = (new Date(last.recorded_at) - new Date(first.recorded_at)) / 1000;
    const km   = last._cumM / 1000;
    const avgKmh = durS > 0 ? (km / (durS / 3600)) : 0;
    return {
      km:  km.toFixed(1),
      dur: fmtDur(durS),
      avg: avgKmh.toFixed(1),
      startedAt: first.recorded_at,
      endedAt:   last.recorded_at,
    };
  }, [enriched]);

  function onRowClick(sample) {
    setActiveIdx(sample._srcIdx);
    // (F4-c) KakaoMap.panTo — 지도 이동 + seeker cursor 함께 이동.
    mapRef?.current?.panTo?.(sample.lat, sample.lng);
  }

  // (F4-d) 재생 컨트롤 — samples 순차 pan.
  // 각 sample 사이의 실제 시간 gap 을 speedX 로 나눠 정확한 timing 재현.
  useEffect(() => {
    if (!playing || samples.length === 0) return;
    let cancelled = false;
    // activeIdx 가 null 이면 첫 sample 부터.
    let curSampleIdx = Math.max(0, samples.findIndex(s => s._srcIdx === activeIdx));
    if (curSampleIdx < 0) curSampleIdx = 0;

    const step = () => {
      if (cancelled) return;
      if (curSampleIdx >= samples.length - 1) {
        setPlaying(false);
        return;
      }
      const cur  = samples[curSampleIdx];
      const next = samples[curSampleIdx + 1];
      const dtMs = Math.max(50, Math.min(3000,
        (new Date(next.recorded_at) - new Date(cur.recorded_at)) / speedX));
      playTimerRef.current = setTimeout(() => {
        if (cancelled) return;
        curSampleIdx += 1;
        const s = samples[curSampleIdx];
        setActiveIdx(s._srcIdx);
        mapRef?.current?.panTo?.(s.lat, s.lng, { instant: false });
        step();
      }, dtMs);
    };
    step();
    return () => { cancelled = true; if (playTimerRef.current) clearTimeout(playTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speedX, samples]);

  // trip 바뀌면 정지.
  useEffect(() => { setPlaying(false); setActiveIdx(null); }, [trip?.started_at]);

  // 활성 row 스크롤 into view.
  useEffect(() => {
    if (activeIdx == null) return;
    const el = rowRefs.current[activeIdx];
    el?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [activeIdx]);

  function scrubTo(sampleIdx) {
    const s = samples[sampleIdx];
    if (!s) return;
    setActiveIdx(s._srcIdx);
    mapRef?.current?.panTo?.(s.lat, s.lng, { instant: true });
  }

  if (!trip) return null;
  if (error) return <div style={{ padding: 'var(--space-4)', color: 'var(--danger)', fontSize: 12 }}>{error}</div>;
  if (!points) return <div style={{ padding: 'var(--space-4)', color: 'var(--text-3)', fontSize: 12 }}>운행 좌표 로딩...</div>;
  if (points.length === 0) return <div style={{ padding: 'var(--space-4)', color: 'var(--text-3)', fontSize: 12 }}>이 운행에 좌표가 없습니다.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      {/* 요약 카드 */}
      {totals && (
        <div style={{
          padding: 'var(--space-3)',
          background: 'var(--surface-2)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline' }}>
            <span style={{ fontSize: 20, fontWeight: 800, color: 'var(--primary)' }}>{totals.km}</span>
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>km</span>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-2)' }}>
              {totals.dur}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-3)', fontSize: 10, color: 'var(--text-3)' }}>
            <span>평균 {totals.avg}km/h</span>
            <span>{samples.length}포인트</span>
            {samples.length < enriched.length && (
              <span title="waypoint 표는 균등 샘플. 지도의 seeker path 는 원본 그대로">
                (원본 {enriched.length})
              </span>
            )}
          </div>
          {/* (F4-d) 출발/도착 주소 + 운전자 — trip 메타에서 */}
          {(trip.start_address || trip.end_address || trip.annotation?.driver_name) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4,
                paddingTop: 6, borderTop: '1px dashed var(--border)', fontSize: 11 }}>
              {trip.annotation?.driver_name && (
                <div style={{ display: 'flex', gap: 6, color: 'var(--text-2)' }}>
                  <Icon name="user" size={11} style={{ color: 'var(--text-3)' }} />
                  <span>{trip.annotation.driver_name}</span>
                </div>
              )}
              {trip.start_address && (
                <div style={{ display: 'flex', gap: 6, color: 'var(--text-2)' }}>
                  <span style={{ color: 'var(--accent)', fontWeight: 700 }}>출발</span>
                  <span style={{ minWidth: 0, overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{trip.start_address}</span>
                </div>
              )}
              {trip.end_address && (
                <div style={{ display: 'flex', gap: 6, color: 'var(--text-2)' }}>
                  <span style={{ color: 'var(--danger)', fontWeight: 700 }}>도착</span>
                  <span style={{ minWidth: 0, overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{trip.end_address}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* (F4-d) 재생 컨트롤 */}
      {samples.length > 1 && (
        <div style={{
          padding: 'var(--space-2) var(--space-3)',
          background: 'var(--surface-2)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column', gap: 'var(--space-2)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <button onClick={() => setPlaying(p => !p)}
              style={{
                width: 32, height: 32, borderRadius: '50%', border: 'none',
                background: playing ? 'var(--danger)' : 'var(--primary)',
                color: 'var(--primary-fg)', cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 14, fontWeight: 800,
              }}
              aria-label={playing ? '일시정지' : '재생'}>
              <Icon name={playing ? 'pause' : 'play'} size={13} />
            </button>
            <div style={{ display: 'flex', gap: 3, marginLeft: 'auto' }}>
              {SPEEDS.map(x => (
                <button key={x} onClick={() => setSpeedX(x)}
                  style={{
                    padding: '3px 8px', border: 'none', borderRadius: 'var(--radius-xs)',
                    background: speedX === x ? 'var(--primary)' : 'var(--surface)',
                    color: speedX === x ? 'var(--primary-fg)' : 'var(--text-2)',
                    fontSize: 10, fontWeight: 700, cursor: 'pointer',
                  }}>{x}x</button>
              ))}
            </div>
          </div>
          <input
            type="range"
            min={0}
            max={samples.length - 1}
            value={(() => {
              const i = samples.findIndex(s => s._srcIdx === activeIdx);
              return i < 0 ? 0 : i;
            })()}
            onChange={e => scrubTo(Number(e.target.value))}
            style={{ width: '100%', accentColor: 'var(--primary)' }}
          />
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            fontSize: 10, color: 'var(--text-3)', fontFamily: 'ui-monospace, monospace',
          }}>
            <span>
              {activeIdx != null && enriched[activeIdx]
                ? new Date(enriched[activeIdx].recorded_at).toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit', second:'2-digit' })
                : (samples[0] && new Date(samples[0].recorded_at).toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit' }))}
            </span>
            <span>
              {totals?.endedAt && new Date(totals.endedAt).toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit' })}
            </span>
          </div>
        </div>
      )}

      {/* waypoint 목록 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '28px 1fr 60px',
          padding: '4px 8px', fontSize: 10, fontWeight: 700, color: 'var(--text-3)',
          borderBottom: '1px solid var(--border)',
        }}>
          <span>#</span>
          <span>시간 · 좌표</span>
          <span style={{ textAlign: 'right' }}>km/h</span>
        </div>
        {samples.map((s, i) => {
          const anomaly = s._speed != null && s._speed >= SPEED_ANOMALY_KMH;
          const active = activeIdx === s._srcIdx;
          return (
            <button
              key={s._srcIdx}
              ref={el => { rowRefs.current[s._srcIdx] = el; }}
              onClick={() => onRowClick(s)}
              style={{
                display: 'grid', gridTemplateColumns: '28px 1fr 60px', gap: 4,
                padding: '6px 8px', textAlign: 'left', font: 'inherit',
                background: active
                  ? 'color-mix(in srgb, var(--primary) 12%, var(--surface))'
                  : 'transparent',
                border: 'none',
                borderLeft: `3px solid ${active ? 'var(--primary)' : 'transparent'}`,
                borderRadius: 'var(--radius-xs)',
                cursor: 'pointer',
                fontSize: 11, color: 'var(--text)',
              }}>
              <span style={{ color: 'var(--text-3)', fontFamily: 'ui-monospace, monospace' }}>
                {samples.length - i}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 600 }}>
                  {new Date(s.recorded_at).toLocaleTimeString('ko-KR', {
                    hour: '2-digit', minute: '2-digit', second: '2-digit',
                  })}
                </div>
                <div style={{ fontSize: 9, color: 'var(--text-3)',
                    fontFamily: 'ui-monospace, monospace' }}>
                  {s.lat.toFixed(5)}, {s.lng.toFixed(5)}
                </div>
              </div>
              <span style={{
                textAlign: 'right', fontWeight: 700,
                color: anomaly ? 'var(--danger)' : (s._speed != null ? 'var(--text)' : 'var(--text-3)'),
                fontFamily: 'ui-monospace, monospace', fontSize: 12,
              }} title={anomaly ? 'GPS 튀는 값 의심 (>200km/h)' : undefined}>
                {s._speed != null ? Math.round(s._speed) : '—'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function fmtDur(sec) {
  if (!sec || sec < 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m}분`;
}
