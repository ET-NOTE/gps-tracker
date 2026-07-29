// (2026-07-29 F8) DeviceDetail 의 디버그·펌웨어 진단 섹션들을 이관.
//
// 이유: 일반 사용자에겐 노이즈 — 정지 감지 카운트다운, LIS3DH 헬스, 재부팅 패턴,
// cold boot ratio, LTE hard reset 트리거 등은 펌웨어 진단·현장 유지보수 도구.
// DiagnosticPage 에서 device 선택 시 이 패널이 붙는다.
//
// 유지된 UX pattern: Section / MiniStat / Counter — DeviceDetail 과 시각 통일.

import { useState, useEffect } from 'react';
import { api } from '../api';
import Icon from './Icon';

const KIND_META = {
  pair:         { icon: 'link',   label: '페어링' },
  unpair:       { icon: 'unlink', label: '해제' },
  sim_swap:     { icon: 'swap',   label: 'SIM 모뎀 이동' },
  modem_swap:   { icon: 'wrench', label: '모뎀 교체' },
  wipe:         { icon: 'trash2', label: '완전 삭제' },
  owner_change: { icon: 'user',   label: '소유자 변경' },
};

const LIFECYCLE_KIND = {
  wake:           { label: '깨어남',     color: 'var(--accent)' },
  sleep_enter:    { label: '잠듦',       color: 'var(--primary)' },
  low_batt:       { label: '저전압',     color: '#f87171' },
  offline:        { label: '오프라인',   color: 'var(--danger)' },
  online:         { label: '복구',       color: 'var(--accent)' },
  geofence_in:    { label: '펜스 진입',  color: 'var(--accent)' },
  geofence_out:   { label: '펜스 이탈',  color: 'var(--danger)' },
  geofence_armed: { label: '펜스 활성화', color: 'var(--text-2)' },
};

const BEEP_PATTERNS = [
  { beeps: 1, tone: '400ms × 1',  label: 'Cold boot',        desc: '진짜 power-off 후 첫 부팅 (RTC 메모리 초기화됨). brownout 재부팅 루프 시엔 첫 1회만.' },
  { beeps: 2, tone: '100ms × 2',  label: 'Sleep 진입',       desc: '운행 정지 3분 후 또는 시리얼 \'a\' 입력 시 deep sleep 진입.' },
  { beeps: 3, tone: '120ms × 3',  label: '첫 GPS fix',       desc: '부팅/wake 후 GPS 가 첫 좌표 잡으면 (wake 마다 reset).' },
  { beeps: 4, tone: '120ms × 4',  label: '첫 LTE POST 200',  desc: 'LTE 살아 서버 ingest 첫 성공 (wake 마다 reset).' },
  { beeps: 5, tone: '200ms × 5',  label: 'cmd:beep (현장식별)', desc: '아래 부저 트리거 클릭 시 다음 ingest 안에 울림.' },
  { beeps: 6, tone: '50ms × 6',   label: 'Motion wake',      desc: 'Deep sleep 중 LIS3DH 움직임 감지 → wake.' },
  { beeps: 7, tone: '80ms × 7',   label: 'LTE hard reset',   desc: 'SIM7080G 30초 이상 응답 없으면 PWR_EN 토글.' },
  { beeps: 8, tone: '60ms × 8',   label: '저전압 경고',       desc: 'VBAT 3.4V 미만.' },
];

function useSection(loader, deviceId, pollMs = 0) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let cancelled = false;
    let intervalId = null;
    const fetchOnce = (silent = false) => {
      if (!silent) setState({ loading: true, data: null, error: null });
      loader()
        .then(d => { if (!cancelled) setState({ loading: false, data: d, error: null }); })
        .catch(e => { if (!cancelled) setState(s => silent ? s : { loading: false, data: null, error: e }); });
    };
    fetchOnce(false);
    if (pollMs > 0) intervalId = setInterval(() => fetchOnce(true), pollMs);
    return () => { cancelled = true; if (intervalId) clearInterval(intervalId); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, pollMs]);
  return state;
}

export default function DeviceDiagnosticPanel({ device }) {
  const eventsQ = useSection(() => api.getDeviceEvents(device.id), device.id, 10000);
  const auditQ  = useSection(() => api.getAuditLog(device.id),    device.id);
  const [beeping, setBeeping]     = useState(false);
  const [beepNote, setBeepNote]   = useState(null);
  const [resetting, setResetting] = useState(false);
  const [resetNote, setResetNote] = useState(null);

  async function handleBeep() {
    setBeeping(true); setBeepNote(null);
    try { await api.beepDevice(device.id); setBeepNote({ ok: true }); }
    catch (e) { setBeepNote({ ok: false, msg: e.message }); }
    finally { setBeeping(false); }
  }
  async function handleReset() {
    setResetting(true); setResetNote(null);
    try { await api.resetDevice(device.id); setResetNote({ ok: true }); }
    catch (e) { setResetNote({ ok: false, msg: e.message }); }
    finally { setResetting(false); }
  }

  return (
    <div style={dg.shell}>
      <div style={dg.header}>
        <div style={dg.deviceName}>{device.display_name || device.device_uid}</div>
        <div style={dg.deviceUid}>{device.device_uid}</div>
      </div>

      {/* 정지 감지 · Deep Sleep 카운트다운 */}
      <Section title="정지 감지 · Deep Sleep 카운트다운">
        <StationaryBody s={device.last_stationary} />
      </Section>

      {/* 재부팅 패턴 + 누적 카운터 + 최근 이벤트 */}
      <SectionAsync title="Lifecycle · 재부팅 패턴" q={eventsQ}>
        {(data) => <LifecycleBody events={data} />}
      </SectionAsync>

      {/* 페어링 / 모뎀 교체 이력 */}
      <SectionAsync title="페어링 · 모뎀 감사 로그" q={auditQ}>
        {(data) => <AuditBody audit={data} />}
      </SectionAsync>

      {/* 부저 트리거 */}
      <Section title="현장 식별 · 부저 트리거">
        <button onClick={handleBeep} disabled={beeping} style={dg.action}>
          <Icon name="volume2" size={14} />
          {beeping ? '명령 전송 중...' : '부저 울리기 (5비프)'}
        </button>
        <div style={dg.actionNote}>
          다음 ingest (~15초) 에 디바이스 부저가 5회 울립니다.
          {beepNote?.ok  && <div style={dg.ok}>✓ 명령 등록됨</div>}
          {beepNote && !beepNote.ok && <div style={dg.err}>✗ {beepNote.msg}</div>}
        </div>
      </Section>

      {/* 원격 reset */}
      <Section title="원격 reset · LTE stuck 회복">
        <button onClick={handleReset} disabled={resetting} style={{ ...dg.action, background: 'var(--warn, #c2410c)' }}>
          <Icon name="refresh" size={14} />
          {resetting ? '명령 전송 중...' : 'LTE 모듈만 power cycle'}
        </button>
        <div style={dg.actionNote}>
          PWR_EN 토글로 SIM7080G 만 재시작. ESP 는 그대로 (RTC / sticky 보존).
          POST 자체가 안 닿는 totally-stuck 상태는 firmware 60s 무응답 watchdog 이 처리.
          {resetNote?.ok  && <div style={dg.ok}>✓ 명령 등록됨</div>}
          {resetNote && !resetNote.ok && <div style={dg.err}>✗ {resetNote.msg}</div>}
        </div>
      </Section>

      {/* 부저 패턴 레퍼런스 */}
      <Section title="부저 패턴 레퍼런스 (펌웨어 13_2+)">
        <BuzzerPatternsBody />
      </Section>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 하위 body — DeviceDetail 에서 이관 (원본과 동일 로직)
// ═══════════════════════════════════════════════════════════

function StationaryBody({ s }) {
  if (!s) return <Muted>펌웨어 13_1 이상에서만 리포트 (last_stationary null)</Muted>;
  const active     = !!s.active;
  const heldS      = s.held_s ?? 0;
  const windowS    = s.window_s ?? 300;
  const sleepInS   = active ? (s.sleep_in_s ?? 0) : windowS;
  const driftM     = s.drift_m ?? 0;
  const thresholdM = s.threshold_m ?? 50;
  const driftPct   = thresholdM > 0 ? Math.min(100, (driftM / thresholdM) * 100) : 0;
  const driftOver  = driftM > thresholdM;
  const heldPct    = windowS > 0 ? Math.min(100, (heldS / windowS) * 100) : 0;
  const motionAge  = s.motion_age_s ?? 0;
  const fixes      = s.fixes ?? 0;
  const gpsAvail   = !!s.gps_avail;
  const lisOk      = !!s.lis_ok;
  const lisReinits = s.lis_reinits ?? 0;
  const updatedAge = formatRelativeTime(s.updated_at);
  const stateLabel = active ? (sleepInS === 0 ? 'deep sleep 진입 임박' : 'deep sleep 카운트다운') : '움직임 감지 중';
  const stateColor = active ? (sleepInS === 0 ? 'var(--accent)' : 'var(--primary)') : 'var(--text-2)';

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: stateColor, boxShadow: active ? `0 0 6px ${stateColor}` : 'none' }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: stateColor }}>{stateLabel}</span>
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>갱신 {updatedAge}</span>
      </div>
      <div style={{ marginBottom: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-2)' }}>
          <span>{active ? `${sleepInS}초 후 진입` : `움직임 ${motionAge}초 전`}</span>
          <span>{heldS}s / {windowS}s</span>
        </div>
        <Bar pct={heldPct} color={active ? 'var(--primary)' : 'var(--text-3)'} />
      </div>
      <div style={{ marginBottom: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-2)' }}>
          <span>GPS drift {gpsAvail ? '' : '(no fix)'}</span>
          <span style={{ color: driftOver ? 'var(--danger)' : 'var(--text-2)' }}>{driftM.toFixed(1)} m / {thresholdM} m</span>
        </div>
        <Bar pct={driftPct} color={driftOver ? 'var(--danger)' : driftPct > 70 ? '#fbbf24' : 'var(--accent)'} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
        <MiniStat label="GPS fixes" v={fixes} sub={gpsAvail ? 'avail' : 'no fix'} warn={!gpsAvail} />
        <MiniStat label="LIS 가속도계" v={lisOk ? 'OK' : 'FAIL'} sub={`재초기화 ${lisReinits}`} warn={!lisOk} />
        <MiniStat label="모션 경과" v={`${motionAge}s`} sub="마지막 움직임" />
      </div>
    </>
  );
}

function diagnoseRebootPattern(events) {
  const wakes = events.filter(e => e.kind === 'wake');
  if (!wakes.length) return null;
  const recent = wakes.slice(0, 30);
  const coldBoots   = recent.filter(e => ['boot', 'other'].includes(e.data?.wake_cause));
  const motionWakes = recent.filter(e => e.data?.wake_cause === 'motion');
  const shortUptimes = recent.filter(e => {
    const s = e.data?.diag?.last_sleep_uptime_s;
    return s != null && s > 0 && s < 60;
  });
  const latestDiag = wakes[0]?.data?.diag ?? {};
  const brownouts = latestDiag.brownouts ?? 0;
  const coldRatio = coldBoots.length / recent.length;
  let status, label, hint;
  if (brownouts > 0 || coldRatio > 0.3 || shortUptimes.length > 3) {
    status = 'danger'; label = '재부팅 사이클 의심';
    hint = `최근 ${recent.length}회 wake 중 cold boot ${coldBoots.length}회 / brownout ${brownouts}회. PCB VBAT 보강 점검 필요.`;
  } else if (coldRatio > 0.1 || coldBoots.length > 1) {
    status = 'warn'; label = '간헐적 cold boot';
    hint = `최근 ${recent.length}회 wake 중 cold boot ${coldBoots.length}회. 전원 안정성 관찰.`;
  } else {
    status = 'ok'; label = '안정';
    hint = `motion wake ${motionWakes.length} / cold boot ${coldBoots.length} (최근 ${recent.length}회).`;
  }
  return { status, label, hint, coldBoots: coldBoots.length, motionWakes: motionWakes.length,
           brownouts, shortUptimes: shortUptimes.length, recentN: recent.length };
}

function RebootPatternCard({ d }) {
  const color = d.status === 'danger' ? 'var(--danger)' : d.status === 'warn' ? '#f59e0b' : '#10b981';
  return (
    <div style={{ background: 'var(--surface-2)', borderRadius: 6, padding: '8px 10px', borderLeft: `3px solid ${color}`, marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: color }} />
        <span style={{ fontSize: 12, fontWeight: 700, color }}>{d.label}</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.4, marginBottom: 6 }}>{d.hint}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 4 }}>
        <MiniStat label="cold boot" v={d.coldBoots}    sub={`/${d.recentN}회`} warn={d.coldBoots > 2} />
        <MiniStat label="motion"    v={d.motionWakes}  sub="정상" />
        <MiniStat label="brownout"  v={d.brownouts}    warn={d.brownouts > 0} />
        <MiniStat label="짧은 sleep" v={d.shortUptimes} sub="<60s" warn={d.shortUptimes > 1} />
      </div>
    </div>
  );
}

function eventRow(e) {
  let meta = LIFECYCLE_KIND[e.kind] || { label: e.kind, color: 'var(--text-2)' };
  const reason = e.data?.sleep_reason || e.data?.wake_cause;
  if (e.kind === 'wake' && (reason === 'boot' || reason === 'other')) {
    meta = { label: '재부팅', color: '#f59e0b' };
  }
  return (
    <div key={e.id} style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      fontSize: 12, padding: '5px 0', borderBottom: '1px solid var(--border)',
    }}>
      <span style={{ color: meta.color, fontWeight: 500 }}>{meta.label}{reason ? ` (${reason})` : ''}</span>
      <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{new Date(e.occurred_at).toLocaleString('ko-KR')}</span>
    </div>
  );
}

function LifecycleBody({ events }) {
  const [showAll, setShowAll] = useState(false);
  if (!events?.length) return <Muted>아직 sleep/wake 이벤트 기록이 없습니다.</Muted>;
  const latestWake = events.find(e => e.kind === 'wake' && e.data?.diag);
  const diag = latestWake?.data?.diag;
  const more = Math.max(0, events.length - 5);
  const diagnosis = diagnoseRebootPattern(events);
  return (
    <>
      {diagnosis && <RebootPatternCard d={diagnosis} />}
      {diag && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 8 }}>
          <Counter label="총 부팅"    v={diag.boots} />
          <Counter label="모션 깨움"  v={diag.motion_wakes} />
          <Counter label="스위치 깨움" v={diag.switch_wakes} />
          <Counter label="GPS 실패"  v={diag.no_fix_cycles}     warn={diag.no_fix_cycles > 3} />
          <Counter label="모뎀 실패" v={diag.modem_fail_cycles} warn={diag.modem_fail_cycles > 0} />
          <Counter label="브라운아웃" v={diag.brownouts}         warn={diag.brownouts > 0} />
        </div>
      )}
      {events.slice(0, 5).map(eventRow)}
      {more > 0 && (
        <button onClick={() => setShowAll(true)} style={{
          marginTop: 8, padding: '6px 10px', width: '100%',
          background: 'var(--surface-2)', color: 'var(--text-2)',
          border: '1px solid var(--border)', borderRadius: 6,
          fontSize: 11, fontWeight: 600, cursor: 'pointer',
        }}>전체 보기 ({events.length}건)</button>
      )}
      {showAll && (
        <div onClick={() => setShowAll(false)} style={{
          position: 'fixed', inset: 0, zIndex: 950,
          background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            width: '100%', maxWidth: 480, maxHeight: '80vh',
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>동작 이력 — 전체 ({events.length}건)</div>
              <button onClick={() => setShowAll(false)} style={{
                background: 'transparent', border: '1px solid var(--border)', borderRadius: 6,
                padding: '4px 8px', cursor: 'pointer', color: 'var(--text-2)', fontSize: 12,
              }}>닫기</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
              {events.map(eventRow)}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function AuditBody({ audit }) {
  if (!audit?.length) return <Muted>이력 없음</Muted>;
  return (
    <>
      {audit.slice(0, 5).map(e => {
        const meta = KIND_META[e.event_type];
        return (
          <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, padding: '4px 0', color: 'var(--text)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-2)' }}>
              {meta && <Icon name={meta.icon} size={14} />}
              <span>{meta?.label || e.event_type}</span>
            </span>
            <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{new Date(e.occurred_at).toLocaleString('ko-KR')}</span>
          </div>
        );
      })}
      {audit.length > 5 && <Muted>...외 {audit.length - 5}건</Muted>}
    </>
  );
}

function BuzzerPatternsBody() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {BEEP_PATTERNS.map(p => (
        <div key={p.beeps} style={{
          display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 2,
          padding: '6px 8px', borderRadius: 6, background: 'var(--surface-2, #f6f7fa)',
        }}>
          <div style={{
            gridRow: '1 / 3', alignSelf: 'center',
            minWidth: 28, height: 28, borderRadius: 14,
            background: '#1a1a2e', color: '#fbbf24',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 700, letterSpacing: '.02em',
          }}>{p.beeps}</div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-1)' }}>
            {p.label}
            <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 500, color: 'var(--text-3, #888)' }}>{p.tone}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.5 }}>{p.desc}</div>
        </div>
      ))}
    </div>
  );
}

function Counter({ label, v, warn }) {
  if (v === undefined || v === null) return null;
  return (
    <div style={{
      background: 'var(--surface-2)', borderRadius: 6, padding: '6px 8px',
      border: warn ? '1px solid #f87171' : '1px solid transparent',
    }}>
      <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: warn ? '#f87171' : 'var(--text)' }}>{v}</div>
    </div>
  );
}

function MiniStat({ label, v, sub, warn }) {
  return (
    <div style={{
      background: 'var(--surface-2)', borderRadius: 6, padding: '6px 8px',
      border: warn ? '1px solid #f87171' : '1px solid transparent',
    }}>
      <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: warn ? '#f87171' : 'var(--text)' }}>{v}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function Bar({ pct, color }) {
  return (
    <div style={{ width: '100%', height: 6, background: 'var(--border)', borderRadius: 3, marginTop: 4 }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3, transition: 'width .3s' }} />
    </div>
  );
}

function SectionAsync({ title, q, skeletonH = 50, children }) {
  return (
    <Section title={title}>
      {q.loading && (
        <div style={{
          height: skeletonH, borderRadius: 6,
          background: 'linear-gradient(90deg, var(--surface-2) 0%, var(--surface) 50%, var(--surface-2) 100%)',
          backgroundSize: '200% 100%', animation: 'shimmer 1.2s infinite',
        }} />
      )}
      {!q.loading && q.error && <Muted>불러오기 실패</Muted>}
      {!q.loading && !q.error && children(q.data)}
    </Section>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{
        fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
        fontSize: 10.5, fontWeight: 500,
        color: 'var(--text-2)', textTransform: 'uppercase',
        letterSpacing: '0.11em', marginBottom: 6,
      }}>{title}</div>
      {children}
    </div>
  );
}

function Muted({ children }) {
  return <div style={{ color: 'var(--text-3)', fontSize: 12, fontStyle: 'italic' }}>{children}</div>;
}

function formatRelativeTime(isoTs) {
  if (!isoTs) return '—';
  const t = new Date(isoTs).getTime();
  if (isNaN(t)) return '—';
  const diff = Math.max(0, Date.now() - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const d = Math.floor(hr / 24);
  return `${d}일 전`;
}

const dg = {
  shell: {
    background: 'var(--surface, #ffffff)',
    border: '1px solid var(--border)', borderRadius: 8,
    padding: '14px 16px', marginTop: 16,
  },
  header: {
    display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
    marginBottom: 8, gap: 12,
    borderBottom: '1px solid var(--border)', paddingBottom: 8,
  },
  deviceName: { fontSize: 15, fontWeight: 700, color: 'var(--text)' },
  deviceUid:  { fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 11, color: 'var(--text-3)' },
  action: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    width: '100%', padding: 9,
    background: 'var(--primary)', color: 'white',
    border: 'none', borderRadius: 6, cursor: 'pointer',
    fontSize: 12, fontWeight: 600,
  },
  actionNote: { fontSize: 11, color: 'var(--text-2)', marginTop: 6, lineHeight: 1.5 },
  ok:  { marginTop: 4, color: 'var(--success, #2da44e)' },
  err: { marginTop: 4, color: 'var(--danger)' },
};
