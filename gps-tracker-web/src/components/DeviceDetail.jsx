// 디바이스 카드 하단에 펼쳐지는 상세 패널 — B 스타일: 다크 헤더 + 섹션 카드.
import { useState, useEffect } from 'react';
import { api } from '../api';
import ShareLinkPanel from './ShareLinkPanel';
import Icon from './Icon';
import { confirmDialog, alertDialog } from './Dialog';
import { ageString } from '../colors';

const KIND_META = {
  pair:         { icon: 'link',   label: '페어링' },
  unpair:       { icon: 'unlink', label: '해제' },
  sim_swap:     { icon: 'swap',   label: 'SIM 모뎀 이동' },
  modem_swap:   { icon: 'wrench', label: '모뎀 교체' },
  wipe:         { icon: 'trash2', label: '완전 삭제' },
  owner_change: { icon: 'user',   label: '소유자 변경' },
};

function useSection(loader, deviceId) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, data: null, error: null });
    loader()
      .then(d => { if (!cancelled) setState({ loading: false, data: d, error: null }); })
      .catch(e => { if (!cancelled) setState({ loading: false, data: null, error: e }); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);
  return state;
}

export default function DeviceDetail({ device, onWiped, deviceColor, deviceMeta, deviceStatus }) {
  const statsQ  = useSection(() => api.getDailyStats(device.id, { limit: 7 }), device.id);
  const eventsQ = useSection(() => api.getDeviceEvents(device.id),             device.id);
  const auditQ  = useSection(() => api.getAuditLog(device.id),                 device.id);
  const simQ    = useSection(() => api.getSimInfo(device.id),                  device.id);

  const [tab, setTab] = useState('stats');
  const [wiping, setWiping] = useState(false);

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

  const name = device.display_name || device.device_uid;

  return (
    <div style={dt.shell}>
      {/* ── 다크 헤더 ── */}
      <div style={dt.head}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
          {deviceColor && (
            <span style={{ width: 10, height: 10, borderRadius: 5, background: deviceColor, flexShrink: 0 }} />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={dt.headName}>{name}</div>
            <div style={dt.headMeta}>
              <Icon name="refresh" size={10} />
              {' '}{ageString(device.last_seen_at)}
              {deviceMeta?.vbatMv && <> · <Icon name="battery" size={10} /> {deviceMeta.vbatMv}mV</>}
              {deviceMeta?.sat != null && <> · sat {deviceMeta.sat}</>}
            </div>
          </div>
        </div>
        {deviceStatus && (
          <span style={{
            fontSize: 10, fontWeight: 600, padding: '3px 9px', borderRadius: 99,
            background: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.9)',
            flexShrink: 0,
          }}>
            {deviceStatus.label}
          </span>
        )}
      </div>

      {/* ── 탭 ── */}
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
            <SectionAsync title="운행 통계" q={statsQ} skeletonH={70}>
              {(data) => <StatsBody stats={data} />}
            </SectionAsync>
            <Section title="정지 감지 / Deep Sleep">
              <StationaryBody s={device.last_stationary} />
            </Section>
            <SectionAsync title="동작 이력" q={eventsQ} skeletonH={50}>
              {(data) => <LifecycleBody events={data} />}
            </SectionAsync>
          </>
        )}

        {tab === 'manage' && (
          <>
            <SectionAsync title="SIM 정보" q={simQ} skeletonH={80}>
              {(data) => <SimBody sim={data} deviceId={device.id} />}
            </SectionAsync>
            <SimTopupRequest deviceId={device.id} simReady={!simQ.loading && simQ.data?.configured} />
            <ShareLinkPanel deviceId={device.id} />
            <SectionAsync title="페어링 이력" q={auditQ} skeletonH={40}>
              {(data) => <AuditBody audit={data} />}
            </SectionAsync>
            <Section title="위험 영역" danger>
              <button onClick={handleWipe} disabled={wiping}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  width: '100%', padding: 9,
                  background: 'transparent', color: 'var(--danger)',
                  border: '1px solid var(--danger)', borderRadius: 8,
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

const INDIGO = '#4f46e5';

const dt = {
  shell: {
    marginTop: 10,
    borderRadius: 14,
    overflow: 'hidden',
    border: '0.5px solid var(--border)',
  },
  head: {
    background: '#1e1b4b',
    padding: '12px 14px',
    display: 'flex', alignItems: 'center', gap: 8,
  },
  headName: {
    fontSize: 14, fontWeight: 600, color: 'white',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  headMeta: {
    fontSize: 11, color: 'rgba(255,255,255,0.55)', marginTop: 2,
    display: 'inline-flex', alignItems: 'center', gap: 3, flexWrap: 'wrap',
  },
  tabs: {
    display: 'flex',
    background: 'var(--surface)',
    borderBottom: '1px solid var(--border)',
  },
  tab: {
    flex: 1,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: '10px 0',
    background: 'transparent', color: 'var(--text-3)',
    border: 'none', borderBottom: '2px solid transparent',
    cursor: 'pointer', fontSize: 12, fontWeight: 500,
    transition: 'color .15s, border-color .15s',
  },
  tabOn: {
    background: '#eef2ff',
    color: INDIGO,
    borderBottomColor: INDIGO,
    fontWeight: 600,
  },
  body: {
    padding: 12,
    background: 'var(--surface)',
  },
};

function AuditBody({ audit }) {
  if (!audit?.length) return <Muted>이력 없음</Muted>;
  return (
    <>
      {audit.slice(0, 5).map(e => {
        const meta = KIND_META[e.event_type];
        return (
          <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, padding: '5px 0', borderBottom: '1px solid var(--border)', color: 'var(--text)' }}>
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
  sleep_enter:    { label: '잠듦',       color: INDIGO },
  low_batt:       { label: '저전압',     color: '#f87171' },
  offline:        { label: '오프라인',   color: 'var(--danger)' },
  online:         { label: '복구',       color: 'var(--accent)' },
  geofence_in:    { label: '펜스 진입',  color: 'var(--accent)' },
  geofence_out:   { label: '펜스 이탈',  color: 'var(--danger)' },
  geofence_armed: { label: '펜스 활성화', color: 'var(--text-2)' },
};

function eventRow(e) {
  const meta = LIFECYCLE_KIND[e.kind] || { label: e.kind, color: 'var(--text-2)' };
  const reason = e.data?.sleep_reason || e.data?.wake_cause;
  return (
    <div key={e.id} style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      fontSize: 12, padding: '6px 0',
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

function LifecycleBody({ events }) {
  const [showAll, setShowAll] = useState(false);
  if (!events?.length) return <Muted>아직 sleep/wake 이벤트 기록이 없습니다.</Muted>;

  const latestWake = events.find(e => e.kind === 'wake' && e.data?.diag);
  const diag = latestWake?.data?.diag;
  const more = Math.max(0, events.length - 5);

  return (
    <>
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
          marginTop: 8, padding: '7px 10px', width: '100%',
          background: '#eef2ff', color: INDIGO,
          border: `1px solid ${INDIGO}44`, borderRadius: 8,
          fontSize: 12, fontWeight: 600, cursor: 'pointer',
        }}>
          전체 보기 ({events.length}건)
        </button>
      )}
      {showAll && <EventListModal events={events} onClose={() => setShowAll(false)} />}
    </>
  );
}

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
        borderRadius: 14, overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0,
          background: '#1e1b4b',
        }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: 'white' }}>동작 이력 ({events.length}건)</div>
          <button onClick={onClose} style={{
            background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 6,
            padding: '4px 10px', cursor: 'pointer', color: 'white', fontSize: 12,
          }}>닫기</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '0 16px' }}>
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
      background: warn ? '#fef2f2' : 'var(--surface-2)',
      borderRadius: 8, padding: '7px 8px',
      border: warn ? '1px solid #fca5a5' : '1px solid var(--border)',
    }}>
      <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: warn ? '#dc2626' : 'var(--text)' }}>{v}</div>
    </div>
  );
}

function StationaryBody({ s }) {
  if (!s) return <Muted>아직 stationary 진단 데이터가 없습니다 (펌웨어 13_1 이상 필요)</Muted>;

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
    ? (sleepInS === 0 ? 'var(--accent)' : INDIGO)
    : 'var(--text-2)';

  return (
    <div style={{ background: '#eef2ff', border: `1px solid ${INDIGO}33`, borderRadius: 10, padding: '10px 12px' }}>
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
        <div style={{ width: '100%', height: 5, background: `${INDIGO}22`, borderRadius: 3, marginTop: 4 }}>
          <div style={{ width: `${heldPct}%`, height: '100%', background: active ? INDIGO : 'var(--text-3)', borderRadius: 3, transition: 'width .3s' }} />
        </div>
      </div>

      <div style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-2)' }}>
          <span>GPS drift {gpsAvail ? '' : '(no fix)'}</span>
          <span style={{ color: driftOver ? 'var(--danger)' : 'var(--text-2)' }}>{driftM.toFixed(1)} m / {thresholdM} m</span>
        </div>
        <div style={{ width: '100%', height: 5, background: `${INDIGO}22`, borderRadius: 3, marginTop: 4 }}>
          <div style={{ width: `${driftPct}%`, height: '100%', background: driftOver ? 'var(--danger)' : driftPct > 70 ? '#fbbf24' : 'var(--accent)', borderRadius: 3, transition: 'width .3s' }} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
        <MiniStat label="GPS fixes" v={fixes} sub={gpsAvail ? 'avail' : 'no fix'} warn={!gpsAvail} />
        <MiniStat label="LIS 가속도계" v={lisOk ? 'OK' : 'FAIL'} sub={`재초기화 ${lisReinits}`} warn={!lisOk} />
        <MiniStat label="모션 경과" v={`${motionAge}s`} sub="마지막 움직임" />
      </div>
    </div>
  );
}

function MiniStat({ label, v, sub, warn }) {
  return (
    <div style={{
      background: warn ? '#fef2f2' : 'rgba(255,255,255,0.7)',
      borderRadius: 8, padding: '6px 8px',
      border: warn ? '1px solid #fca5a5' : '1px solid rgba(99,102,241,0.15)',
    }}>
      <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: warn ? '#dc2626' : 'var(--text)' }}>{v}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function StatsBody({ stats }) {
  if (!stats?.length) return <Muted>아직 집계된 데이터가 없습니다 (최초 5분 후 반영)</Muted>;
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
    <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>{today}</div>
      <div style={{ fontSize: 10, color: 'var(--text-2)', marginTop: 2 }}>주: {sum}</div>
    </div>
  );
}

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
      await alertDialog({ title: '요청 완료', body: `요청 #${res.request_id} 가 접수됐습니다.\n관리자 승인 후 1NCE 에 충전 적용됩니다.`, tone: 'success' });
    } catch (e) {
      await alertDialog({ title: '요청 실패', body: e.message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  const STATUS_LABEL = { pending: '승인 대기', processing: '처리 중', done: '완료', failed: '실패 (환불됨)', cancelled: '취소됨' };
  const STATUS_COLOR = { pending: 'var(--text-2)', processing: INDIGO, done: 'var(--accent)', failed: 'var(--danger)', cancelled: 'var(--text-3)' };

  async function refreshAll() {
    try {
      const [b, list] = await Promise.all([api.getCreditBalance(), api.listMySimRequests()]);
      setBalance(b.balance);
      setRecent((list || []).filter(r => r.device_id === deviceId).slice(0, 5));
    } catch { /* noop */ }
  }

  return (
    <Section title="SIM 데이터 충전 요청">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-2)', marginBottom: 6, flexWrap: 'wrap' }}>
        <span>보유: <b style={{ color: 'var(--text)' }}>{balance != null ? balance.toLocaleString() : '—'} 포인트</b></span>
        <span style={{ color: 'var(--text-3)' }}>·</span>
        <span>1회: <b style={{ color: 'var(--text)' }}>{pricing.topup_mb}MB</b> = {pricing.topup_cost.toLocaleString()} 포인트</span>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <div style={{ flex: 1, padding: '8px 10px', fontSize: 13, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600 }}>{mb} MB</span>
          <span style={{ fontSize: 10, color: 'var(--text-3)' }}>1NCE 정책 고정</span>
        </div>
        <button onClick={submit} disabled={busy || insufficient}
          style={{ padding: '8px 12px', fontSize: 12, fontWeight: 600, background: insufficient ? 'var(--surface-2)' : INDIGO, color: insufficient ? 'var(--text-3)' : 'white', border: 'none', borderRadius: 8, cursor: insufficient ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1, whiteSpace: 'nowrap' }}>
          {busy ? '요청 중...' : `${cost.toLocaleString()} 포인트 요청`}
        </button>
      </div>
      {insufficient && <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4 }}>포인트가 부족합니다. 내정보 → 포인트 충전을 먼저 진행하세요.</div>}
      {recent.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 4 }}>최근 요청</div>
          {recent.map(r => <SimReqRow key={r.id} r={r} STATUS_LABEL={STATUS_LABEL} STATUS_COLOR={STATUS_COLOR} onCancelled={refreshAll} />)}
        </div>
      )}
    </Section>
  );
}

function SimReqRow({ r, STATUS_LABEL, STATUS_COLOR, onCancelled }) {
  const [busy, setBusy] = useState(false);
  async function cancel() {
    const ok = await confirmDialog({ title: 'SIM 충전 요청 취소', body: `요청 #${r.id} (${r.data_mb}MB · ${r.cost_credits.toLocaleString()}원) 을(를) 취소하면 즉시 환불됩니다.`, confirmLabel: '취소하고 환불받기', cancelLabel: '닫기', danger: true });
    if (!ok) return;
    setBusy(true);
    try { await api.cancelMySimRequest(r.id); onCancelled?.(); }
    catch (e) { await alertDialog({ title: '취소 실패', body: e.message || '이미 처리가 시작된 요청일 수 있습니다.', tone: 'warn' }); onCancelled?.(); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, padding: '3px 0', gap: 6 }}>
      <span style={{ color: 'var(--text-2)' }}>{r.data_mb}MB · {r.cost_credits.toLocaleString()}원</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: STATUS_COLOR[r.status] || 'var(--text-3)' }}>{STATUS_LABEL[r.status] || r.status}</span>
        {r.status === 'pending' && (
          <button onClick={cancel} disabled={busy} style={{ padding: '2px 6px', fontSize: 10, background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 4, cursor: 'pointer', opacity: busy ? 0.5 : 1 }}>
            {busy ? '...' : '취소'}
          </button>
        )}
      </span>
    </div>
  );
}

function SimBody({ sim: initialSim, deviceId }) {
  const [sim, setSim] = useState(initialSim);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => { setSim(initialSim); }, [initialSim]);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try { setSim(await api.refreshSimInfo(deviceId)); }
    catch (e) { alert(`갱신 실패: ${e.message || e}`); }
    finally { setRefreshing(false); }
  }

  if (!sim) return <Muted>SIM 정보를 불러오지 못했습니다</Muted>;
  if (!sim.configured) return <Muted>1NCE API 자격증명 미설정</Muted>;

  const info  = sim.info || {};
  const stats = sim.usage?.stats || [];
  const total = stats.find(s => s.date === 'TOTAL');
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
          <span>누적 데이터 사용량</span><span>{usedMb.toFixed(2)} / {quotaMb} MB</span>
        </div>
        <div style={{ width: '100%', height: 5, background: 'var(--border)', borderRadius: 3, marginTop: 4 }}>
          <div style={{ width: `${pct}%`, height: '100%', background: pct > 80 ? 'var(--danger)' : pct > 50 ? '#fbbf24' : 'var(--accent)', borderRadius: 3, transition: 'width .3s' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
          <span>오늘</span><span>{todayMb.toFixed(2)} MB</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, color: 'var(--text-3)', marginTop: 4, gap: 8 }}>
          <span>누적 비용 {cost}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span>갱신: {formatRelativeTime(sim.fetched_at)}</span>
            <button onClick={handleRefresh} disabled={refreshing} title="1NCE 직접 호출로 즉시 갱신"
              style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-2)', borderRadius: 4, padding: '2px 7px', fontSize: 10, cursor: refreshing ? 'wait' : 'pointer', opacity: refreshing ? 0.5 : 1 }}>
              {refreshing ? '갱신 중...' : '↻ 새로고침'}
            </button>
          </span>
        </div>
      </div>
    </>
  );
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
  return `${Math.floor(hr / 24)}일 전`;
}

function SectionAsync({ title, q, skeletonH = 50, danger, children }) {
  return (
    <Section title={title} danger={danger}>
      {q.loading && (
        <div style={{ height: skeletonH, borderRadius: 8, background: 'linear-gradient(90deg, var(--surface-2) 0%, var(--surface) 50%, var(--surface-2) 100%)', backgroundSize: '200% 100%', animation: 'shimmer 1.2s infinite' }} />
      )}
      {!q.loading && q.error && <Muted>불러오기 실패</Muted>}
      {!q.loading && !q.error && children(q.data)}
    </Section>
  );
}

function Section({ title, children, danger }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: danger ? 'var(--danger)' : 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function Row({ k, v, mono }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ color: 'var(--text-2)' }}>{k}</span>
      <span style={{ color: 'var(--text)', fontFamily: mono ? 'monospace' : 'inherit', fontSize: mono ? 11 : 12 }}>{v}</span>
    </div>
  );
}

function Muted({ children }) {
  return <div style={{ color: 'var(--text-3)', fontSize: 12, fontStyle: 'italic' }}>{children}</div>;
}
