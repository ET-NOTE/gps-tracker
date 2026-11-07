import { useEffect, useState } from 'react';
import { api } from '../api';
import { confirmDialog, alertDialog } from './Dialog';
import { dayWindow, kstDate, KST_TIME_OPTIONS } from '../lib/seeker';
export default function CycleListSection({ deviceId, color, onSeek }) {
  const [cycles, setCycles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    if (!deviceId) return;
    setLoading(true);
    try {
      // 최근 7일 + 최대 1000 events (긴 진단 세션도 cover).
      const since = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
      const evs = await api.getDeviceEvents(deviceId, { since, limit: 1000 });
      setCycles(groupCycles(evs || []));
      setError(null);
    } catch (e) {
      setError(e?.message || 'events load failed');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { refresh(); }, [deviceId]);

  async function handleDelete(c) {
    const ok = await confirmDialog({
      title: '사이클 삭제',
      body: `${new Date(c.start).toLocaleString('ko-KR', KST_TIME_OPTIONS)} 부터 ${new Date(c.end).toLocaleString('ko-KR', KST_TIME_OPTIONS)} 까지의 events + 좌표 모두 영구 삭제. 되돌릴 수 없음.`,
      confirmText: '삭제',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.deleteDeviceRange(deviceId, c.start, c.end);
      await refresh();
      alertDialog({ title: '삭제 완료', body: `좌표 ${r.deleted_locations}개 · 이벤트 ${r.deleted_events}개 삭제됨.` });
    } catch (e) {
      alertDialog({ title: '삭제 실패', body: e?.message || '알 수 없는 오류' });
    } finally {
      setBusy(false);
    }
  }

  // 오늘 전체 삭제 — wake/sleep_enter 이벤트 없이 계속 fix 만 도착하는 상황
  // (07/08 aa 사례처럼 사이클 grouping 이 무의미할 때) 를 위한 date-based 삭제 옵션.
  async function handleDeleteToday() {
    const date = kstDate();
    const { since, until } = dayWindow(date);
    const end = new Date(Date.parse(until) - 1);
    const ok = await confirmDialog({
      title: '오늘 전체 삭제',
      body: `${date} (한국 시간) 하루치 events + 좌표 모두 영구 삭제. 되돌릴 수 없음.`,
      confirmText: '삭제',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.deleteDeviceRange(deviceId, since, end.toISOString());
      await refresh();
      alertDialog({ title: '삭제 완료', body: `좌표 ${r.deleted_locations}개 · 이벤트 ${r.deleted_events}개 삭제됨.` });
    } catch (e) {
      alertDialog({ title: '삭제 실패', body: e?.message || '알 수 없는 오류' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      marginBottom: 12, padding: 10, background: 'var(--surface-2, #f6f7fa)',
      border: '1px solid var(--border, #e5e7eb)', borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>
          ⚗️ 사이클 ({cycles.length}) · 최근 7일
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={handleDeleteToday} disabled={loading || busy} style={{
            fontSize: 12, padding: '3px 8px', border: '1px solid var(--danger)',
            background: 'transparent', color: 'var(--danger)', borderRadius: 4, cursor: 'pointer',
          }} title="오늘 (KST 자정~자정) 전체 좌표+이벤트 삭제">🗑 오늘</button>
          <button onClick={refresh} disabled={loading || busy} style={{
            fontSize: 12, padding: '3px 8px', border: '1px solid var(--border)',
            background: 'transparent', borderRadius: 4, cursor: 'pointer',
          }}>{loading ? '⏳' : '🔄'}</button>
        </div>
      </div>
      {error && <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 6 }}>⚠ {error}</div>}
      {cycles.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '4px 0' }}>이 윈도우에 사이클 없음</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
          {cycles.map((c, i) => (
            <div key={c.start} style={{
              display: 'grid', gridTemplateColumns: '1fr auto auto', alignItems: 'center', gap: 6,
              padding: '5px 8px', background: 'white', borderRadius: 5, fontSize: 12,
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  <span style={{ color, marginRight: 4 }}>●</span>
                  {new Date(c.start).toLocaleString('ko-KR', KST_TIME_OPTIONS)}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  {c.endKnown ? `${Math.round(c.durationS / 60)}분` : '진행중'}
                  {c.sleepReason && c.sleepReason !== '-' ? ` · ${c.sleepReason}` : ''}
                  {c.wakeCause && c.wakeCause !== '-' ? ` · wake:${c.wakeCause}` : ''}
                </div>
              </div>
              <button onClick={() => onSeek(c)} disabled={busy} style={{
                fontSize: 12, padding: '3px 8px', border: 'none', background: 'var(--primary)',
                color: 'white', borderRadius: 4, cursor: 'pointer', fontWeight: 600,
              }}>▶ 보기</button>
              <button onClick={() => handleDelete(c)} disabled={busy} style={{
                fontSize: 12, padding: '3px 6px', border: '1px solid var(--danger)',
                background: 'transparent', color: 'var(--danger)', borderRadius: 4, cursor: 'pointer',
              }} title="이 사이클 삭제">🗑</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ISO 시각 → KST 기준 YYYY-MM-DD 문자열 (날짜 boundary 비교용)
function kstDayStr(iso) {
  return kstDate(iso);
}
// ISO 시각 → 그 시각이 속한 KST 날짜의 다음날 KST 00:00 을 ISO 로 반환
function kstNextMidnightISO(iso) {
  return dayWindow(kstDate(iso)).until;
}

// events (occurred_at DESC) → wake → sleep_enter 단위 그룹.
function groupCycles(events) {
  const asc = [...events].sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
  const out = [];
  let cur = null;
  for (const e of asc) {
    const d = e.data || {};
    // KST 날짜 boundary — cur 의 시작일과 다른 KST 날짜의 event 가 오면 새 cycle 로 분리.
    // 예외: sleep_enter 는 자정 넘겨 와도 원래 사이클 종료 신호라 append 유지.
    // 덕분에 wake 없이 하루종일 fix 만 오는 상황 (07/08 aa 사례) 에서도 그 날짜별
    // 사이클이 명시적으로 목록에 뜸 → 개별 🗑 로 정확히 그 날만 삭제 가능.
    const dayChange = cur != null && e.kind !== 'sleep_enter'
                      && kstDayStr(e.occurred_at) !== kstDayStr(cur.start);
    // 새 cycle 트리거:
    //   (1) 첫 event  (2) wake  (3) 직전 cycle 이 sleep_enter 로 닫혔을 때
    //   (4) KST 자정 boundary — sleep_enter 아닌 경우만 (3 없으면 sleep 후 fix 가
    //       닫힌 cycle 에 append 되어 range 오염).
    if (cur == null || e.kind === 'wake' || cur.endKnown || dayChange) {
      if (cur) {
        // dayChange 로 강제 마감된 진행중 cycle 은 자정으로 clamp — range 정확도 유지.
        if (dayChange && !cur.endKnown) {
          cur.end = kstNextMidnightISO(cur.start);
          cur.durationS = (new Date(cur.end) - new Date(cur.start)) / 1000;
        }
        out.push(cur);
      }
      cur = {
        start: e.occurred_at,
        end: e.occurred_at,
        endKnown: false,
        wakeCause: d.wake_cause || (e.kind === 'wake' ? 'wake' : '-'),
        sleepReason: null,
        durationS: 0,
      };
    } else {
      cur.end = e.occurred_at;
      if (e.kind === 'sleep_enter') {
        cur.endKnown = true;
        cur.sleepReason = d.sleep_reason || '-';
      }
      cur.durationS = (new Date(cur.end) - new Date(cur.start)) / 1000;
    }
  }
  // 진행중 cycle (sleep_enter 미도착) 은 end 를 확장. 단 cur.start 가 오늘 이전이면
  // 오늘 KST 자정 (= cur.start 다음날 자정) 으로만 clamp — 오늘 것은 별도 "오늘"
  // 사이클이 담당하므로 이 진행중 사이클이 오늘로 넘치면 안 됨.
  if (cur && !cur.endKnown) {
    const nowMs = Date.now();
    let capMs = nowMs;
    const nowKst = kstDayStr(new Date(nowMs).toISOString());
    if (kstDayStr(cur.start) !== nowKst) {
      // cur.start 가 오늘 아님 → 자정으로 clamp (오늘 사이클로 넘치지 않게)
      capMs = new Date(kstNextMidnightISO(cur.start)).getTime();
    }
    const endMs = new Date(cur.end).getTime();
    if (capMs > endMs) {
      cur.end = new Date(capMs).toISOString();
      cur.durationS = (capMs - new Date(cur.start).getTime()) / 1000;
    }
  }
  if (cur) out.push(cur);
  return out.reverse();   // 최신 위로
}
