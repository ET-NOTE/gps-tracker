// Compact explorer: month overview -> day path -> ten-minute navigation.
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import { bucket10min, kstDate } from '../lib/seeker';

export const MINI_SEEKER_BOTTOM_HEIGHT = 56;
export const MINI_SEEKER_PANEL_WIDTH = 128;
const EMPTY = [];
const fmtMonthDay = date => date.slice(5).replace('-', '.');
const fmtMonth = month => month.slice(2);

function MiniSeekerOverlay({ loadDates, loadDayPoints, loadMonthPoints, onPathChange, onPathClear, onSlotSelect }, ref) {
  const [dates, setDates] = useState([]);
  const [datesStatus, setDatesStatus] = useState({ loading: true, error: null });
  const [datesRetry, setDatesRetry] = useState(0);
  const [month, setMonth] = useState(null);
  const [monthPicked, setMonthPicked] = useState(false);
  const [date, setDate] = useState(null);
  const [slotIdx, setSlotIdx] = useState(null);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState(null);
  const pendingTimeRef = useRef(null);
  const slotsScrollRef = useRef(null);
  const key = `${monthPicked ? date : month}:${monthPicked}:${retry}`;
  const current = result?.key === key ? result : null;
  const slots = current?.slots || EMPTY;
  const loading = datesStatus.loading || (!!(monthPicked ? date : month) && (!current || current.loading));
  const error = datesStatus.error || current?.error;
  const months = useMemo(() => [...new Set(dates.map(d => d.slice(0, 7)))].sort().reverse(), [dates]);
  const daysInMonth = useMemo(() => dates.filter(d => d.startsWith(month || '?')), [dates, month]);

  useEffect(() => {
    const controller = new AbortController();
    setDatesStatus({ loading: true, error: null });
    Promise.resolve(loadDates?.({ signal: controller.signal })).then(rows => {
      if (controller.signal.aborted) return;
      const list = [...new Set(rows || [])].sort().reverse();
      setDates(list);
      setDatesStatus({ loading: false, error: null });
      if (list.length) setMonth(m => m || list[0].slice(0, 7));
    }).catch(e => {
      if (!controller.signal.aborted) setDatesStatus({ loading: false, error: e.message || '날짜를 불러오지 못했습니다.' });
    });
    return () => controller.abort();
  }, [loadDates, datesRetry]);

  useEffect(() => {
    const period = monthPicked ? date : month;
    if (!period) return;
    const controller = new AbortController();
    setResult({ key, loading: true, slots: EMPTY });
    setSlotIdx(null);
    onPathClear?.();
    const load = monthPicked ? loadDayPoints : loadMonthPoints;
    Promise.resolve(load?.(period, { signal: controller.signal,
      onProgress: n => { if (!controller.signal.aborted) setResult({ key, loading: true, slots: EMPTY, progress: n }); },
    })).then(rows => {
      if (controller.signal.aborted) return;
      const list = (rows || []).slice().sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at));
      const buckets = new Map();
      if (monthPicked) for (const p of list) {
        const time = bucket10min(p.recorded_at);
        if (!buckets.has(time)) buckets.set(time, p);
      }
      const arr = [...buckets].map(([time, point]) => ({ time, point }));
      setResult({ key, loading: false, slots: arr, count: list.length });
      if (list.length) onPathChange?.(list, { dense: monthPicked });
      const pending = pendingTimeRef.current;
      pendingTimeRef.current = null;
      if (pending != null && arr.length) {
        const i = nearestSlot(arr, pending);
        setSlotIdx(i);
        // Use the loaded day's own point; a month summary can be minutes away.
        onSlotSelect?.(arr[i].point);
      }
    }).catch(e => {
      if (!controller.signal.aborted) setResult({ key, loading: false, slots: EMPTY, error: e.message || '경로를 불러오지 못했습니다.' });
    });
    return () => controller.abort();
  }, [key, monthPicked, month, date, loadDayPoints, loadMonthPoints, onPathChange, onPathClear, onSlotSelect]);

  useEffect(() => () => onPathClear?.(), [onPathClear]);
  useEffect(() => {
    if (slotIdx == null) return;
    slotsScrollRef.current?.querySelector(`[data-mini-slot="${slotIdx}"]`)?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [slotIdx, slots]);
  // React's wheel listeners are passive; use an owned listener only when the strip can scroll.
  useEffect(() => {
    const el = slotsScrollRef.current;
    if (!el) return;
    const wheel = e => {
      if (!e.deltaY || e.deltaX || el.scrollWidth <= el.clientWidth) return;
      const before = el.scrollLeft;
      el.scrollLeft += e.deltaY;
      if (el.scrollLeft !== before) e.preventDefault();
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [monthPicked]);

  useImperativeHandle(ref, () => ({
    selectByTime(isoUtc, opts = {}) {
      const ts = Date.parse(isoUtc);
      if (!Number.isFinite(ts)) return;
      const ds = kstDate(ts);
      if (!monthPicked || date !== ds) {
        pendingTimeRef.current = ts;
        setMonth(ds.slice(0, 7)); setMonthPicked(true); setDate(ds);
      } else if (slots.length) {
        const i = nearestSlot(slots, ts);
        setSlotIdx(i);
        if (!opts.skipPin) onSlotSelect?.(slots[i].point);
      }
    },
  }), [monthPicked, date, slots, onSlotSelect]);

  function selectMonth(m) { setMonth(m); setRetry(v => v + 1); }
  function drillIntoMonth(m) {
    pendingTimeRef.current = null; setMonth(m); setMonthPicked(true);
    setDate(dates.find(d => d.startsWith(m)) || null);
  }
  function selectDay(d) { pendingTimeRef.current = null; setDate(d); setRetry(v => v + 1); }
  function goBackToMonths() { pendingTimeRef.current = null; setMonthPicked(false); setDate(null); }
  function selectSlot(i) { setSlotIdx(i); if (slots[i]) onSlotSelect?.(slots[i].point); }
  const loadingText = datesStatus.loading ? '날짜 불러오는 중…'
    : current?.progress ? `${current.progress.toLocaleString()}개 좌표 확인 중…`
    : `${monthPicked ? '일간' : '월간'} 경로 불러오는 중…`;

  return <>
    <section aria-label="컴팩트 시커" aria-busy={loading} style={st.panel}>
      {loading && <div role="status" style={st.empty}>{loadingText}</div>}
      {error && <div role="alert" style={st.empty}>
        <div>{error}</div>
        <button style={st.itemBtn} onClick={() => datesStatus.error ? setDatesRetry(v => v + 1) : setRetry(v => v + 1)}>다시 시도</button>
      </div>}
      <div key={monthPicked ? 'day' : 'month'} className="fade-swap" style={st.phaseWrap}>
        {!monthPicked ? <>
          <div style={st.panelLabel}>월 · 5분 요약</div>
          <div style={st.scroll}>
            {!loading && !error && months.length === 0 && <div style={st.empty}>활동 기록 없음</div>}
            {months.map(m => <div key={m} style={{ ...st.monthRow, ...(m === month ? st.monthRowOn : null) }}>
              <button aria-label={`${m} 월간 경로`} aria-pressed={m === month} onClick={() => selectMonth(m)} style={st.monthRowText}>{fmtMonth(m)}</button>
              <button aria-label={`${m} 일별 기록 열기`} onClick={() => drillIntoMonth(m)} style={st.monthRowDrill} title="일별 기록 열기"><Icon name="chevron-right" size={14} /></button>
            </div>)}
            {!loading && !error && month && current?.count === 0 && <div style={st.empty}>월 경로 없음</div>}
          </div>
        </> : <>
          <button onClick={goBackToMonths} style={st.backBtn} aria-label="월 목록으로 돌아가기"><Icon name="chevron-left" size={14} /><span>{month ? fmtMonth(month) : '월'}</span></button>
          <div style={st.panelLabel}>일간 원본 · KST</div>
          <div style={st.scroll}>
            {daysInMonth.map(d => <button key={d} onClick={() => selectDay(d)} aria-label={`${d} 일간 경로`} aria-pressed={d === date}
              style={{ ...st.itemBtn, ...(d === date ? st.itemBtnOn : null) }}>{fmtMonthDay(d)}</button>)}
          </div>
        </>}
      </div>
    </section>
    {monthPicked && <div style={st.bottomStrip}>
      <div ref={slotsScrollRef} className="smooth-scroll-x" aria-label="10분 간격 위치 선택" style={st.slotsScroll}>
        {slots.length === 0 ? <div style={st.slotsEmpty}>
          {loading ? loadingText : error ? '경로를 불러오지 못했습니다' : date ? '이 날에 기록이 없습니다' : '날짜를 고르세요'}
        </div> : slots.map((s, i) => <button key={s.time} data-mini-slot={i} onClick={() => selectSlot(i)}
          aria-label={`${s.time} 위치 (한국 시간)`} aria-pressed={i === slotIdx}
          style={{ ...st.slotBtn, ...(i === slotIdx ? st.slotBtnOn : null) }}>{s.time}</button>)}
      </div>
    </div>}
  </>;
}
function nearestSlot(slots, ts) {
  let best = 0;
  for (let i = 1; i < slots.length; i++) if (Math.abs(Date.parse(slots[i].point.recorded_at) - ts) < Math.abs(Date.parse(slots[best].point.recorded_at) - ts)) best = i;
  return best;
}
export default forwardRef(MiniSeekerOverlay);

const st = {
  panel: {
    position: 'absolute',
    left: 8,
    // phase 1 일 땐 시간 strip 없으므로 bottom: 8. phase 2 일 땐 bottom: strip 위.
    // 정적 처리: 항상 strip 높이만큼 위에 두고, phase 1 에서 strip 미렌더로 시각적 충돌 없음.
    bottom: `calc(${MINI_SEEKER_BOTTOM_HEIGHT}px + 8px)`,
    width: MINI_SEEKER_PANEL_WIDTH,
    maxHeight: 300,
    display: 'flex', flexDirection: 'column',
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    overflow: 'hidden',
    boxShadow: '0 4px 12px rgba(0,0,0,.18)',
    zIndex: 11,
    pointerEvents: 'auto',
    animation: 'fadeInUp .18s ease-out',
  },
  // wizard phase 별 wrapper — key 변경으로 fadeSwap 애니메이션 트리거.
  phaseWrap: {
    flex: 1, minHeight: 0,
    display: 'flex', flexDirection: 'column',
  },
  panelLabel: {
    flexShrink: 0,
    padding: '5px 8px',
    fontSize: 11, fontWeight: 700,
    color: 'var(--text-3)',
    background: 'var(--surface)',
    borderBottom: '1px solid var(--border)',
    textAlign: 'center',
    letterSpacing: '.05em',
  },
  backBtn: {
    flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
    width: '100%', padding: '6px 8px',
    background: 'var(--surface)', color: 'var(--text-2)',
    border: 'none', borderBottom: '1px solid var(--border)',
    // 월 / 일 item (fontSize 12, fontWeight 600) 과 톤 맞춤 — 시각적 정렬.
    fontSize: 12, fontWeight: 600,
    cursor: 'pointer',
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1,
    minHeight: 30,
  },
  scroll: {
    flex: 1, minHeight: 0,
    overflowY: 'auto',
    display: 'flex', flexDirection: 'column', gap: 4,
    padding: 6,
    scrollbarWidth: 'thin',
  },
  empty: {
    fontSize: 11, color: 'var(--text-3)',
    textAlign: 'center', padding: 6,
  },
  itemBtn: {
    flexShrink: 0,
    padding: '8px 6px', minHeight: 40,
    background: 'var(--surface)',
    color: 'var(--text-2)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    fontSize: 12, fontWeight: 600,
    cursor: 'pointer',
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'center',
  },
  itemBtnOn: {
    background: 'var(--primary)',
    color: 'var(--primary-fg, white)',
    borderColor: 'var(--primary)',
  },
  // ── 월 item: 두 영역 split — 텍스트 (월 전체 보기) + 화살표 (일별 진입) ──
  // 컨테이너 폭 100 안에서 동작. 텍스트 ~56px + 1px divider + 화살표 ~24px = 81px (+ 6 padding 좌우).
  monthRow: {
    flexShrink: 0,
    display: 'flex',
    background: 'var(--surface)',
    color: 'var(--text-2)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    overflow: 'hidden',
  },
  monthRowOn: {
    background: 'var(--primary)',
    color: 'var(--primary-fg, white)',
    borderColor: 'var(--primary)',
  },
  monthRowText: {
    flex: 1, minWidth: 0,
    padding: '6px 4px',
    background: 'transparent', color: 'inherit',
    border: 'none', cursor: 'pointer',
    fontSize: 12, fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'center',
  },
  monthRowDrill: {
    flexShrink: 0,
    width: 40, minHeight: 40,
    padding: 0,
    background: 'transparent', color: 'inherit',
    border: 'none',
    borderLeft: '1px solid var(--border)',   // 동적 색은 inline 으로 덮어씀
    cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  bottomStrip: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    height: MINI_SEEKER_BOTTOM_HEIGHT,
    background: 'var(--surface)',
    borderTop: '1px solid var(--border)',
    boxShadow: '0 -4px 12px rgba(0,0,0,.18)',
    zIndex: 11,
    display: 'flex', alignItems: 'center',
    padding: '0 8px',
    animation: 'fadeInUp .18s ease-out',
  },
  slotsScroll: {
    flex: 1, minWidth: 0,
    display: 'flex', alignItems: 'center', gap: 6,
    overflowX: 'auto',
    scrollbarWidth: 'thin',
    height: '100%',
  },
  slotsEmpty: {
    fontSize: 11, color: 'var(--text-3)',
    padding: '0 8px',
    alignSelf: 'center',
  },
  slotBtn: {
    flexShrink: 0,
    padding: '8px 14px', minHeight: 40,
    background: 'var(--surface-2)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 16,
    fontSize: 12, fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
  },
  slotBtnOn: {
    background: 'var(--primary)',
    color: 'var(--primary-fg, white)',
    borderColor: 'var(--primary)',
  },
};
