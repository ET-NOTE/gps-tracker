import CycleListSection from './CycleListSection';
import { exportGpx, exportCsv } from '../lib/routeExport';
import { mapSheet } from './mapSheetStyles';
// 홈 운행 도구의 상세 운행 분석 — 선택된 단말기의 과거 위치 탐색.
// 두 가지 모드:
//   ① 일간: 한 날짜 + 시간 윈도우. KPI / 슬라이더 / 재생 / AI 분석 모두 한 화면에.
//   ② 월간: 그 달 전체 — 히트맵 달력 + 그 달 모든 점 지도 표시. 날짜 클릭 → 일간으로.
//
// 옵션 (속도별 색상, 정지 강조) 은 localStorage 영속.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { getDeviceColor } from '../colors';
import Icon from './Icon';
import useBreakpoint from '../useBreakpoint';
import useSeekerPoints from '../useSeekerPoints';
import { dayWindow, bucket10min, kstDate, KST_TIME_OPTIONS, BUCKET_LABEL } from '../lib/seeker';
import useSwipeDownClose from '../useSwipeDownClose';
import { analyzePath } from '../lib/stops';
import { confirmDialog, alertDialog } from './Dialog';

const KST_TZ = 9 * 3600 * 1000;
const EMPTY_POINTS = [];

// 옵션 영속 키
const PREF_SPEED_COLOR = 'seeker_speed_color';
const PREF_SHOW_STOPS  = 'seeker_show_stops';

function slotWindow(dateStr, slot, hours) {
  const startMs = Date.parse(`${dateStr}T${slot}:00+09:00`);
  return { startMs, endMs: Math.min(startMs + hours * 3600000, Date.parse(dayWindow(dateStr).until)) };
}
const todayKstStr = () => kstDate();
const thisMonthKstStr = () => kstDate().slice(0, 7);

function totalKm(points) {
  return analyzePath(points).distanceM / 1000;
}
function fmtDuration(seconds) {
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

// ════════════════════════════════════════════════════════════
// SeekerSheet
// ════════════════════════════════════════════════════════════
export default function SeekerSheet({ device, mapRef, onClose }) {
  const bp = useBreakpoint();
  const isDesktop = bp === 'desktop';
  const [mode, setMode]   = useState('day');           // 'day' | 'month'
  const [month, setMonth] = useState(thisMonthKstStr());
  const [date, setDate]   = useState(todayKstStr());
  const [startSlot, setStartSlot] = useState('00:00');  // "HH:MM" 10분 버킷
  const [hours, setHours] = useState(24);
  // Auto uses 1m for days and 1h for months; explicit choices are never substituted.
  const [refreshKey, setRefreshKey] = useState(0);
  const [precision, setPrecision] = useState('auto');   // 'auto' | '1m' | '5m' | '1h'
  // 카메라 follow — 재생 중 cursor 가 화면 밖으로 나가면 자동 panTo. default ON.
  const [cameraFollow, setCameraFollow] = useState(true);
  // 선택된 trip (null = 전체). client-side detect.
  const [selectedTripIdx, setSelectedTripIdx] = useState(null);
  // 비교 모드 — 2개 이하 trip 을 선택해 KPI side-by-side. selectedTripIdx 는 단일 선택용.
  const [compareMode, setCompareMode] = useState(false);
  const [compareIdxs, setCompareIdxs] = useState([]);  // up to 2 trip indices

  // 영속 옵션 — userPrefs.seeker (server sync) 우선, localStorage 는 부트 seed / offline fallback.
  // speedColor default OFF (시각적 노이즈), showStops default ON (cluster 한눈에 파악).
  const [speedColor, setSpeedColor] = useState(() => {
    return localStorage.getItem(PREF_SPEED_COLOR) === 'true';
  });
  const [showStops, setShowStops]   = useState(() => {
    const v = localStorage.getItem(PREF_SHOW_STOPS);
    return v === null ? true : (v === 'true');
  });

  const seekerHydratedRef = useRef(false);   // 첫 서버 응답 전에는 토글 → 서버 patch 안 함

  // 서버 값 hydrate + 최초 device 라면 localStorage 값 서버 push (마이그레이션).
  useEffect(() => {
    (async () => {
      let prefs;
      try { prefs = await api.getMyPrefs(); } catch { return; }
      const s = prefs?.seeker;
      if (s && typeof s === 'object') {
        if (typeof s.speed_color === 'boolean') setSpeedColor(s.speed_color);
        if (typeof s.show_stops  === 'boolean') setShowStops(s.show_stops);
      } else {
        // 서버 없음 — 로컬 값이라도 있으면 승격
        const migrate = {};
        const localSpeed = localStorage.getItem(PREF_SPEED_COLOR);
        const localStops = localStorage.getItem(PREF_SHOW_STOPS);
        if (localSpeed !== null) migrate.speed_color = localSpeed === 'true';
        if (localStops !== null) migrate.show_stops  = localStops  === 'true';
        if (Object.keys(migrate).length > 0) {
          api.patchMyPrefs({ seeker: migrate }).catch(() => {});
        }
      }
      seekerHydratedRef.current = true;
    })();
  }, []);

  // 사용자 토글 → localStorage (부트 seed) + 서버 (계정 sync, hydrate 이후만).
  useEffect(() => {
    localStorage.setItem(PREF_SPEED_COLOR, String(speedColor));
    if (!seekerHydratedRef.current) return;
    api.patchMyPrefs({ seeker: { speed_color: speedColor, show_stops: showStops } }).catch(() => {});
  }, [speedColor]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    localStorage.setItem(PREF_SHOW_STOPS, String(showStops));
    if (!seekerHydratedRef.current) return;
    api.patchMyPrefs({ seeker: { speed_color: speedColor, show_stops: showStops } }).catch(() => {});
  }, [showStops]);   // eslint-disable-line react-hooks/exhaustive-deps

  const { points: loadedPoints, loading, error, bucket } = useSeekerPoints(device?.id, mode, date, month, precision, refreshKey);
  const dayPoints = mode === 'day' ? loadedPoints : EMPTY_POINTS;
  const monthPoints = mode === 'month' ? loadedPoints : EMPTY_POINTS;
  const [dailyStats, setDailyStats] = useState([]);    // { date, distance_m, moving_s, stop_count, max_speed_kmh, ... }

  // 슬라이더 (일간 전용)
  const [idx, setIdx]         = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(60);
  const playerRef = useRef(null);
  const handleRef = useRef(null);

  // AI — 이력 기반.
  // history: 이 (device, date) 의 과거 분석 row 들 (최신순). selectedAiId 가 현재 보고 있는 row.
  // 새 분석은 이력에 누적 (재과금 후 새 row).
  const [aiBusy, setAiBusy]   = useState(false);
  const [aiError, setAiError] = useState(null);
  const [aiUsage, setAiUsage] = useState(null);
  const [aiOpen, setAiOpen]   = useState(false);
  const [aiHistory, setAiHistory] = useState([]);   // [{ id, analysis, model, created_at, cost_credits }]
  const [selectedAiId, setSelectedAiId] = useState(null);

  const color = device ? getDeviceColor(device) : '#5B7CFF';

  // 연구소 토글 — 사이클 seeker
  const [labCycleOn, setLabCycleOn] = useState(false);
  useEffect(() => {
    api.getMyPrefs().then(p => setLabCycleOn(!!p?.lab_cycle_seeker)).catch(() => {});
  }, []);

  // ─── 일별 통계 (365일) — 한 번만 ─────────────────────────
  // active-dates 와 union: daily_stats 가 catchup 안 된 날짜도 운행 분석가 인식하도록.
  const [activeDates, setActiveDates] = useState([]);
  const [datesLoading, setDatesLoading] = useState(true);
  const [datesError, setDatesError] = useState(null);
  useEffect(() => {
    if (!device?.id) return;
    let cancelled = false;
    setDatesLoading(true); setDatesError(null);
    Promise.allSettled([api.getDailyStats(device.id, { limit: 365 }), api.getActiveDates(device.id)])
      .then(([stats, dates]) => {
        if (cancelled) return;
        if (stats.status === 'fulfilled') setDailyStats(stats.value || []);
        if (dates.status === 'fulfilled') setActiveDates(dates.value || []);
        if (stats.status === 'rejected' || dates.status === 'rejected') setDatesError('날짜 또는 통계를 모두 불러오지 못했습니다');
        setDatesLoading(false);
      });
    return () => { cancelled = true; };
  }, [device?.id, refreshKey]);

  const availDates = useMemo(() => {
    const set = new Set(dailyStats.map(s => s.date));
    for (const d of activeDates) set.add(d);
    return Array.from(set).sort().reverse();    // 최근 날짜가 위로
  }, [dailyStats, activeDates]);

  // 첫 진입 시 오늘 데이터 없으면 가장 최근 활동일로
  const autoJumpedRef = useRef(false);
  useEffect(() => {
    if (autoJumpedRef.current || availDates.length === 0) return;
    if (!availDates.includes(date)) setDate(availDates[0]);
    autoJumpedRef.current = true;
  }, [availDates, date]);

  // AI 사용량
  useEffect(() => { api.aiUsageToday().then(setAiUsage).catch(() => {}); }, []);

  // (device, date) 변경 시 영구 이력 로드 — 가장 최신 분석 자동 선택, 재과금 없이 표시.
  useEffect(() => {
    setAiError(null);
    if (!device?.id || mode !== 'day') {
      setAiHistory([]);
      setSelectedAiId(null);
      return;
    }
    let cancelled = false;
    api.listAiAnalyses(device.id, { date })
      .then(rows => {
        if (cancelled) return;
        setAiHistory(rows || []);
        setSelectedAiId((rows || [])[0]?.id ?? null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [device?.id, date, mode]);

  // 현재 보고 있는 분석 row
  const selectedAnalysis = useMemo(
    () => aiHistory.find(r => r.id === selectedAiId) || null,
    [aiHistory, selectedAiId],
  );
  const aiText = selectedAnalysis?.analysis || null;

  // ─── lifecycle 이벤트 fetch (trip 경계 정확도 향상) ─────
  // sleep_enter / wake 이벤트는 운행 경계를 확정해줌. 5분 gap 휴리스틱 보완.
  // 단순화: getDeviceEvents 는 최근 50개 — 멀리 과거 날짜는 커버 못 할 수 있음. best-effort.
  const [events, setEvents] = useState([]);
  useEffect(() => {
    if (mode !== 'day' || !device?.id) { setEvents([]); return; }
    let cancelled = false;
    api.getDeviceEvents(device.id)
      .then(rows => { if (!cancelled) setEvents(rows || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [device?.id, mode]);

  const dayEvents = useMemo(() => {
    if (mode !== 'day') return [];
    const w = dayWindow(date, 0, 24);
    const since = new Date(w.since).getTime();
    const until = new Date(w.until).getTime();
    return events.filter(e => {
      const t = new Date(e.occurred_at).getTime();
      return t >= since && t < until;
    });
  }, [events, date, mode]);

  // ─── 일간 데이터의 10분 버킷 — 시작 시각 드롭다운 옵션 ──
  const availableSlots = useMemo(() => {
    const set = new Set();
    for (const p of dayPoints) set.add(bucket10min(p.recorded_at));
    return Array.from(set).sort();
  }, [dayPoints]);

  // 일간 시간 윈도우로 슬라이스 (재패치 X, 클라 메모이즈)
  const slicedDay = useMemo(() => {
    if (dayPoints.length === 0) return [];
    const { startMs, endMs } = slotWindow(date, startSlot, hours);
    return dayPoints.filter(p => {
      const t = new Date(p.recorded_at).getTime();
      return t >= startMs && t < endMs;
    });
  }, [dayPoints, startSlot, hours, date]);

  // 모드별 raw points
  const rawPoints = mode === 'day' ? slicedDay : monthPoints;

  // ─── Trip 단위 detection (client-side) ──────────────────
  // 두 인접 점 사이 gap > 5분이거나 그 사이에 sleep_enter 이벤트가 있으면 새 운행.
  // sleep_enter 이벤트가 있으면 eventConfirmed=true → trip 경계 확정 (UI 배지).
  // 1점 trip 은 무시. 일간 모드에서만 활성.
  const trips = useMemo(() => {
    if (mode !== 'day' || bucket === '1h' || rawPoints.length === 0) return [];
    const STOP_GAP_MS = 5 * 60 * 1000;
    const sleepTs = dayEvents
      .filter(e => e.kind === 'sleep_enter')
      .map(e => new Date(e.occurred_at).getTime())
      .sort((a, b) => a - b);
    const out = [];
    let start = 0;
    let prevConfirmed = false;
    for (let i = 1; i < rawPoints.length; i++) {
      const tA = new Date(rawPoints[i - 1].recorded_at).getTime();
      const tB = new Date(rawPoints[i].recorded_at).getTime();
      const dt = tB - tA;
      const hasSleep = sleepTs.some(s => s > tA && s < tB);
      if (hasSleep || dt > STOP_GAP_MS) {
        if (i - start >= 2) {
          out.push({ start, end: i - 1, points: rawPoints.slice(start, i),
            eventConfirmed: hasSleep || prevConfirmed });
        }
        start = i;
        prevConfirmed = hasSleep;
      }
    }
    if (rawPoints.length - start >= 2) {
      out.push({ start, end: rawPoints.length - 1, points: rawPoints.slice(start),
        eventConfirmed: prevConfirmed });
    }
    return out;
  }, [rawPoints, mode, dayEvents, bucket]);

  // 사용자가 trip pill 선택했으면 그 trip 의 점만, 아니면 전체.
  const points = useMemo(() => {
    if (selectedTripIdx == null || trips.length === 0) return rawPoints;
    const t = trips[selectedTripIdx];
    return t ? t.points : rawPoints;
  }, [rawPoints, trips, selectedTripIdx]);

  // trip 목록 / 모드 / 데이터 바뀌면 selectedTrip 리셋
  useEffect(() => { setSelectedTripIdx(null); setCompareIdxs([]); setCompareMode(false); }, [date, mode, hours, startSlot, precision, refreshKey]);

  // 윈도우 변경 시 슬라이더 리셋
  useEffect(() => {
    setIdx(0); setPlaying(false);
  }, [startSlot, hours, mode, dayPoints, monthPoints, selectedTripIdx]);

  // 점 변경 시 지도 다시 그리기
  useEffect(() => {
    if (!mapRef.current) return;
    if (points.length === 0) {
      mapRef.current.clearSeekerPath();
      handleRef.current = null;
      return;
    }
    handleRef.current = mapRef.current.drawSeekerPath(points, {
      color, speedColor, showStops,
      showCursor: mode === 'day',
      onPointClick: (p) => {
        if (mode === 'month') {
          // 월간 → 그 점 시각의 날짜 + 가까운 슬롯으로 일간 모드 점프
          const kst = new Date(new Date(p.recorded_at).getTime() + KST_TZ);
          setDate(kst.toISOString().slice(0, 10));
          setStartSlot(bucket10min(p.recorded_at));
          setHours(3);
          setMode('day');
        }
      },
    });
  }, [points, color, speedColor, showStops, mode]);

  useEffect(() => () => mapRef.current?.clearSeekerPath(), []);

  // 슬라이더 → cursor (일간 전용)
  useEffect(() => {
    if (mode !== 'day') return;
    handleRef.current?.setCursor?.(idx);
    // 카메라 follow — 재생 중 cursor 가 화면 밖으로 나가면 panTo
    if (cameraFollow && playing) {
      const cur = points[idx];
      if (cur && cur.lat != null && cur.lng != null) {
        mapRef.current?.panToCoord?.(cur.lat, cur.lng);
      }
    }
  }, [idx, mode, cameraFollow, playing, points]);

  // 재생
  // (F7-d) 이전 구조 (setIdx updater 안에서 setTimeout 스케줄) 는 StrictMode 가
  // updater 2회 호출 시 timer 2개 스폰 + playerRef 는 마지막만 보유 → 첫 timer orphan
  // → 재생 속도 2배 + unmount 후 setState. tick 을 pure 하게: idx 는 ref 로 읽고
  // setState 는 pure updater, 다음 setTimeout 은 updater 밖에서 등록.
  const idxRef = useRef(0);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => {
    if (mode !== 'day' || !playing || points.length < 2) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const i = idxRef.current;
      if (i >= points.length - 1) { setPlaying(false); return; }
      const cur = new Date(points[i].recorded_at).getTime();
      const nxt = new Date(points[i + 1].recorded_at).getTime();
      const realMs = nxt - cur;
      setIdx(prev => prev + 1);
      playerRef.current = setTimeout(tick, Math.max(50, Math.min(2000, realMs / playSpeed)));
    };
    playerRef.current = setTimeout(tick, 100);
    return () => { cancelled = true; clearTimeout(playerRef.current); };
  }, [playing, points, playSpeed, mode]);
  useEffect(() => { setPlaying(false); }, [mode]);

  async function handleAnalyze() {
    if (!device?.id) return;
    // 잔액 부족 사전 경고 (admin 무제한 제외)
    if (aiUsage && !aiUsage.unlimited
        && aiUsage.cost_per_analysis != null
        && aiUsage.credit_balance != null
        && aiUsage.credit_balance < aiUsage.cost_per_analysis) {
      setAiError(`포인트가 부족합니다. 분석 1회 ${aiUsage.cost_per_analysis} 포인트, 보유 ${aiUsage.credit_balance} 포인트. 내정보 → 포인트 충전을 먼저 진행하세요.`);
      return;
    }
    setAiBusy(true); setAiError(null);
    try {
      const r = await api.analyzeRoute(device.id, date);
      // 새 분석 row 가 서버에 저장됨 — 이력 다시 로드해서 맨 위로
      const rows = await api.listAiAnalyses(device.id, { date });
      setAiHistory(rows || []);
      setSelectedAiId(r.analysis_id ?? (rows || [])[0]?.id ?? null);
      setAiUsage(prev => ({
        ...(prev || {}),
        used_today:        r.used_today,
        limit:             r.limit,
        unlimited:         r.unlimited,
        cost_per_analysis: prev?.cost_per_analysis ?? 20,
        credit_balance:    r.credit_balance,
      }));
    } catch (e) {
      setAiError(e.message || 'AI 분석 실패');
      // 잔액 변동 가능 (실패 시 환불) → 갱신
      api.aiUsageToday().then(setAiUsage).catch(() => {});
    } finally { setAiBusy(false); }
  }

  async function handleDeleteAnalysis(id) {
    try {
      await api.deleteAiAnalysis(id);
      const rows = aiHistory.filter(r => r.id !== id);
      setAiHistory(rows);
      if (selectedAiId === id) setSelectedAiId(rows[0]?.id ?? null);
    } catch (e) { setAiError(e.message); }
  }

  const cur = points[idx];
  const pathMetrics = useMemo(() => analyzePath(points), [points]);
  const stopCount = pathMetrics.stopCount;
  const maxSpeed = useMemo(() => {
    const values = points.map(p => p.speed_max_kmh ?? p._speed).filter(Number.isFinite);
    return values.length ? Math.max(...values) : null;
  }, [points]);
  // Every displayed KPI uses the selected points, not the whole day's cached stats.
  const idleSec = pathMetrics.stoppedS;
  const avgSpeed = pathMetrics.movingS > 0 ? pathMetrics.distanceM / pathMetrics.movingS * 3.6 : 0;

  // 모바일 compact 모드 — 재생 시작 시 자동 ON. 헤더+옵션+KPI 숨겨 지도 가시성 확보.
  // 사용자가 explicit 펴기 (▲ 버튼) 누르면 OFF.
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    if (isDesktop) { setCompact(false); return; }
    if (playing) setCompact(true);   // 재생 시작 → 축소
  }, [playing, isDesktop]);

  // Wake Lock — 재생 중 화면 꺼짐 방지. 모바일 운행 1시간짜리 재생 중 폰 잠기면 끊김.
  // 두 경로:
  //   1) Flutter 앱 (InAppWebView) — JS handler 'SetKeepAwake' 로 native FLAG_KEEP_SCREEN_ON.
  //   2) 일반 브라우저 — Screen Wake Lock API (Chrome 84+, Safari 16.4+).
  // 둘 다 best-effort, 실패해도 silent.
  const wakeLockRef = useRef(null);
  function callFlutterKeepAwake(on) {
    try {
      const ipc = window.flutter_inappwebview;
      if (ipc && typeof ipc.callHandler === 'function') {
        ipc.callHandler('SetKeepAwake', !!on);
      }
    } catch (_) {}
  }
  useEffect(() => {
    if (!playing) {
      callFlutterKeepAwake(false);
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
      return;
    }
    callFlutterKeepAwake(true);
    if (!('wakeLock' in navigator)) return;
    let cancelled = false;
    navigator.wakeLock.request('screen').then(lock => {
      if (cancelled) { lock.release().catch(() => {}); return; }
      wakeLockRef.current = lock;
      lock.addEventListener?.('release', () => {
        if (wakeLockRef.current === lock) wakeLockRef.current = null;
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [playing]);
  // 탭 전환 후 복귀 시 wake lock 재요청 (브라우저가 자동 해제)
  useEffect(() => {
    function onVis() {
      if (!playing) return;
      if (document.visibilityState !== 'visible') return;
      if (wakeLockRef.current) return;
      if (!('wakeLock' in navigator)) return;
      navigator.wakeLock.request('screen')
        .then(lock => { wakeLockRef.current = lock; })
        .catch(() => {});
    }
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [playing]);
  useEffect(() => () => {
    callFlutterKeepAwake(false);
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
  }, []);

  // 키보드 단축키 (PC) — space=play/pause, ←/→ = step, Home/End = jump
  useEffect(() => {
    if (!isDesktop || mode !== 'day' || points.length === 0) return;
    function onKey(e) {
      // 입력 중에는 무시
      const t = e.target;
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || t?.closest?.('input, textarea, select, button, a, [contenteditable=true], [role=dialog]')) return;
      if (e.key === ' ') {
        e.preventDefault();
        setPlaying(p => !p);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setPlaying(false);
        setIdx(i => Math.min(points.length - 1, i + (e.shiftKey ? 10 : 1)));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setPlaying(false);
        setIdx(i => Math.max(0, i - (e.shiftKey ? 10 : 1)));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setPlaying(false);
        setIdx(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setPlaying(false);
        setIdx(points.length - 1);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isDesktop, mode, points.length]);

  const swipe = useSwipeDownClose(onClose, { enabled: !isDesktop && !compact });

  const progressPct = points.length > 1
    ? Math.round((idx / (points.length - 1)) * 100)
    : 0;

  // ─── Compact (모바일 재생 모드) — 화면 최소 점유 ──────────
  if (compact) {
    return (
      <div style={sty.compact}>
        <button onClick={() => setCompact(false)} style={sty.compactExpand} title="펴기">
          ▲
        </button>
        {points.length > 0 && (
          <SpeedSparkline points={points} cursorIdx={idx}
            maxSpeed={maxSpeed ?? 0}
            onSeek={(i) => { setPlaying(false); setIdx(i); }} />
        )}
        <div style={sty.compactRow}>
          <button onClick={() => setPlaying(p => !p)} style={sty.playBtn}
            title={playing ? '일시정지' : '재생'}>
            <Icon name={playing ? 'pause' : 'play'} size={14} fill="currentColor" />
          </button>
          <input aria-label="경로 재생 위치" type="range" min={0} max={Math.max(0, points.length - 1)} value={idx}
            onChange={e => { setPlaying(false); setIdx(Number(e.target.value)); }}
            style={{ flex: 1, accentColor: 'var(--primary)' }} />
          <select aria-label="재생 속도" value={playSpeed} onChange={e => setPlaySpeed(Number(e.target.value))}
            style={sty.smallSelect}>
            <option value={30}>30x</option>
            <option value={60}>60x</option>
            <option value={120}>120x</option>
            <option value={300}>300x</option>
            <option value={600}>600x</option>
          </select>
          <button onClick={onClose} style={sty.closeBtn} title="닫기" aria-label="닫기">
            <Icon name="close" size={14} />
          </button>
        </div>
        {cur && (
          <div style={{
            ...sty.cursorInfo, marginTop: 4,
            background: 'transparent', border: 'none', padding: '0 4px',
          }}>
            <span>{new Date(cur.recorded_at).toLocaleTimeString('ko-KR', {
              ...KST_TIME_OPTIONS,
              hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span>
            <span style={{ color: 'var(--text-3)' }}>{idx + 1}/{points.length} · {progressPct}%</span>
            {cur._speed != null && (
              <span style={{ color: 'var(--primary)', fontWeight: 700 }}>{cur._speed.toFixed(0)} km/h</span>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <section aria-label="상세 운행 분석" className="gps-map-tool" style={isDesktop ? sty.deskWindow : sty.bottom}>
      {/* ── 헤더 ── 모바일은 swipe-down 으로도 닫힘. drag handle 시각 표시. */}
      <header style={sty.header} {...swipe}>
        {!isDesktop && <div style={sty.dragHandle} />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <Icon name="route" size={16} style={{ color: 'var(--primary)', flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {device?.display_name || device?.device_uid || '단말기'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 1 }}>운행 분석</div>
          </div>
        </div>
        <button onClick={() => setRefreshKey(v => v + 1)} disabled={loading} style={{ ...sty.closeBtn, width: 'auto', padding: '0 10px', marginLeft: 'auto', whiteSpace: 'nowrap' }}>새로고침</button>
        <button onClick={onClose} style={sty.closeBtn} title="닫기" aria-label="닫기">
          <Icon name="close" size={14} />
        </button>
      </header>

      {/* ── 모드 토글 ── */}
      <div style={sty.tabs}>
        {[
          { id: 'day',   label: '일간' },
          { id: 'month', label: '월간' },
        ].map(t => (
          <button key={t.id} aria-pressed={mode === t.id} onClick={() => setMode(t.id)} style={{
            ...sty.tab, ...(mode === t.id ? sty.tabOn : null),
          }}>{t.label}</button>
        ))}
      </div>

      {/* ── 옵션 토글 (영속) ── */}
      <div style={sty.opts}>
        <ChipToggle label="속도별 색상" icon="spark"  on={speedColor}    onClick={() => setSpeedColor(v => !v)} />
        <ChipToggle label="정지 강조"   icon="mapPin" on={showStops}     onClick={() => setShowStops(v => !v)} />
        <ChipToggle label="카메라 따라가기" icon="target" on={cameraFollow} onClick={() => setCameraFollow(v => !v)} />
      </div>

      <div style={{ display: 'flex', gap: 6, padding: '8px 14px', alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: 'var(--text-2)' }}>
        <span>경로 요약</span>
        {['auto', '1m', '5m', '1h'].map(p => (
          <button key={p} aria-pressed={precision === p} onClick={() => setPrecision(p)} style={{
            padding: '6px 10px', minHeight: 44,
            border: '1px solid ' + (precision === p ? 'var(--primary)' : 'var(--border)'),
            background: precision === p ? 'var(--primary)' : 'var(--surface-2)',
            color: precision === p ? 'var(--primary-fg)' : 'var(--text-2)',
            borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 12,
          }}>{p === 'auto' ? '자동' : BUCKET_LABEL[p]}</button>
        ))}
        <div style={{ width: '100%', fontSize: 12 }}>{BUCKET_LABEL[bucket]} 간격 대표점 · 한국 시간 (KST)</div>
      </div>

      <div style={sty.body} aria-busy={loading}>
        {loading && <div role="status" style={sty.empty}>경로 불러오는 중…</div>}
        {error && <div role="alert" style={{ ...sty.empty, color: 'var(--danger)' }}>
          <div>{error}</div><button onClick={() => setRefreshKey(v => v + 1)} style={sty.emptyAction}>다시 시도</button>
        </div>}
        {datesError && <div role="status" style={{ fontSize: 12, color: 'var(--warning)', marginBottom: 8 }}>{datesError} · 새로고침으로 재시도하세요.</div>}


        {labCycleOn && device && (
          <CycleListSection
            key={device.id}
            deviceId={device.id}
            color={color}
            onSeek={(c) => {
              setMode('day');
              setDate(kstDate(c.start));
              setStartSlot(bucket10min(c.start));
              setHours(Math.max(1, Math.ceil(c.durationS / 3600) + 1));
            }}
          />
        )}

        {/* ──────────────── 일간 모드 ──────────────── */}
        {mode === 'day' && (
          <>
            <DateRow date={date} availDates={availDates} pending={datesLoading}
              hasData={availDates.includes(date)}
              onChange={d => { autoJumpedRef.current = true; setDate(d); }} />

            <TimeRangeSlider
              startSlot={startSlot}
              hours={hours}
              availableSlots={availableSlots}
              onChange={(s, h) => { setStartSlot(s); setHours(h); }}
            />

            {/* Trip pills — 운행 단위 자동 분리 (gap > 5분). 1개 이하면 비표시. */}
            {trips.length > 1 && (
              <>
                <div style={sty.tripPills}>
                  {!compareMode && (
                    <button onClick={() => setSelectedTripIdx(null)}
                      style={{ ...sty.tripPill, ...(selectedTripIdx == null ? sty.tripPillOn : null) }}>
                      전체
                    </button>
                  )}
                  {trips.map((t, i) => {
                    const start = new Date(t.points[0].recorded_at);
                    const end   = new Date(t.points[t.points.length - 1].recorded_at);
                    const km = totalKm(t.points).toFixed(1);
                    const fmt = (d) => d.toLocaleTimeString('ko-KR', { ...KST_TIME_OPTIONS, hour: '2-digit', minute: '2-digit', hour12: false });
                    const inCompare = compareIdxs.includes(i);
                    const onClick = () => {
                      if (compareMode) {
                        setCompareIdxs(prev => {
                          if (prev.includes(i)) return prev.filter(x => x !== i);
                          if (prev.length >= 2) return [prev[1], i];
                          return [...prev, i];
                        });
                      } else {
                        setSelectedTripIdx(i);
                      }
                    };
                    const isOn = compareMode ? inCompare : selectedTripIdx === i;
                    return (
                      <button key={i} onClick={onClick}
                        style={{ ...sty.tripPill, ...(isOn ? sty.tripPillOn : null) }}
                        title={`${fmt(start)}~${fmt(end)}, ${km} km${t.eventConfirmed ? ' (이벤트 확정)' : ''}`}>
                        운행 {i + 1}
                        {t.eventConfirmed && (
                          <span style={{ fontSize: 12, marginLeft: 3, opacity: 0.85 }} title="sleep/wake 이벤트로 경계 확정">●</span>
                        )}
                        <span style={{ fontSize: 12, marginLeft: 4, opacity: 0.7 }}>
                          {fmt(start)}~{fmt(end)} · {km}km
                        </span>
                      </button>
                    );
                  })}
                  <button onClick={() => {
                    setCompareMode(m => !m);
                    setCompareIdxs([]);
                    setSelectedTripIdx(null);
                  }} style={{
                    ...sty.tripPill,
                    ...(compareMode ? sty.tripPillOn : null),
                    marginLeft: 'auto',
                  }} title="2개 운행 비교">
                    {compareMode ? '비교 끄기' : '⇄ 비교'}
                  </button>
                </div>
                {compareMode && compareIdxs.length === 2 && (
                  <CompareKpis trips={compareIdxs.map(i => trips[i])} />
                )}
                {compareMode && compareIdxs.length < 2 && (
                  <div style={{
                    fontSize: 12, color: 'var(--text-3)', marginBottom: 8, textAlign: 'center',
                    background: 'var(--surface-2)', borderRadius: 6, padding: 8,
                  }}>
                    비교할 운행 {2 - compareIdxs.length}개 더 선택하세요
                  </div>
                )}
              </>
            )}

            {/* KPI */}
            {points.length > 0 && <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8 }}>
              {bucket === '1h' ? '1시간 요약에서는 거리·운행·정차를 판별하기 어렵습니다. 1분 또는 5분을 선택하세요.' : '거리·운행·정차는 표시 경로의 추정치입니다.'}
            </div>}
            {points.length > 0 ? (
              <div style={sty.kpiGrid}>
                <Kpi label="표시 경로 거리" value={bucket === '1h' ? '—' : `${totalKm(points).toFixed(1)} km`} />
                <Kpi label="운행시간" value={bucket === '1h' ? '—' : fmtDuration(pathMetrics.movingS)} />
                <Kpi label="표시 경로 평균속도" value={avgSpeed > 0 ? `${avgSpeed.toFixed(0)} km/h` : '—'} />
                <Kpi label="최고속도" value={maxSpeed == null ? '—' : `${maxSpeed.toFixed(0)} km/h`} />
                <Kpi label="정차시간" value={idleSec > 0 ? fmtDuration(idleSec) : '—'} />
                <Kpi label="정지 횟수" value={bucket === '1h' ? '—' : `${stopCount}회`} />
              </div>
            ) : !loading && !error && (
              <EmptyState
                msg={dayPoints.length > 0
                  ? '이 시간 범위에 데이터 없음'
                  : '이 날에 데이터가 없습니다'}
                actions={(() => {
                  const acts = [];
                  // 데이터는 있지만 슬롯 윈도우가 어긋남 → 24h 전체로
                  if (dayPoints.length > 0 && (hours !== 24 || startSlot !== '00:00')) {
                    acts.push({
                      label: '하루 전체 보기',
                      onClick: () => { setStartSlot('00:00'); setHours(24); },
                    });
                  }
                  // 다른 날짜 보기 — 가장 가까운 활동일로 점프
                  if (availDates.length > 0 && dayPoints.length === 0) {
                    const next = availDates.find(d => d !== date) || availDates[0];
                    if (next && next !== date) {
                      acts.push({
                        label: `최근 활동일 (${next.slice(5)})`,
                        onClick: () => setDate(next),
                      });
                    }
                  }
                  if (date !== todayKstStr()) {
                    acts.push({ label: '오늘로', onClick: () => setDate(todayKstStr()) });
                  }
                  return acts;
                })()} />
            )}

            {/* 속도 sparkline + 슬라이더 */}
            {points.length > 0 && (
              <>
                <SpeedSparkline points={points} cursorIdx={idx} maxSpeed={maxSpeed ?? 0}
                  onSeek={(i) => { setPlaying(false); setIdx(i); }} />
                <div style={sty.player}>
                  <button onClick={() => setPlaying(p => !p)} style={sty.playBtn}
                    title={playing ? '일시정지' : '재생'}>
                    <Icon name={playing ? 'pause' : 'play'} size={14} fill="currentColor" />
                  </button>
                  <input aria-label="경로 재생 위치" type="range" min={0} max={points.length - 1} value={idx}
                    onChange={e => { setPlaying(false); setIdx(Number(e.target.value)); }}
                    style={{ flex: 1, accentColor: 'var(--primary)' }} />
                  <select aria-label="재생 속도" value={playSpeed} onChange={e => setPlaySpeed(Number(e.target.value))}
                    style={sty.smallSelect}>
                    <option value={30}>30x</option>
                    <option value={60}>60x</option>
                    <option value={120}>120x</option>
                    <option value={300}>300x</option>
                    <option value={600}>600x</option>
                  </select>
                </div>
              </>
            )}
            {cur && (
              <div style={sty.cursorInfo}>
                <span>{new Date(cur.recorded_at).toLocaleString('ko-KR', {
                  ...KST_TIME_OPTIONS,
                  hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                <span style={{ color: 'var(--text-3)' }}>{idx + 1} / {points.length} · {progressPct}%</span>
                {cur._speed != null && (
                  <span style={{ color: 'var(--primary)', fontWeight: 600 }}>{cur._speed.toFixed(0)} km/h</span>
                )}
              </div>
            )}

            {/* 도구 — export, 공유 */}
            {points.length > 0 && (
              <div style={sty.toolRow}>
                <button onClick={() => {
                  const tag = selectedTripIdx != null ? `_trip${selectedTripIdx + 1}` : '';
                  exportGpx(points, `${device?.display_name || device?.device_uid || 'track'}_${date}${tag}.gpx`);
                }} style={sty.toolBtn} title="GPX 내보내기 (지도/네비 앱)">
                  <Icon name="share" size={11} /> GPX
                </button>
                <button onClick={() => {
                  const tag = selectedTripIdx != null ? `_trip${selectedTripIdx + 1}` : '';
                  exportCsv(points, `${device?.display_name || device?.device_uid || 'track'}_${date}${tag}.csv`);
                }} style={sty.toolBtn} title="CSV 내보내기 (엑셀/분석)">
                  <Icon name="share" size={11} /> CSV
                </button>
                <button onClick={() => {
                  const range = selectedTripIdx != null && trips[selectedTripIdx]
                    ? (() => {
                        const t = trips[selectedTripIdx];
                        const since = t.points[0].recorded_at;
                        const until = t.points[t.points.length - 1].recorded_at;
                        return `&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`;
                      })()
                    : '';
                  const url = `${window.location.origin}/share/preview?device=${device?.id}&date=${date}${range}`;
                  navigator.clipboard?.writeText(url).then(
                    () => alert('운행 링크가 복사되었습니다 (수신자 로그인 필요).'),
                    () => prompt('링크 복사', url),
                  );
                }} style={sty.toolBtn} title="이 운행 링크 복사">
                  <Icon name="link" size={11} /> 링크
                </button>
              </div>
            )}

            {/* AI 분석 — 펼쳐접기 + 영구 이력 */}
            {points.length > 0 && (
              <div style={sty.aiCard}>
                <button onClick={() => setAiOpen(o => !o)} style={sty.aiHead}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Icon name="spark" size={13} style={{ color: 'var(--primary)' }} />
                    AI 운행 분석
                    {aiHistory.length > 0 && (
                      <span style={{
                        fontSize: 12, padding: '1px 6px', borderRadius: 8,
                        background: 'var(--surface)', color: 'var(--primary)',
                        border: '1px solid var(--primary)',
                      }}>{aiHistory.length}</span>
                    )}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                    {aiUsage
                      ? aiUsage.unlimited
                        ? '무제한'
                        : `회당 ${aiUsage.cost_per_analysis ?? 20} 포인트 · 잔액 ${(aiUsage.credit_balance ?? 0).toLocaleString()} 포인트`
                      : ''}
                  </span>
                </button>
                {aiOpen && (
                  <div style={{ padding: 10 }}>
                    {/* 이력 드롭다운 — 1건 이상이면 노출 */}
                    {aiHistory.length > 0 && (
                      <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
                        <select value={selectedAiId || ''}
                          onChange={e => setSelectedAiId(parseInt(e.target.value, 10))}
                          style={{ ...sty.smallSelect, flex: 1, padding: '6px 8px', fontSize: 12 }}>
                          {aiHistory.map(r => (
                            <option key={r.id} value={r.id}>
                              {new Date(r.created_at).toLocaleString('ko-KR', {
                  ...KST_TIME_OPTIONS,
                                month: 'numeric', day: 'numeric',
                                hour: '2-digit', minute: '2-digit',
                              })}{r.cost_credits > 0 ? ` (${r.cost_credits} 포인트)` : ' (무료)'}
                            </option>
                          ))}
                        </select>
                        {selectedAnalysis && (
                          <button onClick={() => handleDeleteAnalysis(selectedAnalysis.id)}
                            style={{
                              padding: '5px 8px', fontSize: 12,
                              background: 'transparent', color: 'var(--danger)',
                              border: '1px solid var(--danger)', borderRadius: 4, cursor: 'pointer',
                            }} title="이 분석 삭제">
                            <Icon name="trash2" size={11} />
                          </button>
                        )}
                      </div>
                    )}

                    {/* 본문 — 선택된 분석 또는 안내 */}
                    {aiText ? (
                      <>
                        <div style={sty.aiText}>{aiText}</div>
                        <div style={{
                          fontSize: 12, color: 'var(--text-3)', marginBottom: 6,
                          display: 'flex', justifyContent: 'space-between', gap: 6,
                        }}>
                          <span>{selectedAnalysis?.model || ''}</span>
                          <span>
                            {selectedAnalysis ? new Date(selectedAnalysis.created_at).toLocaleString('ko-KR') : ''}
                          </span>
                        </div>
                        <button onClick={handleAnalyze} disabled={aiBusy}
                          style={{ ...sty.btnSecondary, opacity: aiBusy ? 0.6 : 1 }}>
                          {aiBusy ? '분석 중...' : `새 분석 받기${aiUsage?.unlimited ? '' : ` (${aiUsage?.cost_per_analysis ?? 20} 포인트)`}`}
                        </button>
                      </>
                    ) : aiError ? (
                      <div>
                        <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 6 }}>{aiError}</div>
                        <button onClick={handleAnalyze} disabled={aiBusy} style={sty.btnPrimary}>다시 시도</button>
                      </div>
                    ) : (
                      <button onClick={handleAnalyze} disabled={aiBusy}
                        style={{ ...sty.btnPrimary, opacity: aiBusy ? 0.6 : 1 }}>
                        {aiBusy
                          ? '분석 중...'
                          : aiUsage?.unlimited
                            ? '이 날 운행 분석 받기'
                            : `이 날 운행 분석 받기 (${aiUsage?.cost_per_analysis ?? 20} 포인트)`}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* ──────────────── 월간 모드 ──────────────── */}
        {mode === 'month' && (
          <MonthOverview
            month={month}
            onMonthChange={setMonth}
            dailyStats={dailyStats}
            points={points}
            loading={loading}
            error={error}
            activeDates={activeDates}
            datesLoading={datesLoading}
            onDayClick={(ds) => {
              setDate(ds); setStartSlot('00:00'); setHours(24); setMode('day');
            }}
          />
        )}

        {/* 속도 색상 범례 */}
        {speedColor && points.length > 0 && (
          <div style={sty.legend}>
            <span style={{ fontSize: 12, color: 'var(--text-3)', marginRight: 4 }}>속도</span>
            <Legend color="#EF4444" label="정지/저속" />
            <Legend color="#F59E0B" label="<30" />
            <Legend color="#10B981" label="<60" />
            <Legend color="#3B82F6" label="<100" />
            <Legend color="#8B5CF6" label=">100" />
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>km/h</span>
          </div>
        )}
      </div>
    </section>
  );
}

// ─── 일간 — 날짜 트리거 + 달력 popover ────────────────────
function DateRow({ date, availDates, hasData, onChange, pending }) {
  const [open, setOpen] = useState(false);
  const today = todayKstStr();
  const isToday = date === today;
  return (
    <div style={{ position: 'relative', marginBottom: 8, display: 'flex', gap: 6 }}>
      <button onClick={() => setOpen(o => !o)} style={{ ...sty.dateBtn, flex: 1 }}>
        <Icon name="route" size={12} style={{ opacity: 0.5 }} />
        <span style={{ flex: 1, textAlign: 'left' }}>{date}</span>
        {!pending && !hasData && <span style={{ fontSize: 12, color: 'var(--warning)' }}>데이터 없음</span>}
        <Icon name={open ? 'close' : 'plus'} size={12} />
      </button>
      {!isToday && (
        <button onClick={() => onChange(today)} style={sty.todayBtn} title="오늘로">
          오늘
        </button>
      )}
      {open && (
        <DataCalendar value={date} availDates={availDates}
          onChange={(d) => { onChange(d); setOpen(false); }} />
      )}
    </div>
  );
}

// ─── 월간 — 헤더 + 히트맵 달력 + 요약 ─────────────────────
function MonthOverview({ month, onMonthChange, dailyStats, activeDates, datesLoading, points, loading, error, onDayClick }) {
  // month: "YYYY-MM"
  function shift(dir) {
    const [y, m] = month.split('-').map(Number);
    let ny = y, nm = m + dir;
    if (nm === 0)  { ny--; nm = 12; }
    if (nm === 13) { ny++; nm = 1;  }
    onMonthChange(`${ny}-${String(nm).padStart(2,'0')}`);
  }

  const inMonth = dailyStats.filter(s => s.date.startsWith(month));
  const totalKmMonth = inMonth.reduce((sum, s) => sum + (s.distance_m || 0), 0) / 1000;
  const totalDays    = inMonth.length;
  const totalMin     = inMonth.reduce((sum, s) => sum + (s.moving_s || 0), 0) / 60;

  // 히트맵 강도 — 그 달 최대 distance 기준
  const maxDistance = Math.max(...inMonth.map(s => s.distance_m || 0), 1);

  return (
    <>
      {/* 월 네비 */}
      <div style={sty.monthNav}>
        <button aria-label="이전 달" onClick={() => shift(-1)} style={sty.navBtn}>‹</button>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{month}</span>
        <button aria-label="다음 달" onClick={() => shift(+1)} style={sty.navBtn}>›</button>
      </div>

      {/* 요약 KPI */}
      {totalDays > 0 ? (
        <div style={sty.kpiGrid}>
          <Kpi label="활동일" value={`${totalDays}일`} />
          <Kpi label="이동거리" value={`${totalKmMonth.toFixed(1)} km`} />
          <Kpi label="운행시간" value={fmtDuration(totalMin * 60)} />
          <Kpi label="지도 점" value={`${points.length}`} />
        </div>
      ) : !loading && !error && !datesLoading && (
        <EmptyState msg={activeDates.some(d => d.startsWith(month)) ? '경로가 있습니다. 일별 통계 집계를 기다리는 중입니다.' : '이 달에 활동 기록이 없습니다'}
          actions={month !== thisMonthKstStr()
            ? [{ label: '이번 달로', onClick: () => onMonthChange(thisMonthKstStr()) }]
            : []}
        />
      )}

      {/* 히트맵 달력 (인라인, 항상 노출) */}
      <HeatCalendar month={month} dailyStats={inMonth} activeDates={activeDates}
        maxDistance={maxDistance} onDayClick={onDayClick} />

      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-2)' }}>
        날짜를 선택하면 해당 일자의 경로와 운행을 자세히 볼 수 있습니다.
      </div>
    </>
  );
}

// ─── 히트맵 달력 (월간 전용, 인라인) ───────────────────────
function HeatCalendar({ month, dailyStats, activeDates, maxDistance, onDayClick }) {
  const today = todayKstStr();
  const map = useMemo(() => {
    const m = new Map();
    dailyStats.forEach(s => m.set(s.date, s));
    return m;
  }, [dailyStats]);

  const [yyyy, mm] = month.split('-').map(Number);
  const firstDow = new Date(`${month}-01T00:00:00Z`).getUTCDay();
  const lastDate = new Date(yyyy, mm, 0).getDate();

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= lastDate; d++) cells.push(d);

  return (
    <div style={cal.heat}>
      <div style={cal.dowRow}>
        {['일','월','화','수','목','금','토'].map((d, i) => (
          <span key={i} style={{
            ...cal.dow,
            color: i === 0 ? 'var(--danger)' : i === 6 ? 'var(--primary)' : 'var(--text-3)',
          }}>{d}</span>
        ))}
      </div>
      <div style={cal.grid}>
        {cells.map((d, i) => {
          if (d === null) return <span key={i} />;
          const ds = `${month}-${String(d).padStart(2,'0')}`;
          const stat = map.get(ds);
          const has = !!stat || activeDates.includes(ds);
          const dist = stat?.distance_m || 0;
          const intensity = has ? Math.min(1, dist / maxDistance) : 0;
          const isToday = ds === today;
          return (
            <button key={i} aria-label={`${ds} 일간 경로`}
              disabled={!has}
              onClick={() => has && onDayClick(ds)}
              title={has
                ? stat ? `${ds} · ${(dist/1000).toFixed(1)}km · ${stat.stop_count || 0}정지` : `${ds} · 통계 집계 중`
                : `${ds} · 데이터 없음`}
              style={{
                ...cal.cell,
                cursor: has ? 'pointer' : 'default',
                opacity: has ? 1 : 0.2,
                background: has
                  ? intensity > 0.5 ? 'var(--primary)' : `color-mix(in srgb, var(--primary) ${15 + intensity * 65}%, var(--surface))`
                  : 'transparent',
                color: intensity > 0.5 ? 'var(--primary-fg)' : 'var(--text)',
                border: isToday ? '1.5px solid var(--primary)' : '1px solid transparent',
              }}>
              <span>{d}</span>
              {has && (
                <span style={{ fontSize: 8, opacity: 0.85, marginTop: 1 }}>
                  {stat ? dist >= 1000 ? `${(dist/1000).toFixed(0)}k` : `${Math.round(dist)}` : '·'}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>적음</span>
        {[0.15, 0.3, 0.5, 0.7, 0.9].map((a, i) => (
          <span key={i} style={{
            width: 14, height: 8, borderRadius: 2,
            background: `color-mix(in srgb, var(--primary) ${a * 100}%, var(--surface))`,
          }} />
        ))}
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>많음</span>
      </div>
    </div>
  );
}

// ─── 일간 — 데이터 있는 날만 클릭 가능한 mini 달력 (popover) ─
function DataCalendar({ value, availDates, onChange }) {
  const initialMonth = (value || todayKstStr()).slice(0, 7);
  const [view, setView] = useState(initialMonth);
  const today = todayKstStr();
  const haveSet = useMemo(() => new Set(availDates), [availDates]);

  const [yyyy, mm] = view.split('-').map(Number);
  const firstDow = new Date(`${view}-01T00:00:00+09:00`).getDay();
  const lastDate = new Date(yyyy, mm, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= lastDate; d++) cells.push(d);

  function shiftMonth(dir) {
    let y = yyyy, m = mm + dir;
    if (m === 0)  { y--; m = 12; }
    if (m === 13) { y++; m = 1; }
    setView(`${y}-${String(m).padStart(2,'0')}`);
  }
  return (
    <div style={cal.popover}>
      <div style={cal.nav}>
        <button onClick={() => shiftMonth(-1)} style={cal.navBtn}>‹</button>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{view}</span>
        <button onClick={() => shiftMonth(+1)} style={cal.navBtn}>›</button>
      </div>
      <div style={cal.dowRow}>
        {['일','월','화','수','목','금','토'].map((d, i) => (
          <span key={i} style={{
            ...cal.dow,
            color: i === 0 ? 'var(--danger)' : i === 6 ? 'var(--primary)' : 'var(--text-3)',
          }}>{d}</span>
        ))}
      </div>
      <div style={cal.grid}>
        {cells.map((d, i) => {
          if (d === null) return <span key={i} />;
          const ds = `${view}-${String(d).padStart(2,'0')}`;
          const has = haveSet.has(ds);
          const sel = ds === value;
          const isToday = ds === today;
          return (
            <button key={i} aria-label={`${ds} 일간 경로`}
              disabled={!has}
              onClick={() => has && onChange(ds)}
              title={has ? '' : '데이터 없음'}
              style={{
                ...cal.cell,
                cursor: has ? 'pointer' : 'not-allowed',
                opacity: has ? 1 : 0.25,
                background: sel ? 'var(--primary)' : (has ? 'var(--surface-2)' : 'transparent'),
                color:      sel ? 'var(--primary-fg)' : 'var(--text)',
                border:     isToday && !sel ? '1px solid var(--primary)' : '1px solid transparent',
                fontWeight: sel || isToday ? 600 : 400,
              }}>
              {d}
              {has && !sel && (
                <span style={{
                  position: 'absolute', bottom: 2, left: '50%', transform: 'translateX(-50%)',
                  width: 4, height: 4, borderRadius: 2, background: 'var(--primary)',
                }} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── 작은 sub-컴포넌트 ───────────────────────────────────
function Kpi({ label, value }) {
  return (
    <div style={sty.kpiCell}>
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

// 속도 sparkline — 시간 x축, 속도 y축의 mini SVG. cursor 위치 표시.
// 슬라이더 (정수 index) 와 달리 시간 균등 분포 → 운행 흐름 직관적.
// onSeek 가 있으면 클릭/드래그 시 가까운 시각의 idx 로 jump.
function SpeedSparkline({ points, cursorIdx, maxSpeed, onSeek }) {
  const W = 320, H = 36, PAD = 2;
  if (points.length < 2) return null;
  const t0 = new Date(points[0].recorded_at).getTime();
  const t1 = new Date(points[points.length - 1].recorded_at).getTime();
  const dur = Math.max(1, t1 - t0);
  const yMax = Math.max(20, maxSpeed || 0);
  const tx = (t) => PAD + ((t - t0) / dur) * (W - PAD * 2);
  const ty = (v) => H - PAD - ((v || 0) / yMax) * (H - PAD * 2);

  let d = '', connected = false;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const x = tx(new Date(p.recorded_at).getTime());
    if (!Number.isFinite(p._speed)) { connected = false; continue; }
    const y = ty(p._speed);
    d += (!connected ? `M${x.toFixed(1)},${y.toFixed(1)}` : ` L${x.toFixed(1)},${y.toFixed(1)}`);
    connected = true;
  }
  const cur = points[cursorIdx];
  const cx = cur ? tx(new Date(cur.recorded_at).getTime()) : null;

  // 클릭/터치 → 가까운 시각의 idx 로 jump
  function handlePointer(e) {
    if (!onSeek) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX || e.touches?.[0]?.clientX || 0) - rect.left;
    const ratio = Math.max(0, Math.min(1, (x / rect.width)));
    const targetT = t0 + ratio * dur;
    // binary search 가까운 점
    let lo = 0, hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const tm = new Date(points[mid].recorded_at).getTime();
      if (tm < targetT) lo = mid + 1; else hi = mid;
    }
    onSeek(lo);
  }

  return (
    <div style={{
      width: '100%', height: H, marginTop: 4,
      background: 'var(--surface-2)', border: '1px solid var(--border)',
      borderRadius: 6, overflow: 'hidden',
      cursor: onSeek ? 'pointer' : 'default',
      touchAction: 'none',
    }}
      onMouseDown={handlePointer}
      onTouchStart={handlePointer}>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" pointerEvents="none">
        <path d={`${d} L${(W - PAD).toFixed(1)},${(H - PAD).toFixed(1)} L${PAD},${(H - PAD).toFixed(1)} Z`}
          fill="var(--primary)" fillOpacity={0.18} stroke="none" />
        <path d={d} fill="none" stroke="var(--primary)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        {cx != null && (
          <line x1={cx} y1={0} x2={cx} y2={H} stroke="var(--accent)" strokeWidth={1.5} />
        )}
      </svg>
    </div>
  );
}
// 운행 비교 — 2개 trip 의 KPI side-by-side. 차이 표시.
function CompareKpis({ trips }) {
  const stats = trips.map(t => {
    const pts = t.points;
    const km = totalKm(pts);
    const start = new Date(pts[0].recorded_at);
    const end   = new Date(pts[pts.length - 1].recorded_at);
    const speeds = pts.map(p => p.speed_max_kmh ?? p._speed).filter(Number.isFinite);
    const max = speeds.length ? Math.max(...speeds) : null;
    const metrics = analyzePath(pts);
    const idle = metrics.stoppedS;
    const dur = metrics.movingS;
    const avg = dur > 0 ? km / (dur / 3600) : 0;
    return { km, durSec: dur, max, idle, avg, start, end, points: pts.length };
  });
  const fmt = (d) => d.toLocaleTimeString('ko-KR', { ...KST_TIME_OPTIONS, hour: '2-digit', minute: '2-digit', hour12: false });
  const Row = ({ label, a, b, fmtVal }) => {
    const aF = fmtVal(a), bF = fmtVal(b);
    let cmp = '';
    if (typeof a === 'number' && typeof b === 'number' && a !== b) {
      const diff = b - a;
      const sign = diff > 0 ? '+' : '';
      cmp = `${sign}${diff.toFixed(diff % 1 === 0 ? 0 : 1)}`;
    }
    return (
      <tr>
        <td style={cmpsty.lblCell}>{label}</td>
        <td style={cmpsty.valCell}>{aF}</td>
        <td style={cmpsty.valCell}>{bF}</td>
        <td style={{ ...cmpsty.diffCell, color: cmp.startsWith('+') ? 'var(--accent)' : cmp.startsWith('-') ? 'var(--danger)' : 'var(--text-3)' }}>
          {cmp}
        </td>
      </tr>
    );
  };
  return (
    <div style={cmpsty.wrap}>
      <table style={cmpsty.table}>
        <thead>
          <tr>
            <th style={cmpsty.thLbl}> </th>
            <th style={cmpsty.th}>A · {fmt(stats[0].start)}~{fmt(stats[0].end)}</th>
            <th style={cmpsty.th}>B · {fmt(stats[1].start)}~{fmt(stats[1].end)}</th>
            <th style={cmpsty.thDiff}>Δ</th>
          </tr>
        </thead>
        <tbody>
          <Row label="이동거리" a={stats[0].km} b={stats[1].km} fmtVal={v => `${v.toFixed(1)} km`} />
          <Row label="운행시간" a={Math.round(stats[0].durSec)} b={Math.round(stats[1].durSec)} fmtVal={v => fmtDuration(v)} />
          <Row label="평균속도" a={stats[0].avg} b={stats[1].avg} fmtVal={v => `${v.toFixed(0)} km/h`} />
          <Row label="최고속도" a={stats[0].max} b={stats[1].max} fmtVal={v => v == null ? '—' : `${v.toFixed(0)} km/h`} />
          <Row label="정차시간"  a={Math.round(stats[0].idle)} b={Math.round(stats[1].idle)} fmtVal={v => v > 0 ? fmtDuration(v) : '—'} />
          <Row label="점 수"   a={stats[0].points} b={stats[1].points} fmtVal={v => `${v}`} />
        </tbody>
      </table>
    </div>
  );
}
const cmpsty = {
  wrap: {
    background: 'var(--surface-2)', border: '1px solid var(--border)',
    borderRadius: 8, padding: 8, marginBottom: 10,
    overflowX: 'auto',
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  thLbl: { textAlign: 'left', padding: '4px 6px', color: 'var(--text-3)', fontWeight: 500, fontSize: 12 },
  th:    { textAlign: 'right', padding: '4px 6px', color: 'var(--primary)', fontWeight: 600, whiteSpace: 'nowrap' },
  thDiff:{ textAlign: 'right', padding: '4px 6px', color: 'var(--text-3)', fontSize: 12 },
  lblCell: { padding: '4px 6px', color: 'var(--text-2)', whiteSpace: 'nowrap' },
  valCell: { padding: '4px 6px', textAlign: 'right', color: 'var(--text)', fontWeight: 500, whiteSpace: 'nowrap' },
  diffCell: { padding: '4px 6px', textAlign: 'right', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' },
};

// 듀얼 thumb 시간 범위 슬라이더 — 10분 단위 (144 슬롯/일).
// 두 개의 native <input type=range> 를 겹쳐 dual-thumb 흉내. CSS 로 active 구간 색칠.
// availableSlots 가 있으면 데이터 있는 시각 점도 시각화 (작은 점).
function TimeRangeSlider({ startSlot, hours, availableSlots, onChange }) {
  const SLOTS = 144; // 24h * 6 (10분 단위)
  const [sh, sm] = startSlot.split(':').map(Number);
  const startIdx = Math.max(0, Math.min(SLOTS - 1, sh * 6 + Math.floor(sm / 10)));
  const endIdx   = Math.max(startIdx + 1, Math.min(SLOTS, startIdx + Math.round(hours * 6)));

  function fmt(idx) {
    const h = Math.floor(idx / 6);
    const m = (idx % 6) * 10;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }
  function setStart(newS) {
    const s = Math.max(0, Math.min(SLOTS - 1, newS));
    const e = Math.max(s + 1, endIdx);
    onChange(fmt(s), (e - s) / 6);
  }
  function setEnd(newE) {
    const e = Math.max(1, Math.min(SLOTS, newE));
    const s = Math.min(startIdx, e - 1);
    onChange(fmt(s), (e - s) / 6);
  }
  function preset(s, e) {
    onChange(fmt(s), (e - s) / 6);
  }

  const startPct = (startIdx / SLOTS) * 100;
  const endPct = (endIdx / SLOTS) * 100;
  const durMin = (endIdx - startIdx) * 10;
  const durH = Math.floor(durMin / 60);
  const durM = durMin % 60;
  const durLabel = durM === 0 ? `${durH}h` : durH === 0 ? `${durM}m` : `${durH}h ${durM}m`;

  // 데이터 있는 슬롯 시각화 — availableSlots ("HH:MM") 를 비율로 변환
  const dataDots = (availableSlots || []).map(s => {
    const [h, m] = s.split(':').map(Number);
    return ((h * 6 + m / 10) / SLOTS) * 100;
  });

  return (
    <div style={trsty.wrap}>
      {/* dual-thumb 트릭: input 자체는 pointer-events: none, thumb 만 auto */}
      <style>{`
        .trs-range { -webkit-appearance: none; appearance: none; pointer-events: none; }
        .trs-range:focus { outline: none; }
        .trs-range::-webkit-slider-runnable-track { background: transparent; height: 100%; }
        .trs-range::-moz-range-track { background: transparent; height: 100%; }
        .trs-range::-webkit-slider-thumb {
          -webkit-appearance: none; pointer-events: auto;
          width: 18px; height: 18px; border-radius: 50%;
          background: var(--primary); border: 2px solid var(--surface);
          box-shadow: 0 1px 3px rgba(0,0,0,0.3); cursor: grab;
        }
        .trs-range::-moz-range-thumb {
          pointer-events: auto;
          width: 18px; height: 18px; border-radius: 50%;
          background: var(--primary); border: 2px solid var(--surface);
          box-shadow: 0 1px 3px rgba(0,0,0,0.3); cursor: grab;
        }
      `}</style>
      <div style={trsty.label}>
        <span style={{ fontWeight: 600, color: 'var(--text)' }}>{fmt(startIdx)} ~ {fmt(endIdx)}</span>
        <span style={{ color: 'var(--text-3)', fontSize: 12 }}>{durLabel}</span>
      </div>
      <div style={trsty.sliderBox}>
        {/* 트랙 + active 구간 */}
        <div style={trsty.track} />
        <div style={{ ...trsty.activeTrack, left: `${startPct}%`, width: `${endPct - startPct}%` }} />
        {/* 데이터 점 */}
        {dataDots.map((p, i) => (
          <span key={i} style={{ ...trsty.dataDot, left: `calc(${p}% - 1px)` }} />
        ))}
        {/* 두 thumb */}
        <input aria-label="시작 시각 (한국 시간)" aria-valuetext={fmt(startIdx)} className="trs-range" type="range" min={0} max={SLOTS - 1} step={1} value={startIdx}
          onChange={e => setStart(Number(e.target.value))}
          style={{ ...trsty.range, zIndex: 2 }} />
        <input aria-label="종료 시각 (한국 시간)" aria-valuetext={fmt(endIdx)} className="trs-range" type="range" min={1} max={SLOTS} step={1} value={endIdx}
          onChange={e => setEnd(Number(e.target.value))}
          style={{ ...trsty.range, zIndex: 3 }} />
      </div>
      {/* 빠른 프리셋 */}
      <div style={trsty.presets}>
        <button onClick={() => preset(0, 144)} style={trsty.preset}>24시간</button>
        <button onClick={() => preset(36, 72)} style={trsty.preset}>오전 (06~12)</button>
        <button onClick={() => preset(72, 108)} style={trsty.preset}>오후 (12~18)</button>
        <button onClick={() => preset(108, 144)} style={trsty.preset}>저녁 (18~24)</button>
      </div>
    </div>
  );
}
const trsty = {
  wrap: { marginBottom: 10 },
  label: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    fontSize: 12, color: 'var(--text-2)', marginBottom: 6,
  },
  sliderBox: {
    position: 'relative', height: 28, padding: '10px 0',
  },
  track: {
    position: 'absolute', left: 0, right: 0, top: '50%',
    height: 4, marginTop: -2, borderRadius: 2,
    background: 'var(--surface-2)', border: '1px solid var(--border)',
  },
  activeTrack: {
    position: 'absolute', top: '50%',
    height: 4, marginTop: -2, borderRadius: 2,
    background: 'var(--primary)', opacity: 0.6,
    pointerEvents: 'none',
  },
  dataDot: {
    position: 'absolute', top: '50%',
    width: 2, height: 2, marginTop: -1,
    background: 'var(--accent)', borderRadius: 1,
    pointerEvents: 'none', opacity: 0.5,
  },
  range: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    width: '100%', height: '100%',
    background: 'transparent',
    margin: 0, padding: 0,
  },
  presets: {
    display: 'flex', gap: 4, marginTop: 6,
    overflowX: 'auto', WebkitOverflowScrolling: 'touch',
  },
  preset: {
    padding: '4px 8px', minHeight: 44,
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 12,
    fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
  },
};

function ChipToggle({ label, icon, on, onClick }) {
  return (
    <button onClick={onClick} aria-pressed={on} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '5px 10px', borderRadius: 14,
      border: `1px solid ${on ? 'var(--primary)' : 'var(--border)'}`,
      background: on ? 'var(--primary)' : 'transparent',
      color: on ? 'var(--primary-fg)' : 'var(--text-2)',
      fontSize: 12, fontWeight: 500, cursor: 'pointer',
      transition: 'all .12s',
    }}>
      <Icon name={icon} size={12} />
      {label}
    </button>
  );
}
function Legend({ color, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, color: 'var(--text-2)' }}>
      <span style={{ width: 10, height: 3, background: color, borderRadius: 2 }} />
      {label}
    </span>
  );
}
function EmptyState({ loading, error, msg, actions }) {
  if (loading) return <div style={sty.empty}>로딩...</div>;
  if (error)   return <div style={{ ...sty.empty, color: 'var(--danger)' }}>{error}</div>;
  return (
    <div style={sty.empty}>
      <div>{msg}</div>
      {actions && actions.length > 0 && (
        <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          {actions.map((a, i) => (
            <button key={i} onClick={a.onClick} style={sty.emptyAction}>{a.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// 스타일
// ════════════════════════════════════════════════════════════
const sty = {
  // 모바일/태블릿: 화면 하단 sheet
  bottom: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    maxHeight: 'min(78vh, 100%)',
    background: 'var(--surface)',
    borderTop: '1px solid var(--border)',
    borderRadius: mapSheet.surface.borderRadius,
    display: 'flex', flexDirection: 'column',
    boxShadow: mapSheet.surface.boxShadow,
    zIndex: 11,
    paddingBottom: 'env(safe-area-inset-bottom, 0)',
    animation: 'fadeInUp .18s ease-out',
  },
  // 데스크톱: 지도 영역의 좌하단 floating window — geofence 와 동시 오픈
  deskWindow: {
    position: 'absolute',
    left: 12, bottom: 12,
    width: 420, maxWidth: 'calc(100% - 24px)',
    maxHeight: 'calc(100% - 24px)',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    display: 'flex', flexDirection: 'column',
    boxShadow: '0 6px 24px rgba(0,0,0,.18)',
    zIndex: 11,
    animation: 'fadeInUp .18s ease-out',
  },
  header: { ...mapSheet.header, touchAction: 'none' },
  // 모바일 sheet 상단 끌기 인디케이터 — 사용자에게 swipe-down 가능 신호.
  dragHandle: {
    position: 'absolute',
    top: 6, left: '50%', transform: 'translateX(-50%)',
    width: 36, height: 4, borderRadius: 2,
    background: 'var(--text-3)', opacity: 0.35,
    pointerEvents: 'none',
  },
  closeBtn: mapSheet.close,
  tabs: {
    display: 'flex', flexShrink: 0,
    borderBottom: '1px solid var(--border)',
    background: 'var(--surface)',
  },
  tab: {
    flex: 1, padding: '10px 12px',
    background: 'transparent', color: 'var(--text-2)',
    border: 'none', borderBottom: '2px solid transparent',
    fontSize: 12, fontWeight: 500, cursor: 'pointer',
  },
  tabOn: {
    color: 'var(--primary)', borderBottomColor: 'var(--primary)', fontWeight: 600,
  },
  opts: {
    display: 'flex', gap: 6, padding: '8px 14px',
    flexShrink: 0,
    borderBottom: '1px solid var(--border)',
    background: 'var(--surface)',
    overflowX: 'auto', WebkitOverflowScrolling: 'touch', whiteSpace: 'nowrap',
  },
  body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 },

  // 재생 모드 (모바일) — 화면 하단 minimal 컨트롤만. 지도가 거의 다 보임.
  compact: {
    position: 'absolute', left: 8, right: 8, bottom: 8,
    background: 'var(--surface)',
    border: '1px solid var(--border)', borderRadius: 12,
    boxShadow: '0 -4px 20px rgba(0,0,0,0.18)',
    padding: 10,
    zIndex: 12,
    paddingBottom: 'calc(10px + env(safe-area-inset-bottom, 0))',
  },
  compactExpand: {
    position: 'absolute', top: -30, left: '50%', transform: 'translateX(-50%)',
    width: 48, height: 44, borderRadius: 14,
    background: 'var(--surface)', color: 'var(--text-2)',
    border: '1px solid var(--border)', cursor: 'pointer',
    fontSize: 14, fontWeight: 700,
    boxShadow: '0 2px 6px rgba(0,0,0,0.15)',
  },
  compactRow: {
    display: 'flex', alignItems: 'center', gap: 8, marginTop: 14,
  },
  dateBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 8,
    width: '100%', padding: '8px 10px',
    background: 'var(--surface-2)',
    border: '1px solid var(--border)', borderRadius: 6,
    color: 'var(--text)', fontSize: 12, cursor: 'pointer',
  },
  todayBtn: {
    padding: '0 12px', minHeight: 44,
    background: 'var(--surface-2)', color: 'var(--primary)',
    border: '1px solid var(--primary)', borderRadius: 6,
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
    flexShrink: 0,
  },
  windowRow: { display: 'flex', gap: 6, marginBottom: 10 },
  select: {
    flex: 1, padding: '7px 9px', fontSize: 12,
    background: 'var(--surface-2)',
    border: '1px solid var(--border)', borderRadius: 6,
    color: 'var(--text)',
  },
  smallSelect: {
    padding: 4, fontSize: 12,
    background: 'var(--surface-2)',
    border: '1px solid var(--border)', borderRadius: 4,
    color: 'var(--text)',
  },
  tripPills: {
    display: 'flex', gap: 6, marginBottom: 8,
    overflowX: 'auto', WebkitOverflowScrolling: 'touch',
    paddingBottom: 4,
  },
  tripPill: {
    padding: '7px 12px',
    background: 'var(--surface-2)', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 14,
    fontSize: 12, fontWeight: 500, cursor: 'pointer',
    whiteSpace: 'nowrap', flexShrink: 0,
    minHeight: 44,        // 모바일 터치 타겟 (≥32px)
  },
  tripPillOn: {
    background: 'var(--primary)', color: 'var(--primary-fg)',
    border: '1px solid var(--primary)', fontWeight: 600,
  },
  kpiGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6,
    marginBottom: 10,
  },
  kpiCell: {
    background: 'var(--surface-2)', borderRadius: 8, padding: '8px 10px',
    border: '1px solid var(--border)',
  },
  player: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 8, padding: 8,
    marginTop: 4,
  },
  playBtn: {
    width: 44, height: 44, borderRadius: 19, border: 'none',
    background: 'var(--primary)', color: 'var(--primary-fg)',
    fontSize: 14, cursor: 'pointer', flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  cursorInfo: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    fontSize: 12, color: 'var(--text-2)',
    padding: '6px 4px 0',
    gap: 8, flexWrap: 'wrap',
  },
  toolRow: {
    display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap',
  },
  toolBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '5px 10px', minHeight: 44,
    background: 'var(--surface-2)', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 6,
    fontSize: 12, fontWeight: 500, cursor: 'pointer',
  },
  monthNav: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '4px 6px', marginBottom: 10,
  },
  navBtn: {
    width: 44, height: 44, borderRadius: 8,
    background: 'var(--surface-2)', color: 'var(--text)',
    border: '1px solid var(--border)', cursor: 'pointer',
    fontSize: 18, lineHeight: 1,
  },
  empty: {
    color: 'var(--text-3)', fontSize: 12,
    padding: '20px 12px', textAlign: 'center',
    background: 'var(--surface-2)', borderRadius: 8,
    border: '1px dashed var(--border)',
    marginBottom: 10,
  },
  emptyAction: {
    padding: '6px 12px', minHeight: 44,
    background: 'transparent', color: 'var(--primary)',
    border: '1px solid var(--primary)', borderRadius: 6,
    fontSize: 12, fontWeight: 500, cursor: 'pointer',
  },
  legend: {
    display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
    marginTop: 10, padding: '8px 10px',
    background: 'var(--surface-2)', borderRadius: 6,
  },
  aiCard: {
    marginTop: 10,
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    overflow: 'hidden',
  },
  aiHead: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    width: '100%', padding: '10px 12px',
    background: 'transparent', color: 'var(--text)',
    border: 'none', cursor: 'pointer',
    fontSize: 12, fontWeight: 500,
  },
  aiText: {
    fontSize: 12, lineHeight: 1.65,
    color: 'var(--text)',
    background: 'var(--surface)',
    padding: 10, borderRadius: 6,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    maxHeight: 220, overflowY: 'auto',
    marginBottom: 6,
  },
  btnPrimary: {
    width: '100%', padding: 9,
    background: 'var(--primary)', color: 'var(--primary-fg)',
    border: 'none', borderRadius: 6, cursor: 'pointer',
    fontSize: 12, fontWeight: 600,
  },
  btnSecondary: {
    width: '100%', padding: 9,
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
    fontSize: 12,
  },
};

const cal = {
  popover: {
    position: 'absolute', top: '100%', left: 0, right: 0,
    marginTop: 4, padding: 10,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    boxShadow: '0 6px 20px rgba(0,0,0,.18)',
    zIndex: 200,
  },
  heat: {
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 8, padding: 10,
    marginTop: 4,
  },
  nav: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 8,
  },
  navBtn: {
    width: 44, height: 44, borderRadius: 6,
    background: 'var(--surface-2)', color: 'var(--text)',
    border: '1px solid var(--border)', cursor: 'pointer',
    fontSize: 16, lineHeight: 1,
  },
  dowRow: {
    display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)',
    marginBottom: 4,
  },
  dow: {
    fontSize: 12, fontWeight: 600, textAlign: 'center', padding: 2,
  },
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 3,
  },
  cell: {
    position: 'relative',
    aspectRatio: '1', minHeight: 44,
    fontSize: 12,
    background: 'transparent',
    color: 'var(--text)',
    border: '1px solid transparent',
    borderRadius: 6,
    padding: 0,
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
  },
};

// ─── 사이클 seeker (연구소 토글) ─────────────────────────
// device 의 lifecycle events 를 wake → sleep_enter 묶음 (cycle) 으로 grouping.
// 사이클별 [보기] = seeker 를 그 시간대로 이동. [삭제] = 해당 사이클의 events + location_records 영구 삭제.
