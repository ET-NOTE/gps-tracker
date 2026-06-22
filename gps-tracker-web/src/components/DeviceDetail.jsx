// 디바이스 카드 하단에 펼쳐지는 상세 패널 — SIM 정보, 감사 로그, 공유 링크, Wipe 버튼.
// 섹션마다 독립 로딩: 1NCE SIM 호출이 느려도 운행통계/이벤트/감사로그는 즉시 렌더.
import { useState, useEffect } from 'react';
import { api } from '../api';
import ShareLinkPanel from './ShareLinkPanel';
import Icon from './Icon';
import { confirmDialog, alertDialog } from './Dialog';
import { ageString, isStale, isFixStale } from '../colors';

const KIND_META = {
  pair:         { icon: 'link',   label: '페어링' },
  unpair:       { icon: 'unlink', label: '해제' },
  sim_swap:     { icon: 'swap',   label: 'SIM 모뎀 이동' },
  modem_swap:   { icon: 'wrench', label: '모뎀 교체' },
  wipe:         { icon: 'trash2', label: '완전 삭제' },
  owner_change: { icon: 'user',   label: '소유자 변경' },
};

// 섹션별 비동기 로더 훅 — device.id 가 바뀌면 즉시 reset 후 재호출.
// pollMs > 0 면 그 주기로 재호출 (loading 상태 안 만들고 silent refresh).
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
    if (pollMs > 0) {
      intervalId = setInterval(() => fetchOnce(true), pollMs);
    }
    return () => { cancelled = true; if (intervalId) clearInterval(intervalId); };
  // loader 는 매 렌더 새로 만들어지지만, deviceId/pollMs 만 deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, pollMs]);
  return state;
}

export default function DeviceDetail({ device, onWiped }) {
  // 통계 탭 — 자주 봄. 빠른 자체 DB 집계.
  const statsQ  = useSection(() => api.getDailyStats(device.id, { limit: 7 }), device.id);
  const eventsQ = useSection(() => api.getDeviceEvents(device.id),             device.id, 10000);  // 10초 폴링 — 동적 갱신
  // 관리 탭 — 가끔. SIM 외부 API 는 느릴 수 있음.
  const auditQ  = useSection(() => api.getAuditLog(device.id),                 device.id);
  const simQ    = useSection(() => api.getSimInfo(device.id),                  device.id);

  const [tab, setTab] = useState('stats');           // 'stats' | 'manage'
  const [wiping, setWiping] = useState(false);
  const [beeping, setBeeping] = useState(false);
  const [beepNote, setBeepNote] = useState(null);    // 마지막 결과 표시용

  async function handleWipe() {
    if (!confirm('이 디바이스의 모든 데이터(위치 기록, 이벤트 등)를 영구히 삭제합니다.\n계속하시겠습니까?')) return;
    if (!confirm('정말로 삭제하시겠습니까? 되돌릴 수 없습니다.')) return;
    setWiping(true);
    try {
      await api.wipeDevice(device.id);
      onWiped?.(device.id);
    } catch (e) {
      alert(e.message);
    } finally {
      setWiping(false);
    }
  }

  async function handleBeep() {
    setBeeping(true);
    setBeepNote(null);
    try {
      await api.beepDevice(device.id);
      setBeepNote({ ok: true, at: Date.now() });
    } catch (e) {
      setBeepNote({ ok: false, msg: e.message });
    } finally {
      setBeeping(false);
    }
  }

  return (
    <div style={dt.shell}>
      {/* 탭 헤더 */}
      <div style={dt.tabs}>
        <button onClick={() => setTab('stats')}
          style={{ ...dt.tab, ...(tab === 'stats' ? dt.tabOn : null) }}>
          <Icon name="bar" size={13} /> 통계
        </button>
        <button onClick={() => setTab('manage')}
          style={{ ...dt.tab, ...(tab === 'manage' ? dt.tabOn : null) }}>
          <Icon name="wrench" size={13} /> 관리
        </button>
      </div>

      <div style={dt.body}>
        {tab === 'stats' && (
          <>
            {/* 수신 상태 — LTE 마지막 통신 / GPS 마지막 좌표 / 마지막 위치 */}
            <Section title="수신 상태">
              <ReceiveStatusBody device={device} />
            </Section>

            {/* 운행 통계 — 자체 DB 집계, 빠름 */}
            <SectionAsync title="운행 통계" q={statsQ} skeletonH={70}>
              {(data) => <StatsBody stats={data} />}
            </SectionAsync>

            {/* deep sleep 카운트다운 — 펌웨어 13_1+ stationary 진단 */}
            <Section title="정지 감지 / Deep Sleep">
              <StationaryBody s={device.last_stationary} />
            </Section>

            {/* 부저음 패턴 — 현장에서 단말 상태 청각 식별. 횟수로 시나리오 구분. */}
            <Section title="부저음 패턴">
              <BuzzerPatternsBody />
            </Section>

            {/* 동작 이력 — 자체 DB, 빠름 */}
            <SectionAsync title="동작 이력" q={eventsQ} skeletonH={50}>
              {(data) => <LifecycleBody events={data} />}
            </SectionAsync>
          </>
        )}

        {tab === 'manage' && (
          <>
            {/* SIM 정보 — 1NCE 외부 API, 느림. 따로 로드되므로 위 섹션 블록 안 함 */}
            <SectionAsync title="SIM 정보" q={simQ} skeletonH={80}>
              {(data) => <SimBody sim={data} deviceId={device.id} />}
            </SectionAsync>

            {/* SIM 충전 요청 — 사용자가 보유 포인트로 데이터 충전 신청 */}
            <SimTopupRequest deviceId={device.id} simReady={!simQ.loading && simQ.data?.configured} />

            {/* 공유 링크 */}
            <ShareLinkPanel deviceId={device.id} />

            {/* 감사 로그 — 페어링 / 모뎀 교체 등 */}
            <SectionAsync title="페어링 이력" q={auditQ} skeletonH={40}>
              {(data) => <AuditBody audit={data} />}
            </SectionAsync>

            {/* 현장 식별 — 부저 원격 트리거 */}
            <Section title="현장 식별">
              <div style={{ position: 'relative', display: 'flex', alignItems: 'stretch', gap: 6 }}>
                <button onClick={handleBeep} disabled={beeping}
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    flex: 1, padding: 9,
                    background: 'var(--primary)', color: 'white',
                    border: 'none', borderRadius: 6,
                    cursor: 'pointer', fontSize: 12, fontWeight: 600,
                    opacity: beeping ? 0.6 : 1,
                  }}>
                  <Icon name="volume2" size={14} />
                  {beeping ? '명령 전송 중...' : '🔊 부저 울리기'}
                </button>
                <BeepInfoTip />
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 6, lineHeight: 1.5 }}>
                다음 ingest 시 (~15초 이내) 디바이스 부저가 울립니다 (5비프). 여러 단말기 동시 휴대 시 어느 보드가
                서버상 어떤 ID 인지 확인할 때 사용.
                {beepNote && beepNote.ok && (
                  <div style={{ marginTop: 4, color: 'var(--success, #2da44e)' }}>
                    ✅ 명령 등록됨 — 15초 안에 울려요
                  </div>
                )}
                {beepNote && !beepNote.ok && (
                  <div style={{ marginTop: 4, color: 'var(--danger)' }}>
                    ❌ {beepNote.msg}
                  </div>
                )}
              </div>
            </Section>

            {/* 위험 영역 */}
            <Section title="위험 영역" danger>
              <button onClick={handleWipe} disabled={wiping}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  width: '100%', padding: 9,
                  background: 'transparent', color: 'var(--danger)',
                  border: '1px solid var(--danger)', borderRadius: 6,
                  cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  opacity: wiping ? 0.6 : 1,
                }}>
                <Icon name="trash2" size={14} />
                {wiping ? '삭제 중...' : '디바이스 + 모든 데이터 영구 삭제'}
              </button>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

const dt = {
  shell: {
    marginTop: 8, borderRadius: 6,
    background: 'var(--surface-2)', border: '1px solid var(--border)',
    overflow: 'hidden',
  },
  tabs: {
    display: 'flex',
    background: 'var(--surface)',
    borderBottom: '1px solid var(--border)',
  },
  tab: {
    flex: 1,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: '8px 0',
    background: 'transparent', color: 'var(--text-3)',
    border: 'none', borderBottom: '2px solid transparent',
    cursor: 'pointer',
    fontSize: 12, fontWeight: 500,
    transition: 'color .15s, border-color .15s',
  },
  tabOn: {
    color: 'var(--primary)', borderBottomColor: 'var(--primary)',
    fontWeight: 600,
  },
  body: {
    padding: 8,
  },
};

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

function eventRow(e) {
  let meta = LIFECYCLE_KIND[e.kind] || { label: e.kind, color: 'var(--text-2)' };
  const reason = e.data?.sleep_reason || e.data?.wake_cause;
  // wake event 의 wake_cause 가 'boot'/'other' 면 deep sleep wake 가 아닌 ESP cold boot
  // = brownout / watchdog / power-on 등 비정상 재부팅. 정상 wake 와 시각적으로 분리.
  if (e.kind === 'wake' && (reason === 'boot' || reason === 'other')) {
    meta = { label: '재부팅', color: '#f59e0b' };
  }
  return (
    <div key={e.id} style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      fontSize: 12, padding: '5px 0',
      borderBottom: '1px solid var(--border)',
    }}>
      <span style={{ color: meta.color, fontWeight: 500 }}>
        {meta.label}{reason ? ` (${reason})` : ''}
      </span>
      <span style={{ color: 'var(--text-3)', fontSize: 11 }}>
        {new Date(e.occurred_at).toLocaleString('ko-KR')}
      </span>
    </div>
  );
}

// 재부팅 패턴 분석 — wake_cause 'boot'/'other' 는 deep sleep wake 가 아닌 비정상 cold boot.
// brownout / 짧은 sleep_uptime / cold boot 비율로 ESP 안정성 판정.
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
    status = 'danger';
    label = '재부팅 사이클 의심';
    hint = `최근 ${recent.length}회 wake 중 cold boot ${coldBoots.length}회 / brownout ${brownouts}회. PCB VBAT 보강 점검 필요.`;
  } else if (coldRatio > 0.1 || coldBoots.length > 1) {
    status = 'warn';
    label = '간헐적 cold boot';
    hint = `최근 ${recent.length}회 wake 중 cold boot ${coldBoots.length}회. 전원 안정성 관찰.`;
  } else {
    status = 'ok';
    label = '안정';
    hint = `motion wake ${motionWakes.length} / cold boot ${coldBoots.length} (최근 ${recent.length}회).`;
  }
  return { status, label, hint, coldBoots: coldBoots.length, motionWakes: motionWakes.length,
           brownouts, shortUptimes: shortUptimes.length, recentN: recent.length };
}

function RebootPatternCard({ d }) {
  const color = d.status === 'danger' ? 'var(--danger)'
              : d.status === 'warn' ? '#f59e0b'
              : '#10b981';
  return (
    <div style={{
      background: 'var(--surface-2)', borderRadius: 6, padding: '8px 10px',
      borderLeft: `3px solid ${color}`, marginBottom: 8,
    }}>
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

function LifecycleBody({ events }) {
  const [showAll, setShowAll] = useState(false);
  if (!events?.length) return <Muted>아직 sleep/wake 이벤트 기록이 없습니다.</Muted>;

  // 최신 wake 의 diag 카운터를 우선 표시
  const latestWake = events.find(e => e.kind === 'wake' && e.data?.diag);
  const diag = latestWake?.data?.diag;
  const more = Math.max(0, events.length - 5);
  const diagnosis = diagnoseRebootPattern(events);

  return (
    <>
      {/* 재부팅 패턴 진단 — wake_cause + brownout 카운터로 정상 sleep cycle vs 비정상 reset 분리 */}
      {diagnosis && <RebootPatternCard d={diagnosis} />}

      {/* 누적 카운터 */}
      {diag && (
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
          gap: 6, marginBottom: 8,
        }}>
          <Counter label="총 부팅"    v={diag.boots} />
          <Counter label="모션 깨움"  v={diag.motion_wakes} />
          <Counter label="스위치 깨움" v={diag.switch_wakes} />
          <Counter label="GPS 실패"  v={diag.no_fix_cycles}     warn={diag.no_fix_cycles > 3} />
          <Counter label="모뎀 실패" v={diag.modem_fail_cycles} warn={diag.modem_fail_cycles > 0} />
          <Counter label="브라운아웃" v={diag.brownouts}         warn={diag.brownouts > 0} />
        </div>
      )}

      {/* 최근 이벤트 5건 */}
      {events.slice(0, 5).map(eventRow)}

      {more > 0 && (
        <button onClick={() => setShowAll(true)} style={{
          marginTop: 8, padding: '6px 10px', width: '100%',
          background: 'var(--surface-2)', color: 'var(--text-2)',
          border: '1px solid var(--border)', borderRadius: 6,
          fontSize: 11, fontWeight: 600, cursor: 'pointer',
        }}>
          전체 보기 ({events.length}건)
        </button>
      )}

      {showAll && (
        <EventListModal events={events} onClose={() => setShowAll(false)} />
      )}
    </>
  );
}

// 전체 이벤트 모달 — backdrop 탭 또는 X 버튼으로 닫기.
function EventListModal({ events, onClose }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 950,
      background: 'rgba(0,0,0,0.5)',
      backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16,
      animation: 'fadeInUp .15s ease-out',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 480, maxHeight: '80vh',
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, padding: 16,
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 8, flexShrink: 0,
        }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>동작 이력 — 전체 ({events.length}건)</div>
          <button onClick={onClose} style={{
            background: 'transparent', border: '1px solid var(--border)', borderRadius: 6,
            padding: '4px 8px', cursor: 'pointer', color: 'var(--text-2)', fontSize: 12,
          }}>닫기</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {events.map(eventRow)}
        </div>
      </div>
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

// 펌웨어 13_1+ stationary 진단 — devices.last_stationary JSONB.
// 매 POST 마다 덮어씌워지며 deep sleep 까지 N초 카운트다운 + GPS drift 경계 + LIS 헬스를 한눈에.
// 부저 패턴 — 펌웨어 13_2 에서 시나리오마다 비프 횟수 다름. 현장에서 청각으로 단말 상태 판단.
// 각 시나리오의 트리거 조건과 톤 길이까지 같이 표기. arduino/13_2_motion_aware_tracker.ino 와 동기 유지.
const BEEP_PATTERNS = [
  { beeps: 1, tone: '400ms × 1',  label: 'Cold boot',        desc: '진짜 power-off 후 첫 부팅 (RTC 메모리 초기화됨). brownout 재부팅 루프 시엔 첫 1회만 울리고 이후 차단.' },
  { beeps: 2, tone: '100ms × 2',  label: 'Sleep 진입',       desc: '운행 정지 3분 후 또는 시리얼 \'a\' 입력 시 deep sleep 진입.' },
  { beeps: 3, tone: '120ms × 3',  label: '첫 GPS fix',       desc: '부팅/wake 후 GPS 가 첫 좌표를 잡으면 한 번 (wake 마다 reset).' },
  { beeps: 4, tone: '120ms × 4',  label: '첫 LTE POST 200',  desc: 'LTE 가 살아 서버 ingest 첫 성공 시 한 번 (wake 마다 reset).' },
  { beeps: 5, tone: '200ms × 5',  label: 'cmd:beep (현장식별)', desc: '관리 탭의 🔊 부저 울리기 클릭 시 서버가 다음 ingest 에 명령 첨부 → ~15초 안에 울림.' },
  { beeps: 6, tone: '50ms × 6',   label: 'Motion wake',      desc: 'Deep sleep 상태에서 LIS3DH 가 움직임 감지 → wake. 매번 무조건 울림 (가드 없음).' },
  { beeps: 7, tone: '80ms × 7',   label: 'LTE hard reset',   desc: 'SIM7080G 가 SHCONN 등에서 30초 이상 응답 안 하면 PWR_EN 토글로 hard reset.' },
  { beeps: 8, tone: '60ms × 8',   label: '저전압 경고',       desc: 'VBAT 3.4V 미만으로 떨어지면. 충전 또는 교체 알림.' },
];
// 버튼 옆 (i) 아이콘 — 호버 / 클릭 (모바일) 시 비프 패턴 요약 카드 표시.
function BeepInfoTip() {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label="비프 패턴 안내"
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 36, padding: 0,
          background: 'transparent', color: 'var(--text-2)',
          border: '1px solid var(--border, #d0d0d8)', borderRadius: 6,
          cursor: 'pointer',
        }}
      >
        <Icon name="info" size={15} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 'calc(100% + 6px)',
          zIndex: 10, minWidth: 240,
          background: '#1a1a2e', color: 'white',
          padding: '8px 10px', borderRadius: 6,
          fontSize: 11, lineHeight: 1.6,
          boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4, color: '#fbbf24' }}>비프 패턴 요약</div>
          {BEEP_PATTERNS.map(p => (
            <div key={p.beeps} style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: '#fbbf24', fontWeight: 700, minWidth: 14 }}>{p.beeps}</span>
              <span>{p.label}</span>
            </div>
          ))}
          <div style={{ marginTop: 6, fontSize: 10, color: '#a0a0c0' }}>
            자세한 톤·트리거 → 통계 탭 ‘부저음 패턴’
          </div>
        </div>
      )}
    </div>
  );
}

function BuzzerPatternsBody() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 2, lineHeight: 1.5 }}>
        펌웨어 13_2 기준. 비프 횟수로 단말 상태를 청각 식별.
      </div>
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
            <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 500, color: 'var(--text-3, #888)' }}>
              {p.tone}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.5 }}>{p.desc}</div>
        </div>
      ))}
    </div>
  );
}

function StationaryBody({ s }) {
  if (!s) {
    return <Muted>아직 stationary 진단 데이터가 없습니다 (펌웨어 13_1 이상 필요)</Muted>;
  }

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

  const stateLabel = active
    ? (sleepInS === 0 ? 'deep sleep 진입 임박' : 'deep sleep 카운트다운')
    : '움직임 감지 중';
  const stateColor = active
    ? (sleepInS === 0 ? 'var(--accent)' : 'var(--primary)')
    : 'var(--text-2)';

  return (
    <>
      {/* 상태 + 카운트다운 */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8, marginBottom: 6,
      }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            width: 8, height: 8, borderRadius: 4, background: stateColor,
            boxShadow: active ? `0 0 6px ${stateColor}` : 'none',
          }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: stateColor }}>{stateLabel}</span>
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>갱신 {updatedAge}</span>
      </div>

      {/* 카운트다운 바: held_s / window_s */}
      <div style={{ marginBottom: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-2)' }}>
          <span>{active ? `${sleepInS}초 후 진입` : `움직임 ${motionAge}초 전`}</span>
          <span>{heldS}s / {windowS}s</span>
        </div>
        <div style={{ width: '100%', height: 6, background: 'var(--border)', borderRadius: 3, marginTop: 4 }}>
          <div style={{
            width: `${heldPct}%`, height: '100%',
            background: active ? 'var(--primary)' : 'var(--text-3)',
            borderRadius: 3, transition: 'width .3s',
          }} />
        </div>
      </div>

      {/* GPS drift 게이지 */}
      <div style={{ marginBottom: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-2)' }}>
          <span>GPS drift {gpsAvail ? '' : '(no fix)'}</span>
          <span style={{ color: driftOver ? 'var(--danger)' : 'var(--text-2)' }}>
            {driftM.toFixed(1)} m / {thresholdM} m
          </span>
        </div>
        <div style={{ width: '100%', height: 6, background: 'var(--border)', borderRadius: 3, marginTop: 4 }}>
          <div style={{
            width: `${driftPct}%`, height: '100%',
            background: driftOver ? 'var(--danger)' : driftPct > 70 ? '#fbbf24' : 'var(--accent)',
            borderRadius: 3, transition: 'width .3s',
          }} />
        </div>
      </div>

      {/* 보조 카운터 — fixes / LIS 헬스 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
        <MiniStat label="GPS fixes" v={fixes} sub={gpsAvail ? 'avail' : 'no fix'} warn={!gpsAvail} />
        <MiniStat label="LIS 가속도계" v={lisOk ? 'OK' : 'FAIL'} sub={`재초기화 ${lisReinits}`} warn={!lisOk} />
        <MiniStat label="모션 경과" v={`${motionAge}s`} sub="마지막 움직임" />
      </div>
    </>
  );
}

function ReceiveStatusBody({ device }) {
  const seenWarn = isStale(device?.last_seen_at);
  const fixWarn  = isFixStale(device?.last_fix_at);
  const lat = device?.last_lat, lng = device?.last_lng;
  const coordStr = (lat != null && lng != null) ? `${lat.toFixed(4)}, ${lng.toFixed(4)}` : '—';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
      <MiniStat label="LTE 통신"   v={ageString(device?.last_seen_at)} sub="마지막 ingest" warn={seenWarn} />
      <MiniStat label="GPS 좌표"   v={ageString(device?.last_fix_at)}  sub="마지막 fix"    warn={fixWarn} />
      <MiniStat label="마지막 위치" v={coordStr}                       sub="lat, lng" />
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

function StatsBody({ stats }) {
  if (!stats?.length) return <Muted>아직 집계된 데이터가 없습니다 (최초 5분 후 반영)</Muted>;
  // 최신 (오늘) + 7일 합계
  const today = stats[0];
  const sum7 = stats.reduce((a, s) => ({
    distance_m: a.distance_m + s.distance_m,
    moving_s:   a.moving_s   + s.moving_s,
    stop_count: a.stop_count + s.stop_count,
    max:        Math.max(a.max, s.max_speed_kmh),
  }), { distance_m: 0, moving_s: 0, stop_count: 0, max: 0 });

  const km = (m) => (m / 1000).toFixed(2);
  const fmtDur = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
        <span>오늘 ({today.date})</span>
        <span>7일 누적</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Stat label="이동거리" today={`${km(today.distance_m)} km`} sum={`${km(sum7.distance_m)} km`} />
        <Stat label="운행시간" today={fmtDur(today.moving_s)}        sum={fmtDur(sum7.moving_s)} />
        <Stat label="정지구간" today={`${today.stop_count}회`}        sum={`${sum7.stop_count}회`} />
        <Stat label="최고속도" today={`${today.max_speed_kmh.toFixed(1)} km/h`} sum={`${sum7.max.toFixed(1)} km/h`} />
      </div>
    </>
  );
}

function Stat({ label, today, sum }) {
  return (
    <div style={{ background: 'var(--surface-2)', borderRadius: 6, padding: 8 }}>
      <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700 }}>{today}</div>
      <div style={{ fontSize: 10, color: 'var(--text-2)' }}>주: {sum}</div>
    </div>
  );
}

// 사용자가 자기 디바이스 SIM 데이터 충전을 신청. 보유 포인트에서 차감.
// 1NCE 충전은 단일 단위 (500MB ~ $15) 고정 — 가격/MB 모두 서버 pricing API 에서 받음.
function SimTopupRequest({ deviceId, simReady }) {
  const [pricing, setPricing] = useState(null);
  const [balance, setBalance] = useState(null);
  const mb = pricing?.topup_mb ?? 500;
  const [busy,    setBusy]    = useState(false);
  const [recent,  setRecent]  = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [p, b, list] = await Promise.all([
          api.simTopupPricing(),
          api.getCreditBalance(),
          api.listMySimRequests(),
        ]);
        if (cancelled) return;
        setPricing(p);
        setBalance(b.balance);
        setRecent((list || []).filter(r => r.device_id === deviceId).slice(0, 3));
      } catch { /* noop */ }
    })();
    return () => { cancelled = true; };
  }, [deviceId]);

  if (!simReady) return null;
  if (!pricing)  return null;

  // 1NCE 정책 — 1회 충전 = 500MB 고정 가격. pricing.topup_cost 가 그대로 비용.
  const cost = pricing.topup_cost;
  const insufficient = balance != null && cost > balance;

  async function submit() {
    const ok = await confirmDialog({
      title: 'SIM 데이터 충전 요청',
      body: `${pricing.topup_mb}MB 충전을 요청합니다.\n${cost.toLocaleString()} 포인트 차감 (잔액 ${balance?.toLocaleString() || '—'} 포인트)`,
      confirmLabel: `${cost.toLocaleString()} 포인트 차감하고 요청`,
      cancelLabel: '닫기',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api.createSimRequest(deviceId, mb);
      setBalance(res.balance);
      const list = await api.listMySimRequests();
      setRecent((list || []).filter(r => r.device_id === deviceId).slice(0, 3));
      await alertDialog({
        title: '요청 완료',
        body: `요청 #${res.request_id} 가 접수됐습니다.\n관리자 승인 후 1NCE 에 충전 적용됩니다.`,
        tone: 'success',
      });
    } catch (e) {
      await alertDialog({ title: '요청 실패', body: e.message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  const STATUS_LABEL = {
    pending: '승인 대기', processing: '처리 중', done: '완료',
    failed: '실패 (환불됨)', cancelled: '취소됨',
  };
  const STATUS_COLOR = {
    pending: 'var(--text-2)', processing: 'var(--primary)', done: 'var(--accent)',
    failed: 'var(--danger)', cancelled: 'var(--text-3)',
  };

  async function refreshAll() {
    try {
      const [b, list] = await Promise.all([
        api.getCreditBalance(),
        api.listMySimRequests(),
      ]);
      setBalance(b.balance);
      setRecent((list || []).filter(r => r.device_id === deviceId).slice(0, 5));
    } catch { /* noop */ }
  }

  return (
    <Section title="SIM 데이터 충전 요청">
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, fontSize: 12,
        color: 'var(--text-2)', marginBottom: 6, flexWrap: 'wrap',
      }}>
        <span>보유: <b style={{ color: 'var(--text)' }}>
          {balance != null ? balance.toLocaleString() : '—'} 포인트
        </b></span>
        <span style={{ color: 'var(--text-3)' }}>·</span>
        <span>1회: <b style={{ color: 'var(--text)' }}>{pricing.topup_mb}MB</b> = {pricing.topup_cost.toLocaleString()} 포인트</span>
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <div style={{
          flex: 1, padding: '8px 10px', fontSize: 13,
          background: 'var(--surface-2)', color: 'var(--text)',
          border: '1px solid var(--border)', borderRadius: 6,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{ fontWeight: 600 }}>{mb} MB</span>
          <span style={{ fontSize: 10, color: 'var(--text-3)' }}>1NCE 정책 고정</span>
        </div>
        <button onClick={submit} disabled={busy || insufficient}
          style={{
            padding: '8px 12px', fontSize: 12, fontWeight: 600,
            background: insufficient ? 'var(--surface-2)' : 'var(--primary)',
            color: insufficient ? 'var(--text-3)' : 'white',
            border: 'none', borderRadius: 6, cursor: insufficient ? 'not-allowed' : 'pointer',
            opacity: busy ? 0.6 : 1, whiteSpace: 'nowrap',
          }}>
          {busy ? '요청 중...' : `${cost.toLocaleString()} 포인트 요청`}
        </button>
      </div>
      {insufficient && (
        <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4 }}>
          포인트가 부족합니다. 내정보 → 포인트 충전을 먼저 진행하세요.
        </div>
      )}

      {recent.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 4 }}>최근 요청</div>
          {recent.map(r => (
            <SimReqRow key={r.id} r={r} STATUS_LABEL={STATUS_LABEL} STATUS_COLOR={STATUS_COLOR}
              onCancelled={refreshAll} />
          ))}
        </div>
      )}
    </Section>
  );
}

// SIM 요청 한 줄 — pending 이면 취소 버튼.
function SimReqRow({ r, STATUS_LABEL, STATUS_COLOR, onCancelled }) {
  const [busy, setBusy] = useState(false);

  async function cancel() {
    const ok = await confirmDialog({
      title: 'SIM 충전 요청 취소',
      body: `요청 #${r.id} (${r.data_mb}MB · ${r.cost_credits.toLocaleString()}원) 을(를) 취소하면 즉시 환불됩니다.`,
      confirmLabel: '취소하고 환불받기',
      cancelLabel: '닫기',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.cancelMySimRequest(r.id);
      onCancelled?.();
    } catch (e) {
      // 409 = 그 사이 관리자가 처리 시작. 새로고침해서 최신 상태 보여줌
      await alertDialog({
        title: '취소 실패',
        body: e.message || '이미 처리가 시작된 요청일 수 있습니다.',
        tone: 'warn',
      });
      onCancelled?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      fontSize: 11, padding: '3px 0', gap: 6,
    }}>
      <span style={{ color: 'var(--text-2)' }}>
        {r.data_mb}MB · {r.cost_credits.toLocaleString()}원
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: STATUS_COLOR[r.status] || 'var(--text-3)' }}>
          {STATUS_LABEL[r.status] || r.status}
        </span>
        {r.status === 'pending' && (
          <button onClick={cancel} disabled={busy}
            style={{
              padding: '2px 6px', fontSize: 10,
              background: 'transparent', color: 'var(--danger)',
              border: '1px solid var(--danger)', borderRadius: 3,
              cursor: 'pointer', opacity: busy ? 0.5 : 1,
            }}>
            {busy ? '...' : '취소'}
          </button>
        )}
      </span>
    </div>
  );
}

function SimBody({ sim: initialSim, deviceId }) {
  // 부모 useSection 의 결과를 시작값으로 받고, 강제 갱신 시 로컬 교체.
  const [sim, setSim] = useState(initialSim);
  const [refreshing, setRefreshing] = useState(false);

  // initialSim 이 바뀌면 (deviceId 변경 등) 동기화
  useEffect(() => { setSim(initialSim); }, [initialSim]);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const fresh = await api.refreshSimInfo(deviceId);
      setSim(fresh);
    } catch (e) {
      alert(`갱신 실패: ${e.message || e}`);
    } finally {
      setRefreshing(false);
    }
  }

  if (!sim) return <Muted>SIM 정보를 불러오지 못했습니다</Muted>;
  if (!sim.configured) return <Muted>1NCE API 자격증명 미설정</Muted>;

  const info = sim.info || {};
  const stats = sim.usage?.stats || [];
  const total = stats.find(s => s.date === 'TOTAL');
  // 오늘 — 1NCE 가 자기 시스템 시각 기준 yyyy-mm-dd 행을 줌. UTC 기준이라 KST 오늘과 약간 어긋날 수 있음.
  const todayKey = new Date().toISOString().slice(0, 10);
  const today = stats.find(s => s.date === todayKey);
  const usedMb  = total ? parseFloat(total.data?.volume || '0') : 0;
  const todayMb = today ? parseFloat(today.data?.volume || '0') : 0;
  const quotaMb = info.current_quota || 0;
  const pct = quotaMb > 0 ? Math.min(100, (usedMb / quotaMb) * 100) : 0;
  const cost = total?.data?.cost ? `${parseFloat(total.data.cost).toFixed(3)} ${total.data.currency?.symbol || ''}` : '—';

  return (
    <>
      <Row k="상태"  v={info.status || '—'} />
      <Row k="번호"  v={info.msisdn || '—'} />
      <Row k="IP"   v={info.ip_address || '—'} />
      <Row k="ICCID" v={sim.iccid || '—'} mono />
      <div style={{ marginTop: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-2)' }}>
          <span>누적 데이터 사용량</span>
          <span>{usedMb.toFixed(2)} / {quotaMb} MB</span>
        </div>
        <div style={{ width: '100%', height: 6, background: 'var(--border)', borderRadius: 3, marginTop: 4 }}>
          <div style={{
            width: `${pct}%`, height: '100%',
            background: pct > 80 ? 'var(--danger)' : pct > 50 ? '#fbbf24' : 'var(--accent)',
            borderRadius: 3, transition: 'width .3s',
          }} />
        </div>
        {/* 오늘 사용량 — 1NCE 가 동일 응답에 일별 행을 주므로 추출 */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', fontSize: 11,
          color: 'var(--text-3)', marginTop: 6,
        }}>
          <span>오늘</span>
          <span>{todayMb.toFixed(2)} MB</span>
        </div>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          fontSize: 10, color: 'var(--text-3)', marginTop: 4, gap: 8,
        }}>
          <span>누적 비용 {cost}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span>갱신: {formatRelativeTime(sim.fetched_at)}</span>
            <button onClick={handleRefresh} disabled={refreshing}
              title="1NCE 직접 호출로 즉시 갱신"
              style={{
                background: 'transparent', border: '1px solid var(--border)',
                color: 'var(--text-2)', borderRadius: 4,
                padding: '2px 7px', fontSize: 10, cursor: refreshing ? 'wait' : 'pointer',
                opacity: refreshing ? 0.5 : 1,
              }}>
              {refreshing ? '갱신 중...' : '↻ 새로고침'}
            </button>
          </span>
        </div>
      </div>
    </>
  );
}

// 갱신 시각을 "방금" / "N분 전" / "N시간 전" / "N일 전" 형식으로.
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

// 비동기 섹션 래퍼 — loading 동안 회색 스켈레톤, error 면 짧은 메시지, 그 외 children(data) 렌더.
function SectionAsync({ title, q, skeletonH = 50, danger, children }) {
  return (
    <Section title={title} danger={danger}>
      {q.loading && (
        <div style={{
          height: skeletonH, borderRadius: 6,
          background: 'linear-gradient(90deg, var(--surface-2) 0%, var(--surface) 50%, var(--surface-2) 100%)',
          backgroundSize: '200% 100%',
          animation: 'shimmer 1.2s infinite',
        }} />
      )}
      {!q.loading && q.error && <Muted>불러오기 실패</Muted>}
      {!q.loading && !q.error && children(q.data)}
    </Section>
  );
}

function Section({ title, children, danger }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{
        fontSize: 11, fontWeight: 'bold',
        color: danger ? 'var(--danger)' : 'var(--text-2)',
        textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4,
      }}>{title}</div>
      {children}
    </div>
  );
}

function Row({ k, v, mono }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0' }}>
      <span style={{ color: 'var(--text-2)' }}>{k}</span>
      <span style={{
        color: 'var(--text)',
        fontFamily: mono ? 'monospace' : 'inherit',
        fontSize: mono ? 11 : 12,
      }}>{v}</span>
    </div>
  );
}

function Muted({ children }) {
  return <div style={{ color: 'var(--text-3)', fontSize: 12, fontStyle: 'italic' }}>{children}</div>;
}
