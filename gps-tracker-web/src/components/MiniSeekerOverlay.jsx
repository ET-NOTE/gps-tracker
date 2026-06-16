// 컴팩트 시커 — 좌하단 floating 패널 + 하단 시간 슬롯 strip.
//
// 월 / 일 / 시간 3-phase wizard:
//   · phase 1 (monthPicked=false): 월 리스트 — 클릭 시 그 월의 마지막 활동일로 자동 점프.
//                                    지도엔 그 달 전체 데이터가 sample (저밀도) 로 표시.
//   · phase 2 (monthPicked=true): 그 월의 일 리스트 + 좌상단 ← 뒤로 버튼. 지도엔 day 데이터 (고밀도).
//   · phase 3 (date 선택 + 슬롯 있음): 하단 strip 으로 10분 단위 시간 선택 → 핀 + panToCoord.
//
// 지도 마커 클릭은 외부 (Dashboard onPointInfo) 에서 selectByTime 으로 dispatch:
//   · monthPicked=false → drill-down: 그 점의 KST 날짜로 phase 2 진입 + day 로드 후 시간 sync.
//   · monthPicked=true  → 가장 가까운 10분 슬롯 sync (skipPin 옵션 사용 시 핀은 외부가 처리).
//
// 데이터/맵 작업은 prop 위임:
//   - loadDates:        () => Promise<string[]>            (YYYY-MM-DD desc — phase 1/2 메뉴 구성)
//   - loadDayPoints:    (date) => Promise<Array<point>>    (phase 2: day 그릴 데이터)
//   - loadMonthPoints:  (month "YYYY-MM") => Promise<...>  (phase 1: 월 그릴 데이터, 선택적)
//   - onPathChange:     (points, opts?) => void            (opts.dense=true 는 day, false 는 month)
//   - onPathClear:      () => void
//   - onSlotSelect:     (point) => void
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import Icon from './Icon';

export const MINI_SEEKER_BOTTOM_HEIGHT = 56;

const SLOT_BUCKET_MIN = 10;
const KST_OFFSET_MS   = 9 * 3600 * 1000;

function fmtMonthDay(isoDate) { return isoDate.slice(5).replace('-', '.'); }
function fmtMonth(monthStr)   { return monthStr.slice(2); }   // "26-05"
function bucketKey(isoUtc) {
  const t = new Date(isoUtc).getTime() + KST_OFFSET_MS;
  const d = new Date(t);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const m  = Math.floor(d.getUTCMinutes() / SLOT_BUCKET_MIN) * SLOT_BUCKET_MIN;
  const mm = String(m).padStart(2, '0');
  return `${hh}:${mm}`;
}

function MiniSeekerOverlay({
  loadDates,
  loadDayPoints,
  loadMonthPoints,
  onPathChange,
  onPathClear,
  onSlotSelect,
}, ref) {
  const [dates, setDates] = useState([]);
  const [month, setMonth] = useState(null);
  const [monthPicked, setMonthPicked] = useState(false);
  const [date,  setDate]  = useState(null);
  const [slots, setSlots] = useState([]);
  const [slotIdx, setSlotIdx] = useState(null);
  // 외부 marker click 으로 phase 2 진입 시, day 데이터 로드 후 시간 sync 대기.
  const pendingTimeRef = useRef(null);
  const slotsRef = useRef([]);
  useEffect(() => { slotsRef.current = slots; }, [slots]);

  // 메뉴 데이터 — 월 / 그 월의 일 리스트
  const months = useMemo(() => {
    const set = new Set(dates.map(d => d.slice(0, 7)));
    return Array.from(set).sort().reverse();
  }, [dates]);
  const daysInMonth = useMemo(() => {
    if (!month) return [];
    return dates.filter(d => d.startsWith(month));
  }, [dates, month]);

  // phase 1 (month 뷰) — 명시적으로 호출하는 함수.
  // selectMonth (월 다시 클릭 포함) / goBackToMonths / 초기 진입 양쪽에서 직접 호출 →
  // useEffect 의존성으로 인한 same-value 재실행 누락 회피.
  // 진행 중인 fetch 는 idRef 로 무효화 (race 방지). useCallback 으로 stable deps.
  // ── 주의 ── 아래의 loadDates useEffect 가 이 함수를 참조하므로 반드시 선행 선언.
  const monthFetchIdRef = useRef(0);
  const loadAndDrawMonth = useCallback((m) => {
    if (!loadMonthPoints || !m) return;
    const myId = ++monthFetchIdRef.current;
    Promise.resolve(loadMonthPoints(m))
      .then(pts => {
        if (myId !== monthFetchIdRef.current) return;
        const list = pts || [];
        if (list.length === 0) { onPathClear?.(); return; }
        onPathChange?.(list, { dense: false });
      })
      .catch(() => {});
  }, [loadMonthPoints, onPathChange, onPathClear]);

  // 1) 날짜 리스트 로드 — 가장 최근 '월' 만 자동 선택 (phase 1 = month picker 로 시작).
  // 일/시간 자동 선택 X. 사용자가 화살표 또는 마커 클릭으로 phase 2 진입.
  // 초기 진입 시 가장 최근 월의 전체 데이터를 지도에 자동 표시.
  const initDoneRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve(loadDates?.())
      .then(ds => {
        if (cancelled) return;
        const list = ds || [];
        setDates(list);
        if (list.length > 0 && !initDoneRef.current) {
          initDoneRef.current = true;
          const latestMonth = list[0].slice(0, 7);
          setMonth(latestMonth);
          loadAndDrawMonth(latestMonth);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [loadDates, loadAndDrawMonth]);

  // 2-b) phase 2 (day 뷰) → day 데이터 + 슬롯 버킷
  useEffect(() => {
    if (!monthPicked || !date) return;
    let cancelled = false;
    Promise.resolve(loadDayPoints?.(date))
      .then(pts => {
        if (cancelled) return;
        const list = pts || [];
        const buckets = new Map();
        for (const p of list) {
          const k = bucketKey(p.recorded_at);
          if (!buckets.has(k)) buckets.set(k, p);
        }
        const arr = Array.from(buckets.entries()).map(([time, point]) => ({ time, point }));
        setSlots(arr);
        setSlotIdx(null);
        if (list.length > 0) onPathChange?.(list, { dense: true });
        else onPathClear?.();

        // 외부 drill-down 으로 진입한 경우 시간 sync
        const pending = pendingTimeRef.current;
        pendingTimeRef.current = null;
        if (pending != null && arr.length > 0) {
          let bestI = 0, bestDiff = Infinity;
          for (let i = 0; i < arr.length; i++) {
            const st = new Date(arr[i].point.recorded_at).getTime();
            const d = Math.abs(st - pending);
            if (d < bestDiff) { bestDiff = d; bestI = i; }
          }
          setSlotIdx(bestI);
          requestAnimationFrame(() => {
            document.querySelector(`[data-mini-slot="${bestI}"]`)
              ?.scrollIntoView?.({ behavior: 'smooth', inline: 'center', block: 'nearest' });
          });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [monthPicked, date, loadDayPoints, onPathChange, onPathClear]);

  // 언마운트 시 path 정리
  useEffect(() => {
    return () => onPathClear?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 외부 (Dashboard onPointInfo) — 마커 클릭 sync ──────────
  useImperativeHandle(ref, () => ({
    selectByTime(isoUtc, opts = {}) {
      const ts = new Date(isoUtc).getTime();
      if (!monthPicked) {
        // phase 1 → drill-down: 그 점의 KST 날짜로 phase 2 진입.
        // 데이터 로드 후 시간 sync 는 pendingTimeRef + useEffect 가 처리.
        const ds = new Date(ts + KST_OFFSET_MS).toISOString().slice(0, 10);
        pendingTimeRef.current = ts;
        const newMonth = ds.slice(0, 7);
        if (month !== newMonth) setMonth(newMonth);
        setMonthPicked(true);
        setDate(ds);
      } else {
        // phase 2 → 시간만 sync (핀은 외부 처리 옵션)
        const arr = slotsRef.current;
        if (!arr.length) return;
        let bestI = 0, bestDiff = Infinity;
        for (let i = 0; i < arr.length; i++) {
          const st = new Date(arr[i].point.recorded_at).getTime();
          const d = Math.abs(st - ts);
          if (d < bestDiff) { bestDiff = d; bestI = i; }
        }
        setSlotIdx(bestI);
        if (!opts.skipPin) onSlotSelect?.(arr[bestI].point);
        requestAnimationFrame(() => {
          document.querySelector(`[data-mini-slot="${bestI}"]`)
            ?.scrollIntoView?.({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        });
      }
    },
  }), [monthPicked, month, onSlotSelect]);

  // ── 액션 ────────────────────────────────────────────────
  // 월 텍스트 클릭 — phase 1 에 머문 채 그 달 전체 포인터를 지도에 (일별 대표 점).
  // same-value 재클릭 시에도 무조건 재호출 → 핀/카메라 reset.
  function selectMonth(m) {
    if (m !== month) setMonth(m);
    loadAndDrawMonth(m);
  }
  // 화살표 클릭 — phase 2 진입 (그 달의 일별 보기). 마지막 활동일 자동 선택.
  function drillIntoMonth(m) {
    if (m !== month) setMonth(m);
    setMonthPicked(true);
    const days = dates.filter(d => d.startsWith(m));
    if (days.length > 0) setDate(days[0]);
    else setDate(null);
  }
  function selectDay(d) {
    setDate(d);
  }
  function goBackToMonths() {
    setMonthPicked(false);
    setDate(null);
    setSlots([]);
    setSlotIdx(null);
    // 월 데이터 명시적으로 재로드 (이전에 그려진 day path 위에 덮어쓰기)
    if (month) loadAndDrawMonth(month);
  }
  function selectSlot(i) {
    setSlotIdx(i);
    const s = slots[i];
    if (s) onSlotSelect?.(s.point);
  }
  function onSlotsWheel(e) {
    if (e.deltaY === 0) return;
    e.currentTarget.scrollLeft += e.deltaY;
    e.preventDefault();
  }

  return (
    <>
      {/* 좌하단 floating 패널 — 단일 컬럼 wizard. key 로 phase 전환 시 fade-swap. */}
      <div style={st.panel}>
        <div key={monthPicked ? 'day' : 'month'} className="fade-swap" style={st.phaseWrap}>
          {!monthPicked ? (
            <>
              <div style={st.panelLabel}>월</div>
              <div style={st.scroll}>
                {months.length === 0 ? (
                  <div style={st.empty}>—</div>
                ) : months.map(m => {
                  const selected = m === month;
                  return (
                    <div key={m}
                      className="fade-color"
                      style={{ ...st.monthRow, ...(selected ? st.monthRowOn : null) }}>
                      <button onClick={() => selectMonth(m)}
                        className="btn-bounce"
                        style={st.monthRowText}
                        title="이 달 전체 보기">
                        {fmtMonth(m)}
                      </button>
                      <button onClick={() => drillIntoMonth(m)}
                        className="btn-bounce"
                        style={{
                          ...st.monthRowDrill,
                          borderLeftColor: selected ? 'rgba(255,255,255,0.3)' : 'var(--border)',
                        }}
                        title="이 달의 일별 보기">
                        <Icon name="chevron-right" size={10} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <button onClick={goBackToMonths}
                className="btn-bounce btn-hover-bg"
                style={st.backBtn} title="월 다시 고르기">
                <Icon name="chevron-left" size={14} />
                <span>{month ? fmtMonth(month) : '월'}</span>
              </button>
              <div style={st.scroll}>
                {daysInMonth.length === 0 ? (
                  <div style={st.empty}>기록 없음</div>
                ) : daysInMonth.map(d => (
                  <button key={d} onClick={() => selectDay(d)}
                    className="btn-bounce fade-color"
                    style={{ ...st.itemBtn, ...(d === date ? st.itemBtnOn : null) }}>
                    {fmtMonthDay(d)}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 하단 시간 strip — phase 2 + 슬롯 있을 때만 */}
      {monthPicked && (
        <div style={st.bottomStrip}>
          <div className="smooth-scroll-x" style={st.slotsScroll} onWheel={onSlotsWheel}>
            {slots.length === 0 ? (
              <div style={st.slotsEmpty}>
                {date ? '이 날에 기록이 없습니다' : '날짜를 고르세요'}
              </div>
            ) : slots.map((s, i) => (
              <button key={s.time + i} data-mini-slot={i}
                onClick={() => selectSlot(i)}
                className="btn-bounce fade-color"
                style={{ ...st.slotBtn, ...(i === slotIdx ? st.slotBtnOn : null) }}>
                {s.time}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export default forwardRef(MiniSeekerOverlay);

const st = {
  panel: {
    position: 'absolute',
    left: 8,
    // phase 1 일 땐 시간 strip 없으므로 bottom: 8. phase 2 일 땐 bottom: strip 위.
    // 정적 처리: 항상 strip 높이만큼 위에 두고, phase 1 에서 strip 미렌더로 시각적 충돌 없음.
    bottom: `calc(${MINI_SEEKER_BOTTOM_HEIGHT}px + 8px)`,
    width: 100,
    maxHeight: 240,
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
    fontSize: 10, fontWeight: 700,
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
    padding: '6px 6px',
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
    width: 22,
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
    padding: '7px 14px',
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
