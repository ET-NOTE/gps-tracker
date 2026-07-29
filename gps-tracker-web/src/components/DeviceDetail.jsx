// (2026-07-29 F8) 트렌디 slim redesign.
//
// 이전엔 통계 + 관리 2 탭에 부팅 진단 · 부저 패턴 · lifecycle 이벤트 · 원격 reset 등
// 펌웨어 진단성 항목 다수 → 일반 사용자에겐 노이즈. 이관 대상은 DeviceDiagnosticPanel
// (DiagnosticPage) 로 옮기고 여기엔 사용자 유효한 것만 남김:
//   · 오늘/이번주 요약 (KPI 카드)
//   · 수신 상태 (LTE · GPS · 안테나 · 마지막 위치)
//   · SIM 데이터 잔량 + 충전 요청
//   · 공유 링크
//   · 위험 영역 (삭제)
// 아래 "고급 진단" 링크 → /diagnostic?device={id}

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import ShareLinkPanel from './ShareLinkPanel';
import Icon from './Icon';
import { confirmDialog, alertDialog } from './Dialog';
import { ageString, isStale, isFixStale } from '../colors';

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

export default function DeviceDetail({ device, onWiped }) {
  const statsQ = useSection(() => api.getDailyStats(device.id, { limit: 7 }), device.id);
  const simQ   = useSection(() => api.getSimInfo(device.id),                   device.id);
  const [wiping, setWiping] = useState(false);

  async function handleWipe() {
    const ok1 = await confirmDialog({
      title: '디바이스 데이터 완전 삭제',
      body: '위치 기록·이벤트를 포함한 모든 데이터를 되돌릴 수 없이 삭제합니다.',
      confirmLabel: '계속',
      cancelLabel: '닫기',
      danger: true,
    });
    if (!ok1) return;
    const ok2 = await confirmDialog({
      title: '한 번 더 확인',
      body: '정말로 삭제하시겠습니까?',
      confirmLabel: '삭제',
      cancelLabel: '닫기',
      danger: true,
    });
    if (!ok2) return;
    setWiping(true);
    try {
      await api.wipeDevice(device.id);
      onWiped?.(device.id);
    } catch (e) {
      await alertDialog({ title: '삭제 실패', body: e.message, tone: 'danger' });
    } finally { setWiping(false); }
  }

  const today = statsQ.data?.[0];

  return (
    <div style={s.shell}>
      {/* KPI 스트립 — 오늘 하이라이트 */}
      <TodayStrip stats={today} device={device} loading={statsQ.loading} />

      <div style={s.body}>
        {/* 수신 상태 */}
        <Section eyebrow="수신 상태">
          <ReceiveStatusBody device={device} />
        </Section>

        {/* 이번주 통계 */}
        <SectionAsync eyebrow="이번주 요약 · 7일 누적" q={statsQ}>
          {(data) => <WeeklyBody stats={data} />}
        </SectionAsync>

        {/* SIM 잔량 + 충전 */}
        <SectionAsync eyebrow="SIM · 데이터" q={simQ}>
          {(data) => <SimBody sim={data} deviceId={device.id} />}
        </SectionAsync>
        <SimTopupRequest deviceId={device.id} simReady={!simQ.loading && simQ.data?.configured} />

        {/* 공유 링크 */}
        <Section eyebrow="공유 링크">
          <ShareLinkPanel deviceId={device.id} />
        </Section>

        {/* 고급 진단 링크 — 이관된 항목들 접근 */}
        <Link to={`/diagnostic?device=${device.id}`} style={s.diagLink}>
          <span style={s.diagLinkLeft}>
            <Icon name="wrench" size={14} />
            <span>고급 진단</span>
          </span>
          <span style={s.diagLinkRight}>
            정지 감지 · 재부팅 패턴 · 원격 부저·reset
            <Icon name="chevron-right" size={14} />
          </span>
        </Link>

        {/* 위험 영역 */}
        <Section eyebrow="위험 영역" tone="danger">
          <button onClick={handleWipe} disabled={wiping} style={s.dangerBtn}>
            <Icon name="trash2" size={13} />
            {wiping ? '삭제 중...' : '디바이스 + 모든 데이터 영구 삭제'}
          </button>
        </Section>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// KPI 스트립 — 3 metric: 오늘 km · 오늘 시간 · 배터리
// ═══════════════════════════════════════════════════════════
function TodayStrip({ stats, device, loading }) {
  const km = stats?.distance_m ? (stats.distance_m / 1000).toFixed(1) : '—';
  const dur = stats?.moving_s ? fmtDur(stats.moving_s) : '—';
  const vbat = device?.last_vbat_mv;
  const vbatV = vbat ? (vbat / 1000).toFixed(2) : '—';
  const vbatWarn = vbat && vbat < 3500;

  return (
    <div style={s.stripe}>
      <div style={s.stripeCell}>
        <div style={s.stripeK}>오늘 이동</div>
        <div style={s.stripeV}>
          {loading ? '···' : km} <span style={s.stripeUnit}>km</span>
        </div>
      </div>
      <div style={s.stripeCell}>
        <div style={s.stripeK}>운행 시간</div>
        <div style={s.stripeV}>
          {loading ? '···' : dur}
        </div>
      </div>
      <div style={s.stripeCell}>
        <div style={s.stripeK}>배터리</div>
        <div style={{ ...s.stripeV, color: vbatWarn ? 'var(--danger)' : 'var(--text)' }}>
          {vbatV} <span style={s.stripeUnit}>V</span>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 수신 상태 — LTE · GPS · 안테나 · 좌표
// ═══════════════════════════════════════════════════════════
function ReceiveStatusBody({ device }) {
  const seenWarn = isStale(device?.last_seen_at);
  const fixWarn  = isFixStale(device?.last_fix_at);
  const lat = device?.last_lat, lng = device?.last_lng;
  const coordStr = (lat != null && lng != null) ? `${lat.toFixed(4)}, ${lng.toFixed(4)}` : '—';
  const isPhone = device?.device_kind === 'phone';
  // (2026-07-29) 폰 tracker device 는 안테나 대신 좌표 넓게 표시.
  //   폰은 antenna / vbat / cbc 필드가 무의미하므로 UI 에서 숨김.
  const ant = device?.last_antenna;
  const antOk   = (ant === 'OK_EXT' || ant === 'OK_INT' || ant === 'OK');
  const antWarn = (ant === 'OPEN' || ant === 'SHORT');
  const ANT_LABEL = { OK_EXT: '외부', OK_INT: '내부', OK: '정상', OPEN: '단선', SHORT: '단락' };
  const antDisplay = ANT_LABEL[ant] || '—';

  return (
    <div style={isPhone ? s.grid3 : s.grid4}>
      <Cell label={isPhone ? '통신' : 'LTE 통신'}
        v={ageString(device?.last_seen_at)} sub="마지막 갱신" warn={seenWarn} />
      <Cell label="GPS 좌표"  v={ageString(device?.last_fix_at)}  sub="마지막 fix"    warn={fixWarn} />
      {!isPhone && (
        <Cell label="안테나"    v={antDisplay}
          sub={antOk ? '정상' : antWarn ? '결선 이상' : '미보고'} warn={antWarn} ok={antOk} />
      )}
      <Cell label="위치"      v={coordStr} sub="lat · lng" mono />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 이번주 요약 — 7일 누적 vs 오늘
// ═══════════════════════════════════════════════════════════
function WeeklyBody({ stats }) {
  if (!stats?.length) return <Muted>아직 집계된 데이터가 없습니다 (최초 5분 후 반영)</Muted>;
  const today = stats[0];
  const sum7 = stats.reduce((a, r) => ({
    distance_m: a.distance_m + r.distance_m,
    moving_s:   a.moving_s   + r.moving_s,
    stop_count: a.stop_count + r.stop_count,
    max:        Math.max(a.max, r.max_speed_kmh),
  }), { distance_m: 0, moving_s: 0, stop_count: 0, max: 0 });

  const km = (m) => (m / 1000).toFixed(2);

  return (
    <div style={s.grid2}>
      <WeekCell label="이동거리" today={`${km(today.distance_m)} km`} week={`${km(sum7.distance_m)} km`} />
      <WeekCell label="운행시간" today={fmtDur(today.moving_s)}        week={fmtDur(sum7.moving_s)} />
      <WeekCell label="정지구간" today={`${today.stop_count}회`}        week={`${sum7.stop_count}회`} />
      <WeekCell label="최고속도" today={`${today.max_speed_kmh.toFixed(1)} km/h`} week={`${sum7.max.toFixed(1)} km/h`} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// SIM 잔량 — 트렌디 요약 (누적 게이지 + 오늘 · 갱신)
// ═══════════════════════════════════════════════════════════
function SimBody({ sim, deviceId }) {
  const [local, setLocal] = useState(sim);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => { setLocal(sim); }, [sim]);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const fresh = await api.refreshSimInfo(deviceId);
      setLocal(fresh);
    } catch (e) {
      await alertDialog({ title: 'SIM 갱신 실패', body: e.message || String(e), tone: 'danger' });
    } finally { setRefreshing(false); }
  }

  if (!local) return <Muted>SIM 정보를 불러오지 못했습니다</Muted>;
  if (!local.configured) return <Muted>1NCE API 자격증명 미설정</Muted>;

  const info = local.info || {};
  const stats = local.usage?.stats || [];
  const total = stats.find(r => r.date === 'TOTAL');
  const todayKey = new Date().toISOString().slice(0, 10);
  const today = stats.find(r => r.date === todayKey);
  const usedMb  = total ? parseFloat(total.data?.volume || '0') : 0;
  const todayMb = today ? parseFloat(today.data?.volume || '0') : 0;
  const quotaMb = info.current_quota || 0;
  const pct = quotaMb > 0 ? Math.min(100, (usedMb / quotaMb) * 100) : 0;
  const barColor = pct > 80 ? 'var(--danger)' : pct > 50 ? '#fbbf24' : 'var(--accent)';

  return (
    <>
      <div style={s.simHead}>
        <div>
          <div style={s.simUsed}>
            {usedMb.toFixed(1)} <span style={s.simUsedUnit}>/ {quotaMb} MB</span>
          </div>
          <div style={s.simMeta}>오늘 {todayMb.toFixed(2)} MB · {info.status || '—'}</div>
        </div>
        <button onClick={handleRefresh} disabled={refreshing} style={s.simRefresh}
          title="1NCE 직접 호출로 즉시 갱신">
          <Icon name="refresh" size={12} />
          {refreshing ? '갱신 중' : '새로고침'}
        </button>
      </div>
      <div style={s.gauge}>
        <div style={{ ...s.gaugeFill, width: `${pct}%`, background: barColor }} />
      </div>
      <div style={s.simFoot}>
        <span>{info.msisdn || '—'}</span>
        <span style={s.mono}>{local.iccid || '—'}</span>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// SIM 충전 — 원본 유지 (사용자 flow, 트렌디 wrapper 만)
// ═══════════════════════════════════════════════════════════
function SimTopupRequest({ deviceId, simReady }) {
  const [pricing, setPricing] = useState(null);
  const [balance, setBalance] = useState(null);
  const [busy,    setBusy]    = useState(false);
  const [recent,  setRecent]  = useState([]);
  const mb = pricing?.topup_mb ?? 500;

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
        setPricing(p); setBalance(b.balance);
        setRecent((list || []).filter(r => r.device_id === deviceId).slice(0, 3));
      } catch { /* noop */ }
    })();
    return () => { cancelled = true; };
  }, [deviceId]);

  if (!simReady || !pricing) return null;
  const cost = pricing.topup_cost;
  const insufficient = balance != null && cost > balance;

  async function submit() {
    const ok = await confirmDialog({
      title: 'SIM 데이터 충전 요청',
      body: `${pricing.topup_mb}MB 충전을 요청합니다.\n${cost.toLocaleString()} 포인트 차감 (잔액 ${balance?.toLocaleString() || '—'} 포인트)`,
      confirmLabel: `${cost.toLocaleString()} 포인트 요청`,
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
    } finally { setBusy(false); }
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
      const [b, list] = await Promise.all([api.getCreditBalance(), api.listMySimRequests()]);
      setBalance(b.balance);
      setRecent((list || []).filter(r => r.device_id === deviceId).slice(0, 5));
    } catch { /* noop */ }
  }

  return (
    <Section eyebrow="SIM 충전 요청">
      <div style={s.topupHead}>
        <span>보유 <b style={{ color: 'var(--text)' }}>{balance != null ? balance.toLocaleString() : '—'}</b> 포인트</span>
        <span style={s.topupSep}>·</span>
        <span>1회 <b style={{ color: 'var(--text)' }}>{pricing.topup_mb}MB</b> = {pricing.topup_cost.toLocaleString()} 포인트</span>
      </div>
      <button onClick={submit} disabled={busy || insufficient} style={{
        ...s.topupBtn,
        background: insufficient ? 'var(--surface-2)' : 'var(--primary)',
        color:      insufficient ? 'var(--text-3)' : 'white',
        cursor:     insufficient ? 'not-allowed' : 'pointer',
        opacity: busy ? 0.6 : 1,
      }}>
        {busy ? '요청 중...' : `${mb}MB 충전 · ${cost.toLocaleString()} 포인트 요청`}
      </button>
      {insufficient && (
        <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 6 }}>
          포인트 부족. 내정보 → 포인트 충전 먼저.
        </div>
      )}
      {recent.length > 0 && (
        <div style={{ marginTop: 10 }}>
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
    try { await api.cancelMySimRequest(r.id); onCancelled?.(); }
    catch (e) {
      await alertDialog({ title: '취소 실패', body: e.message || '이미 처리가 시작된 요청일 수 있습니다.', tone: 'warn' });
      onCancelled?.();
    } finally { setBusy(false); }
  }
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, padding: '3px 0', gap: 6 }}>
      <span style={{ color: 'var(--text-2)' }}>{r.data_mb}MB · {r.cost_credits.toLocaleString()}원</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: STATUS_COLOR[r.status] || 'var(--text-3)' }}>{STATUS_LABEL[r.status] || r.status}</span>
        {r.status === 'pending' && (
          <button onClick={cancel} disabled={busy} style={{
            padding: '2px 6px', fontSize: 10,
            background: 'transparent', color: 'var(--danger)',
            border: '1px solid var(--danger)', borderRadius: 3,
            cursor: 'pointer', opacity: busy ? 0.5 : 1,
          }}>{busy ? '...' : '취소'}</button>
        )}
      </span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 프리미티브 — 트렌디 layout
// ═══════════════════════════════════════════════════════════
function Section({ eyebrow, tone, children }) {
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{
        fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
        fontSize: 10.5, fontWeight: 500,
        color: tone === 'danger' ? 'var(--danger)' : 'var(--text-2)',
        textTransform: 'uppercase', letterSpacing: '0.11em',
        marginBottom: 8,
      }}>{eyebrow}</div>
      {children}
    </div>
  );
}

function SectionAsync({ eyebrow, q, children }) {
  return (
    <Section eyebrow={eyebrow}>
      {q.loading && <div style={s.skeleton} />}
      {!q.loading && q.error && <Muted>불러오기 실패</Muted>}
      {!q.loading && !q.error && children(q.data)}
    </Section>
  );
}

function Cell({ label, v, sub, warn, ok, mono }) {
  return (
    <div style={{
      background: 'var(--surface-2)',
      borderRadius: 6, padding: '8px 10px',
      borderLeft: warn ? '3px solid var(--danger)' : ok ? '3px solid var(--accent)' : '3px solid transparent',
    }}>
      <div style={{ fontSize: 10, color: 'var(--text-3)', letterSpacing: '0.02em' }}>{label}</div>
      <div style={{
        fontSize: mono ? 12 : 13, fontWeight: 600,
        color: warn ? 'var(--danger)' : 'var(--text)',
        fontFamily: mono ? 'ui-monospace, Menlo, Consolas, monospace' : 'inherit',
        marginTop: 2,
      }}>{v}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function WeekCell({ label, today, week }) {
  return (
    <div style={{ background: 'var(--surface-2)', borderRadius: 6, padding: '10px 12px' }}>
      <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{today}</span>
        <span style={{ fontSize: 10, color: 'var(--text-3)' }}>오늘</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 2 }}>
        <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{week}</span>
        <span style={{ fontSize: 10, color: 'var(--text-3)' }}>7일</span>
      </div>
    </div>
  );
}

function Muted({ children }) {
  return <div style={{ color: 'var(--text-3)', fontSize: 12, fontStyle: 'italic' }}>{children}</div>;
}

function fmtDur(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ═══════════════════════════════════════════════════════════
// styles
// ═══════════════════════════════════════════════════════════
const s = {
  shell: {
    marginTop: 8, borderRadius: 8,
    background: 'var(--surface)', border: '1px solid var(--border)',
    overflow: 'hidden',
  },
  body: { padding: '12px 14px 14px' },

  stripe: {
    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
    background: 'linear-gradient(180deg, var(--surface-2), var(--surface))',
    borderBottom: '1px solid var(--border)',
  },
  stripeCell: {
    padding: '12px 14px',
    borderLeft: '1px solid var(--border)',
  },
  stripeK: {
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    fontSize: 10, letterSpacing: '0.08em',
    color: 'var(--text-3)', textTransform: 'uppercase',
    marginBottom: 4,
  },
  stripeV: {
    fontSize: 20, fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--text)', lineHeight: 1,
  },
  stripeUnit: {
    fontSize: 12, fontWeight: 400,
    color: 'var(--text-3)', marginLeft: 2,
  },

  grid4: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6 },
  grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },

  simHead: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
    marginBottom: 8, gap: 12,
  },
  simUsed: { fontSize: 20, fontWeight: 600, color: 'var(--text)', fontVariantNumeric: 'tabular-nums', lineHeight: 1 },
  simUsedUnit: { fontSize: 12, fontWeight: 400, color: 'var(--text-3)' },
  simMeta: { fontSize: 11, color: 'var(--text-2)', marginTop: 4 },
  simRefresh: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '4px 8px', fontSize: 10.5, fontWeight: 500,
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 4,
    cursor: 'pointer', whiteSpace: 'nowrap',
  },
  gauge: {
    width: '100%', height: 6, background: 'var(--border)',
    borderRadius: 3, overflow: 'hidden',
  },
  gaugeFill: { height: '100%', transition: 'width .3s' },
  simFoot: {
    display: 'flex', justifyContent: 'space-between',
    fontSize: 10.5, color: 'var(--text-3)', marginTop: 6,
  },
  mono: { fontFamily: 'ui-monospace, Menlo, Consolas, monospace' },

  topupHead: {
    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
    fontSize: 11.5, color: 'var(--text-2)', marginBottom: 8,
  },
  topupSep: { color: 'var(--text-3)' },
  topupBtn: {
    width: '100%', padding: 10,
    border: 'none', borderRadius: 6,
    fontSize: 12.5, fontWeight: 600,
    letterSpacing: 0.1,
  },

  diagLink: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px 14px', marginTop: 18,
    background: 'var(--surface-2)',
    border: '1px solid var(--border)', borderRadius: 6,
    fontSize: 12, color: 'var(--text)',
    textDecoration: 'none',
    transition: 'background .12s',
  },
  diagLinkLeft: { display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 600 },
  diagLinkRight: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    fontSize: 11, color: 'var(--text-3)', fontWeight: 400,
  },

  dangerBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    width: '100%', padding: 9,
    background: 'transparent', color: 'var(--danger)',
    border: '1px solid var(--danger)', borderRadius: 6,
    cursor: 'pointer', fontSize: 12, fontWeight: 600,
  },

  skeleton: {
    height: 70, borderRadius: 6,
    background: 'linear-gradient(90deg, var(--surface-2) 0%, var(--surface) 50%, var(--surface-2) 100%)',
    backgroundSize: '200% 100%',
    animation: 'shimmer 1.2s infinite',
  },
};
