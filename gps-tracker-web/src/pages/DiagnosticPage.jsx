// 14_* 진단 sketch 검증용 페이지.
// 디바이스마다 events 타임라인 + build_tag (sketch 식별자) + 사이클별 LTE bringup 시간.
// 매 5초 폴링. 시간 윈도우 1h / 6h / 24h 선택.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

const WINDOWS = [
  { label: '최근 1시간', ms: 1 * 3600 * 1000 },
  { label: '최근 6시간', ms: 6 * 3600 * 1000 },
  { label: '최근 24시간', ms: 24 * 3600 * 1000 },
];

export default function DiagnosticPage() {
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState(null);
  const [windowMs, setWindowMs] = useState(WINDOWS[0].ms);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [taggedOnly, setTaggedOnly] = useState(true);   // build_tag 있는 것만 (= 14_X 진단 세션만)
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => {
    api.listDevices().then(list => {
      setDevices(list);
      if (list?.length && deviceId == null) setDeviceId(list[0].id);
    }).catch(e => setError(e?.message || 'listDevices failed'));
  }, []);

  const refresh = async () => {
    if (deviceId == null) return;
    setLoading(true);
    try {
      const since = new Date(Date.now() - windowMs).toISOString();
      const rows = await api.getDeviceEvents(deviceId, { since, limit: 1000 });
      setEvents(rows || []);
      setError(null);
    } catch (e) {
      setError(e?.message || 'getDeviceEvents failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, [deviceId, windowMs]);
  useEffect(() => {
    if (!autoRefresh || deviceId == null) return;
    pollRef.current = setInterval(refresh, 5000);
    return () => clearInterval(pollRef.current);
  }, [autoRefresh, deviceId, windowMs]);

  // build_tag 필터 — 켜져있으면 14_* 진단 sketch 이벤트만 (legacy 13_2 prod 이벤트 제외).
  const filteredEvents = useMemo(() => {
    if (!taggedOnly) return events;
    return events.filter(e => e.data?.build_tag);
  }, [events, taggedOnly]);

  // 사이클 묶음 — events 가 occurred_at DESC 로 들어옴 (서버 기준).
  // 시간 ASC 로 뒤집어 wake → ... → sleep_enter 패턴으로 grouping.
  const cycles = useMemo(() => groupByCycle(filteredEvents), [filteredEvents]);

  const dev = devices.find(d => d.id === deviceId);

  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f7', color: '#1a1a2e', fontFamily: '-apple-system,system-ui,sans-serif' }}>
      <header style={{ background: '#1a1a2e', color: 'white', padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/" style={{ color: '#fbbf24', textDecoration: 'none', fontWeight: 600 }}>← 홈</Link>
          <h1 style={{ fontSize: 18, margin: 0, fontWeight: 700 }}>📡 14_* 진단 콘솔</h1>
        </div>
        <div style={{ fontSize: 11, color: '#a0a0c0' }}>
          {loading ? '⏳ 갱신 중...' : `${events.length} events`}
        </div>
      </header>

      <div style={{ padding: 16, maxWidth: 1200, margin: '0 auto' }}>
        {/* 컨트롤 */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 16, padding: 12, background: 'white', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
          <label style={lab}>
            디바이스
            <select value={deviceId ?? ''} onChange={e => setDeviceId(Number(e.target.value))} style={sel}>
              {devices.map(d => (
                <option key={d.id} value={d.id}>{d.display_name || d.device_uid} (id={d.id})</option>
              ))}
            </select>
          </label>
          <label style={lab}>
            윈도우
            <select value={windowMs} onChange={e => setWindowMs(Number(e.target.value))} style={sel}>
              {WINDOWS.map(w => <option key={w.ms} value={w.ms}>{w.label}</option>)}
            </select>
          </label>
          <label style={{ ...lab, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
            <span style={{ fontSize: 12 }}>5초 자동 갱신</span>
          </label>
          <label style={{ ...lab, flexDirection: 'row', alignItems: 'center', gap: 6 }} title="build_tag 가 있는 이벤트만 (= 14_* 진단 sketch 세션). 끄면 prod 13_2 같은 legacy 이벤트도 표시.">
            <input type="checkbox" checked={taggedOnly} onChange={e => setTaggedOnly(e.target.checked)} />
            <span style={{ fontSize: 12 }}>build_tag 있는 것만</span>
          </label>
          <button onClick={refresh} disabled={loading} style={btn}>🔄 새로고침</button>
          {dev && (
            <div style={{ marginLeft: 'auto', fontSize: 11, color: '#666' }}>
              uid: <code>{dev.device_uid}</code>
            </div>
          )}
        </div>

        {error && <div style={errBox}>⚠ {error}</div>}

        {/* 사이클 요약 */}
        <SectionCard title={`사이클 (${cycles.length})${taggedOnly && filteredEvents.length < events.length ? ` — legacy ${events.length - filteredEvents.length}개 제외` : ''}`}>
          {cycles.length === 0 ? (
            <Muted>
              {taggedOnly && events.length > 0
                ? `이 윈도우에 build_tag 있는 이벤트 없음. (legacy ${events.length}개는 위 체크 끄면 보임)`
                : '이 윈도우에 wake/sleep 이벤트 없음.'}
            </Muted>
          ) : (
            <CycleTable cycles={cycles} />
          )}
        </SectionCard>

        {/* 원본 이벤트 */}
        <SectionCard title={`원본 이벤트 (${filteredEvents.length}${taggedOnly && filteredEvents.length < events.length ? ` / 전체 ${events.length}` : ''})`}>
          <EventsTable events={filteredEvents} />
        </SectionCard>
      </div>
    </div>
  );
}

// occurred_at DESC 로 들어온 events 를 사이클로 묶음.
// 사이클 정의: 한 wake (또는 첫 이벤트) ~ 다음 wake 직전.
// sleep_enter 가 있으면 그 사이클이 sleep 으로 종료된 것.
function groupByCycle(events) {
  if (!events.length) return [];
  const asc = [...events].sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
  const out = [];
  let cur = null;
  for (const e of asc) {
    const data = e.data || {};
    const tag = data.build_tag || '-';
    if (e.kind === 'wake' || cur == null) {
      if (cur) out.push(cur);
      cur = {
        start: e.occurred_at,
        end: null,
        buildTag: tag,
        wakeCause: data.wake_cause || (e.kind === 'wake' ? 'wake' : 'unknown'),
        sleepReason: null,
        uptime_s: null,
        vbat_mv: data.vbat_mv ?? null,
        events: [e],
        bringupS: null,
      };
    } else {
      cur.events.push(e);
      if (tag !== '-' && cur.buildTag === '-') cur.buildTag = tag;
      if (e.kind === 'sleep_enter') {
        cur.end = e.occurred_at;
        cur.sleepReason = data.sleep_reason || '-';
        cur.uptime_s = data.uptime_s ?? null;
        cur.vbat_mv = data.vbat_mv ?? cur.vbat_mv;
        // bringup_s = sleep_enter occurred_at - wake occurred_at - uptime_s 가 아니라,
        // 사이클 안에서 처음 events 사이 간격 부정확. uptime_s 자체가 LTE 살아난 시점부터의 의미가 아니므로
        // 진단 페이지에선 'cycle 총 길이' 만 표시.
      }
    }
  }
  if (cur) out.push(cur);
  return out.reverse();   // 최신 사이클 위로
}

function CycleTable({ cycles }) {
  return (
    <div style={{ overflow: 'auto' }}>
      <table style={tbl}>
        <thead>
          <tr>
            <th style={th}>#</th>
            <th style={th}>build_tag</th>
            <th style={th}>wake</th>
            <th style={th}>start (KST)</th>
            <th style={th}>cycle s</th>
            <th style={th}>sleep_reason</th>
            <th style={th}>vbat</th>
            <th style={th}>events</th>
          </tr>
        </thead>
        <tbody>
          {cycles.map((c, i) => {
            const startMs = new Date(c.start).getTime();
            const endMs = c.end ? new Date(c.end).getTime() : Date.now();
            const dur = Math.round((endMs - startMs) / 1000);
            return (
              <tr key={c.start} style={{ background: i % 2 ? '#fafafa' : 'white' }}>
                <td style={td}>{cycles.length - i}</td>
                <td style={{ ...td, ...badge(c.buildTag) }}>{c.buildTag}</td>
                <td style={td}>{c.wakeCause}</td>
                <td style={td}>{new Date(c.start).toLocaleString('ko-KR')}</td>
                <td style={td}>{dur}s {c.end ? '' : '(진행중)'}</td>
                <td style={td}>{c.sleepReason || '-'}</td>
                <td style={td}>{c.vbat_mv ? `${c.vbat_mv} mV` : '-'}</td>
                <td style={td}>{c.events.length}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EventsTable({ events }) {
  return (
    <div style={{ overflow: 'auto', maxHeight: 480 }}>
      <table style={tbl}>
        <thead>
          <tr>
            <th style={th}>time (KST)</th>
            <th style={th}>kind</th>
            <th style={th}>build_tag</th>
            <th style={th}>wake_cause</th>
            <th style={th}>sleep_reason</th>
            <th style={th}>vbat</th>
            <th style={th}>diag</th>
          </tr>
        </thead>
        <tbody>
          {events.map(e => {
            const d = e.data || {};
            const diag = d.diag || {};
            const diagStr = ['boots','wakes','motion_wakes','brownouts']
              .map(k => diag[k] != null ? `${k}:${diag[k]}` : null).filter(Boolean).join(' ');
            return (
              <tr key={e.id}>
                <td style={td}>{new Date(e.occurred_at).toLocaleString('ko-KR')}</td>
                <td style={td}>{e.kind}</td>
                <td style={{ ...td, ...badge(d.build_tag) }}>{d.build_tag || '-'}</td>
                <td style={td}>{d.wake_cause || '-'}</td>
                <td style={td}>{d.sleep_reason || '-'}</td>
                <td style={td}>{d.vbat_mv ? `${d.vbat_mv}mV` : '-'}</td>
                <td style={{ ...td, fontSize: 10, color: '#666' }}>{diagStr}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SectionCard({ title, children }) {
  return (
    <div style={{ marginBottom: 16, background: 'white', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
      <div style={{ padding: '10px 14px', fontSize: 13, fontWeight: 700, borderBottom: '1px solid #eee' }}>{title}</div>
      <div style={{ padding: 12 }}>{children}</div>
    </div>
  );
}

function Muted({ children }) { return <div style={{ color: '#888', fontSize: 12 }}>{children}</div>; }

const lab = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: '#555' };
const sel = { fontSize: 12, padding: '5px 8px', border: '1px solid #d0d0d8', borderRadius: 5, background: 'white' };
const btn = { fontSize: 12, padding: '6px 12px', border: '1px solid #1a1a2e', background: '#1a1a2e', color: 'white', borderRadius: 5, cursor: 'pointer', fontWeight: 600 };
const errBox = { background: '#fee2e2', border: '1px solid #fecaca', color: '#991b1b', padding: 10, borderRadius: 6, fontSize: 12, marginBottom: 12 };
const tbl = { width: '100%', borderCollapse: 'collapse', fontSize: 11 };
const th = { textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid #1a1a2e', fontWeight: 600, whiteSpace: 'nowrap' };
const td = { padding: '5px 8px', borderBottom: '1px solid #eee', whiteSpace: 'nowrap' };

// build_tag 별 배지 색 — sketch 시각 구분.
function badge(tag) {
  if (!tag || tag === '-') return { color: '#aaa' };
  const palette = {
    '14_a': '#10b981', '14_e': '#10b981',
    '14_b': '#3b82f6', '14_f': '#3b82f6',
    '14_c': '#f59e0b', '14_g': '#f59e0b',
    '14_d': '#6b7280', '14_h': '#6b7280',
    '14_i': '#ec4899', '14_j': '#ec4899',
    '13_1': '#9ca3af', '13_2': '#1f2937',
  };
  const c = palette[tag] || '#1a1a2e';
  return { color: c, fontWeight: 700, fontFamily: 'ui-monospace,monospace' };
}
