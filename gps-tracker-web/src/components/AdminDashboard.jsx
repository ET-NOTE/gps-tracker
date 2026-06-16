// 관리자 대시보드 — role='admin' 전용. 본문 전체 차지 (지도 안 보임).
// 서브탭: 사용자 / 장치 — 향후 통계·시스템 등 확장 예정.
import { useEffect, useRef, useState } from 'react';
import { api, setTokens } from '../api';
import Icon from './Icon';
import { confirmDialog, alertDialog, promptDialog } from './Dialog';

const NCE_PORTAL = 'https://portal.1nce.com';

// 1NCE 콘솔: 브라우저는 새 탭, Flutter 앱은 인앱 WebView.
function openNcePortal() {
  if (window.FlutterAppOpenUrl?.postMessage) {
    window.FlutterAppOpenUrl.postMessage(NCE_PORTAL);
    return;
  }
  window.open(NCE_PORTAL, '_blank', 'noopener,noreferrer');
}

const SUBTABS = [
  { id: 'users',       label: '사용자',     icon: 'user' },
  { id: 'devices',     label: '장치',       icon: 'list' },
  { id: 'credit_reqs', label: '포인트 요청', icon: 'coin' },
  { id: 'sim_reqs',    label: 'SIM 요청',   icon: 'spark' },
  { id: 'payments',    label: '결제 내역',   icon: 'bar' },
  { id: 'chat',        label: '채팅',       icon: 'message' },
];

function initialAdminSubTab() {
  if (typeof window === 'undefined') return 'users';
  const v = localStorage.getItem('admin_subtab');
  return SUBTABS.some(t => t.id === v) ? v : 'users';
}

export default function AdminDashboard() {
  const [subTab, setSubTabRaw] = useState(initialAdminSubTab);
  const setSubTab = (v) => { setSubTabRaw(v); try { localStorage.setItem('admin_subtab', v); } catch {} };

  return (
    <div style={s.root}>
      {/* 헤더 */}
      <header style={s.appHeader}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Icon name="wrench" size={16} style={{ color: 'var(--primary)' }} />
          <span style={{ fontSize: 14, fontWeight: 700 }}>관리자 콘솔</span>
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>god mode · audit logged</span>
      </header>

      {/* 서브탭 */}
      <div style={s.subtabs}>
        {SUBTABS.map(t => {
          const on = subTab === t.id;
          return (
            <button key={t.id} onClick={() => setSubTab(t.id)} style={{
              ...s.subtab, ...(on ? s.subtabOn : null),
            }}>
              <Icon name={t.icon} size={14} />
              {t.label}
            </button>
          );
        })}
      </div>

      <div style={s.body}>
        {subTab === 'users'       && <UsersTab />}
        {subTab === 'devices'     && <DevicesTab />}
        {subTab === 'credit_reqs' && <CreditRequestsTab />}
        {subTab === 'sim_reqs'    && <SimRequestsTab />}
        {subTab === 'payments'    && <PaymentsTab />}
        {subTab === 'chat'        && <ChatAdminTab />}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// 포인트 충전 요청 탭
// ════════════════════════════════════════════════════════════
function CreditRequestsTab() {
  const [list, setList]     = useState(null);
  const [error, setError]   = useState(null);
  const [busy, setBusy]     = useState(null);
  const [filter, setFilter] = useState('pending');
  const [search, setSearch] = useState('');

  async function load() {
    try {
      const v = await api.adminListCreditReqs();
      setList(v || []);
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); const iv = setInterval(load, 15_000); return () => clearInterval(iv); }, []);

  async function approve(id, amount, email) {
    const ok = await confirmDialog({
      title: '포인트 충전 승인',
      body: `요청 #${id}\n${email || ''}\n${amount.toLocaleString()}원을 사용자 잔액에 추가합니다.`,
      confirmLabel: `${amount.toLocaleString()}원 승인`,
      tone: 'success',
    });
    if (!ok) return;
    setBusy(`a-${id}`);
    try {
      await api.adminApproveCreditReq(id);
      load();
    } catch (e) {
      await alertDialog({ title: '승인 실패', body: e.message, tone: 'danger' });
    }
    finally { setBusy(null); }
  }
  async function reject(id, email) {
    const reason = await promptDialog({
      title: '포인트 충전 반려',
      body: `요청 #${id}\n${email || ''}\n반려 사유를 입력하세요 (선택, 사용자에게 채팅으로 전달됨)`,
      placeholder: '예: 입금 확인 안 됨',
      confirmLabel: '반려',
      multiline: true,
      tone: 'danger',
    });
    if (reason === null) return;
    setBusy(`r-${id}`);
    try {
      await api.adminRejectCreditReq(id, reason || null);
      load();
    } catch (e) {
      await alertDialog({ title: '반려 실패', body: e.message, tone: 'danger' });
    }
    finally { setBusy(null); }
  }

  if (error) return <div style={s.empty}>{error}</div>;
  if (!list) return <div style={s.empty}>로딩...</div>;

  const STATUS_LABEL = {
    pending: '대기', approved: '승인', rejected: '반려', cancelled: '취소',
  };
  const STATUS_COLOR = {
    pending: 'var(--warning, #fbbf24)',
    approved: 'var(--accent)',
    rejected: 'var(--danger)',
    cancelled: 'var(--text-3)',
  };
  const sterm = search.trim().toLowerCase();
  const filtered = list
    .filter(r => filter === 'all' || r.status === filter)
    .filter(r => !sterm
      || (r.user_email   || '').toLowerCase().includes(sterm)
      || (r.user_display || '').toLowerCase().includes(sterm)
      || (r.note         || '').toLowerCase().includes(sterm));

  return (
    <div style={s.viewWrap}>
      <div style={s.toolRow}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {['pending', 'approved', 'rejected', 'cancelled', 'all'].map(f => (
            <button key={f} onClick={() => setFilter(f)}
              style={{
                ...s.subtab,
                ...(filter === f ? s.subtabOn : null),
                padding: '5px 10px', fontSize: 11,
              }}>
              {STATUS_LABEL[f] || '전체'}
              {f !== 'all' && (
                <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.7 }}>
                  ({list.filter(r => r.status === f).length})
                </span>
              )}
            </button>
          ))}
        </div>
        <input placeholder="이메일/이름/메모 검색"
          value={search} onChange={e => setSearch(e.target.value)}
          style={{ ...s.input, maxWidth: 240 }} />
        <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 'auto' }}>
          {filtered.length} 건 (15초 자동 새로고침)
        </span>
      </div>

      <div style={s.table}>
        <div style={s.tableHead}>
          <span style={{ width: 50 }}>ID</span>
          <span style={{ flex: 2 }}>요청자</span>
          <span style={{ width: 110 }}>금액</span>
          <span style={{ flex: 1.5 }}>메모</span>
          <span style={{ width: 80 }}>상태</span>
          <span style={{ width: 110 }}>요청 시각</span>
          <span style={{ width: 200 }}>액션</span>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {filtered.length === 0 && <div style={s.emptyInline}>해당 항목 없음</div>}
          {filtered.map(r => (
            <div key={r.id} style={{ ...s.tableRow, cursor: 'default' }}>
              <span style={{ width: 50, fontFamily: 'monospace', color: 'var(--text-3)' }}>#{r.id}</span>
              <span style={{ flex: 2, minWidth: 0,
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <div style={{ fontWeight: 600 }}>{r.user_email || `uid:${r.user_id}`}</div>
                {r.user_display && (
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{r.user_display}</div>
                )}
              </span>
              <span style={{ width: 110, fontWeight: 700, fontSize: 14 }}>
                {r.amount.toLocaleString()}<span style={{ fontSize: 10, color: 'var(--text-3)', marginLeft: 2 }}>원</span>
              </span>
              <span style={{ flex: 1.5, fontSize: 11, color: 'var(--text-2)',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.note || '—'}
              </span>
              <span style={{ width: 80, fontSize: 11 }}>
                <div style={{ color: STATUS_COLOR[r.status], fontWeight: 600 }}>
                  {STATUS_LABEL[r.status] || r.status}
                </div>
                {r.status === 'cancelled' && r.cancelled_by_user && (
                  <div style={{ fontSize: 9, color: 'var(--text-3)' }}>유저 취소</div>
                )}
              </span>
              <span style={{ width: 110, fontSize: 11, color: 'var(--text-3)' }}>
                {fmtAge(r.requested_at)}
              </span>
              <span style={{ width: 200, display: 'flex', gap: 4 }}>
                {r.status === 'pending' && (
                  <>
                    <button onClick={() => approve(r.id, r.amount, r.user_email)}
                      disabled={busy === `a-${r.id}`}
                      style={{ ...s.topupBtn, padding: '4px 8px' }}>
                      {busy === `a-${r.id}` ? '...' : '승인'}
                    </button>
                    <button onClick={() => reject(r.id, r.user_email)}
                      disabled={busy === `r-${r.id}`}
                      style={{ ...s.nceBtn, padding: '4px 8px',
                                borderColor: 'var(--danger)', color: 'var(--danger)' }}>
                      {busy === `r-${r.id}` ? '...' : '반려'}
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// SIM 충전 요청 탭
// ════════════════════════════════════════════════════════════
// 1NCE 포털 SIM 상세 URL — iccid 19자리 사용 (canonical).
function ncePortalSimUrl(iccid) {
  if (!iccid) return 'https://portal.1nce.com/portal/customer/sims';
  // 20자리면 마지막 Luhn 1자리 자르기 (1NCE는 19자리 canonical)
  const id = iccid.length === 20 ? iccid.slice(0, 19) : iccid;
  return `https://portal.1nce.com/portal/customer/sims?searchValue=${id}`;
}

// 모바일(인앱 웹뷰): Flutter 채널로 → app 이 inappwebview 로 처리
// 데스크톱: 새 탭
function openNcePortalForSim(iccid) {
  const url = ncePortalSimUrl(iccid);
  if (window.FlutterAppOpenUrl?.postMessage) {
    window.FlutterAppOpenUrl.postMessage(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function SimRequestsTab() {
  const [list, setList]   = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy]   = useState(null);
  const [filter, setFilter] = useState('pending');
  const [search, setSearch] = useState('');
  const [approveTarget, setApproveTarget] = useState(null);  // 승인 모달용 row
  const [orderInfo, setOrderInfo] = useState(null);          // { row, loading, data, error }

  async function load() {
    try {
      const v = await api.adminListSimRequests();
      setList(v || []);
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); const iv = setInterval(load, 15_000); return () => clearInterval(iv); }, []);

  // 원클릭 충전 — 1NCE refill API 직접 호출
  async function oneClickProcess(id) {
    // 2차 인증 — 1NCE 결제는 한 번 들어가면 환불 불가 (banktransfer 인보이스 즉시 발행).
    // 잘못 누른 경우 손실 방지를 위해 명시적 재확인.
    const row = list?.find(r => r.id === id);
    const ok = await confirmDialog({
      title: '⚠ 원클릭 충전 — 마지막 확인',
      body:
        `요청 #${id} 를 1NCE API 로 즉시 충전합니다.\n\n` +
        `사용자: ${row?.user_email || `uid:${row?.user_id || '?'}`}\n` +
        `데이터: ${row?.data_mb || 500} MB\n` +
        `비용:   ${row?.cost_credits?.toLocaleString() || '?'} 원 (사용자 포인트 차감 완료)\n` +
        `ICCID:  ${row?.iccid || '?'}\n\n` +
        `❗ 1NCE 결제는 한 번 들어가면 환불 불가합니다.\n` +
        `정말 진행할까요?`,
      confirmLabel: '예, 1NCE 에 충전 요청',
      cancelLabel: '취소',
      danger: true,
    });
    if (!ok) return;

    setApproveTarget(null);
    setBusy(`p-${id}`);
    try {
      const r = await api.adminProcessSimReq(id);
      if (r.ok) {
        await alertDialog({
          title: '원클릭 충전 완료',
          body: `요청 #${id} 가 1NCE 에 정상 적용됐습니다.`,
          tone: 'success',
        });
      } else {
        await alertDialog({
          title: '1NCE 처리 실패',
          body: `사용자에게 자동 환불됐습니다.\n\n${r.api_result?.error || JSON.stringify(r.api_result?.response, null, 2).slice(0, 400)}`,
          tone: 'danger',
        });
      }
      load();
    } catch (e) {
      await alertDialog({ title: '오류', body: e.message, tone: 'danger' });
    }
    finally { setBusy(null); }
  }

  // 콘솔 수동 충전 완료 마킹
  async function manualComplete(id) {
    const ok = await confirmDialog({
      title: '콘솔 수동 충전 완료 처리',
      body: `요청 #${id} 를 완료(done) 로 마킹합니다.\n` +
            `1NCE 콘솔에서 충전이 실제로 끝났는지 확인 후 진행하세요.`,
      confirmLabel: '완료 처리',
      tone: 'success',
    });
    if (!ok) return;
    setApproveTarget(null);
    setBusy(`p-${id}`);
    try {
      await api.adminManualCompleteSimReq(id);
      load();
    } catch (e) {
      await alertDialog({ title: '오류', body: e.message, tone: 'danger' });
    } finally { setBusy(null); }
  }

  // 콘솔 수동 충전 실패 — 환불
  async function manualFail(id) {
    const ok = await confirmDialog({
      title: '콘솔 수동 충전 실패 처리',
      body: `요청 #${id} 를 실패(failed) 로 마킹하고 사용자에게 환불합니다.`,
      confirmLabel: '실패 처리 + 환불',
      danger: true,
    });
    if (!ok) return;
    setApproveTarget(null);
    setBusy(`p-${id}`);
    try {
      await api.adminManualFailSimReq(id);
      load();
    } catch (e) {
      await alertDialog({ title: '오류', body: e.message, tone: 'danger' });
    } finally { setBusy(null); }
  }
  // 1NCE 주문/SIM 조회 — done/failed/cancelled 행에서 호출.
  //   기본: order/sim 둘 다 DB 캐시 우선 (1NCE 호출 안 함)
  //   opts.refresh=true → order 강제 재조회
  //   opts.refresh_sim=true → SIM 잔량 라이브 호출
  async function openOrderInfo(row, opts = {}) {
    setOrderInfo({ row, loading: true, data: null, error: null });
    try {
      const data = await api.adminSimRequestOrder(row.id, opts);
      setOrderInfo({ row, loading: false, data, error: null });
    } catch (e) {
      setOrderInfo({ row, loading: false, data: null, error: e.message });
    }
  }

  async function cancel(id) {
    const ok = await confirmDialog({
      title: 'SIM 요청 취소',
      body: `요청 #${id} 를 취소하고 사용자에게 환불합니다.`,
      confirmLabel: '취소 + 환불',
      danger: true,
    });
    if (!ok) return;
    setBusy(`c-${id}`);
    try { await api.adminCancelSimReq(id); load(); }
    catch (e) { await alertDialog({ title: '취소 실패', body: e.message, tone: 'danger' }); }
    finally { setBusy(null); }
  }

  if (error) return <div style={s.empty}>{error}</div>;
  if (!list) return <div style={s.empty}>로딩...</div>;

  const STATUS_LABEL = {
    pending: '대기', processing: '처리 중', done: '완료',
    failed: '실패', cancelled: '취소',
  };
  const STATUS_COLOR = {
    pending: 'var(--warning, #fbbf24)', processing: 'var(--primary)',
    done: 'var(--accent)', failed: '#f87171', cancelled: 'var(--text-3)',
  };
  const sterm = search.trim().toLowerCase();
  const filtered = list
    .filter(r => filter === 'all' || r.status === filter)
    .filter(r => !sterm
      || (r.user_email   || '').toLowerCase().includes(sterm)
      || (r.device_name  || '').toLowerCase().includes(sterm)
      || (r.iccid        || '').toLowerCase().includes(sterm));

  return (
    <div style={s.viewWrap}>
      <div style={s.toolRow}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {['pending', 'done', 'failed', 'cancelled', 'all'].map(f => (
            <button key={f} onClick={() => setFilter(f)}
              style={{
                ...s.subtab,
                ...(filter === f ? s.subtabOn : null),
                padding: '5px 10px', fontSize: 11,
              }}>
              {STATUS_LABEL[f] || '전체'}
              {f !== 'all' && (
                <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.7 }}>
                  ({list.filter(r => r.status === f).length})
                </span>
              )}
            </button>
          ))}
        </div>
        <input placeholder="이메일/장치/ICCID 검색"
          value={search} onChange={e => setSearch(e.target.value)}
          style={{ ...s.input, maxWidth: 240 }} />
        <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 'auto' }}>
          {filtered.length} 건 (15초 자동 새로고침)
        </span>
      </div>

      <div style={s.table}>
        <div style={s.tableHead}>
          <span style={{ width: 50 }}>ID</span>
          <span style={{ flex: 1.5 }}>요청자</span>
          <span style={{ flex: 1.5 }}>장치 / ICCID</span>
          <span style={{ width: 80 }}>데이터</span>
          <span style={{ width: 80 }}>비용</span>
          <span style={{ width: 80 }}>상태</span>
          <span style={{ width: 110 }}>요청 시각</span>
          <span style={{ width: 200 }}>액션</span>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {filtered.length === 0 && <div style={s.emptyInline}>해당 항목 없음</div>}
          {filtered.map(r => (
            <div key={r.id} style={{ ...s.tableRow, cursor: 'default' }}>
              <span style={{ width: 50, fontFamily: 'monospace', color: 'var(--text-3)' }}>#{r.id}</span>
              <span style={{ flex: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.user_email || `uid:${r.user_id}`}
              </span>
              <span style={{ flex: 1.5, fontSize: 11, color: 'var(--text-2)',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.device_name || `dev:${r.device_id}`}
                {r.iccid && <span style={{ fontFamily: 'monospace', marginLeft: 4 }}>…{r.iccid.slice(-8)}</span>}
              </span>
              <span style={{ width: 80, fontWeight: 600 }}>{r.data_mb}MB</span>
              <span style={{ width: 80, color: 'var(--text-2)' }}>{r.cost_credits.toLocaleString()}원</span>
              <span style={{ width: 80, fontSize: 11 }}>
                <div style={{ color: STATUS_COLOR[r.status], fontWeight: 600 }}>
                  {STATUS_LABEL[r.status] || r.status}
                </div>
                {r.status === 'cancelled' && (
                  <div style={{ fontSize: 9, color: 'var(--text-3)' }}>
                    {r.cancelled_by_user ? '유저 취소' : '관리자 취소'}
                  </div>
                )}
              </span>
              <span style={{ width: 110, fontSize: 11, color: 'var(--text-3)' }}>
                {fmtAge(r.requested_at)}
              </span>
              <span style={{ width: 200, display: 'flex', gap: 4 }}>
                {r.status === 'pending' && (
                  <>
                    <button onClick={() => setApproveTarget(r)} disabled={busy === `p-${r.id}`}
                      style={{ ...s.topupBtn, padding: '4px 8px' }}>
                      {busy === `p-${r.id}` ? '...' : '승인'}
                    </button>
                    <button onClick={() => cancel(r.id)} disabled={busy === `c-${r.id}`}
                      style={{ ...s.nceBtn, padding: '4px 8px', borderColor: 'var(--danger)', color: 'var(--danger)' }}>
                      {busy === `c-${r.id}` ? '...' : '취소'}
                    </button>
                  </>
                )}
                {/* done 행은 1NCE 측 주문/Invoice 번호 조회 가능 */}
                {r.status === 'done' && (
                  <button onClick={() => openOrderInfo(r)}
                    style={{ ...s.nceBtn, padding: '4px 8px' }}>
                    1NCE 조회
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>

      {approveTarget && (
        <ApproveSimModal
          row={approveTarget}
          onClose={() => setApproveTarget(null)}
          onOneClick={() => oneClickProcess(approveTarget.id)}
          onConsole={() => openNcePortalForSim(approveTarget.iccid)}
          onManualComplete={() => manualComplete(approveTarget.id)}
          onManualFail={() => manualFail(approveTarget.id)}
        />
      )}

      {orderInfo && (
        <OrderInfoModal
          info={orderInfo}
          onClose={() => setOrderInfo(null)}
          onRefreshOrder={() => openOrderInfo(orderInfo.row, { refresh: true })}
          onRefreshSim={()   => openOrderInfo(orderInfo.row, { refresh_sim: true })}
        />
      )}
    </div>
  );
}

// ─── 1NCE 주문/Invoice/SIM 조회 모달 ────────────────────────
// done 행에서 1NCE 측 order_number, invoice_number, invoice_amount + SIM 상태/잔량 표시.
// Invoice PDF 는 1NCE 가 별도 AWS SigV4 인증 요구 → Bearer 토큰으로 못 받음.
// → invoice_number 만 복사 가능하게 노출 + "1NCE 포털 열기" 외부 링크.
function OrderInfoModal({ info, onClose, onRefreshOrder, onRefreshSim }) {
  const { row, loading, data, error } = info;
  const order = data?.order || {};
  const sim   = data?.sim?.info || {};
  const quota = data?.sim?.usage?.stats?.find(s => s.date === 'TOTAL');

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); } catch {}
  }

  function fmtAge(iso) {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return null;
    const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (secs < 60)    return `${secs}초 전`;
    if (secs < 3600)  return `${Math.floor(secs/60)}분 전`;
    if (secs < 86400) return `${Math.floor(secs/3600)}시간 전`;
    return `${Math.floor(secs/86400)}일 전`;
  }

  return (
    <div onClick={onClose} style={modalStyles.backdrop}>
      <div onClick={e => e.stopPropagation()} style={modalStyles.shell}>
        <div style={modalStyles.head}>
          <span style={{ fontWeight: 700 }}>1NCE 조회 — 요청 #{row.id}</span>
          <button onClick={onClose} style={modalStyles.x}>✕</button>
        </div>

        {loading && <div style={modalStyles.body}>1NCE 조회 중...</div>}

        {!loading && error && (
          <div style={{ ...modalStyles.body, color: 'var(--danger)' }}>
            오류: {error}
          </div>
        )}

        {!loading && !error && data && (
          <div style={modalStyles.body}>
            {/* 주문 정보 — DB 캐시 (불변, 1회만 1NCE 호출) */}
            <Section
              title="1NCE 주문"
              cacheHint={data.order_cached_at
                ? `캐시 (${fmtAge(data.order_cached_at) || '방금'} 저장, 불변)`
                : null}
              onRefresh={onRefreshOrder}
              refreshLabel="강제 재조회"
            >
              <KV k="주문 번호 (order_number)" v={order.order_number}
                 onCopy={() => copy(String(order.order_number || ''))} />
              <KV k="주문 유형" v={order.order_type} />
              <KV k="주문 일시" v={order.order_date} />
              <KV k="🧾 영수증 번호 (invoice_number)" v={order.invoice_number}
                 onCopy={() => copy(String(order.invoice_number || ''))} highlight />
              <KV k="영수증 금액"
                 v={order.invoice_amount ? `${order.invoice_amount} ${order.currency || ''}` : '-'} />
            </Section>

            {/* SIM 상태 — 30분 워커 캐시. 라이브 원하면 새로고침 */}
            <Section
              title="SIM 상태"
              cacheHint={data.sim_cached_at
                ? `캐시 (${fmtAge(data.sim_cached_at) || '방금'})`
                : '라이브'}
              onRefresh={onRefreshSim}
              refreshLabel="라이브 갱신"
            >
              <KV k="ICCID" v={sim.iccid} mono />
              <KV k="상태" v={sim.status} />
              <KV k="IP" v={sim.ip_address || '-'} />
              <KV k="현재 quota" v={sim.current_quota ? `${sim.current_quota} MB` : '-'} />
              <KV k="누적 사용" v={quota ? `${parseFloat(quota.data?.volume || '0').toFixed(2)} MB` : '-'} />
            </Section>

            {/* Invoice PDF 안내 */}
            <div style={{
              marginTop: 12, padding: 10, borderRadius: 6,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              fontSize: 11, color: 'var(--text-2)',
            }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>📄 Invoice PDF 다운로드</div>
              <div>
                1NCE 가 Invoice PDF 에는 별도 인증 (AWS SigV4) 을 요구해서 우리 API 토큰으로는 자동 다운로드 불가.
              </div>
              <div style={{ marginTop: 6 }}>
                <a href="https://portal.1nce.com/portal/login" target="_blank" rel="noopener noreferrer"
                  style={{ color: 'var(--primary)', textDecoration: 'underline' }}>
                  1NCE 포털 열기 →
                </a> 에서 영수증 번호 <b>{order.invoice_number || '-'}</b> 로 검색해 받으세요.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, cacheHint, onRefresh, refreshLabel, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 4,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, color: 'var(--text-2)',
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>{title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {cacheHint && (
            <span style={{ fontSize: 10, color: 'var(--text-2)' }}>{cacheHint}</span>
          )}
          {onRefresh && (
            <button onClick={onRefresh} title={refreshLabel}
              style={{
                background: 'transparent', border: '1px solid var(--border)',
                borderRadius: 4, padding: '1px 6px', fontSize: 10,
                cursor: 'pointer', color: 'var(--text-2)',
              }}>↻</button>
          )}
        </div>
      </div>
      <div style={{ background: 'var(--surface-2)', borderRadius: 6, padding: 8 }}>
        {children}
      </div>
    </div>
  );
}

function KV({ k, v, onCopy, highlight, mono }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      fontSize: 12, padding: '3px 0',
      borderBottom: '1px solid var(--border)',
    }}>
      <span style={{ color: 'var(--text-2)' }}>{k}</span>
      <span style={{
        color: highlight ? 'var(--primary)' : 'var(--text)',
        fontWeight: highlight ? 700 : 500,
        fontFamily: mono ? 'monospace' : 'inherit',
        display: 'inline-flex', alignItems: 'center', gap: 6,
      }}>
        {v ?? '-'}
        {onCopy && v != null && v !== '-' && (
          <button onClick={onCopy} title="복사"
            style={{
              background: 'transparent', border: '1px solid var(--border)',
              borderRadius: 4, padding: '0 5px', fontSize: 10,
              cursor: 'pointer', color: 'var(--text-2)',
            }}>복사</button>
        )}
      </span>
    </div>
  );
}

const modalStyles = {
  backdrop: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(4px)',
    zIndex: 900,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16,
  },
  shell: {
    width: '100%', maxWidth: 520, maxHeight: '85vh',
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 10, overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
  },
  head: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 14px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--surface-2)',
    fontSize: 13,
  },
  x: {
    background: 'transparent', border: 'none',
    fontSize: 16, cursor: 'pointer', color: 'var(--text-2)',
  },
  body: {
    padding: 14, overflowY: 'auto',
  },
};

// ─── 승인 모달 ─────────────────────────────────────────
// 두 흐름:
//   A) API 자동 — 원클릭 충전 (1NCE refill API 호출 → 즉시 status='done' or 환불)
//   B) 콘솔 수동 — 1NCE 콘솔로 가기 + (충전 후) 완료 처리 / 실패 처리
//      1NCE 가 우리에게 webhook 안 보내므로, admin 이 콘솔 처리 후 직접 마킹해야 함.
function ApproveSimModal({ row, onClose, onOneClick, onConsole, onManualComplete, onManualFail }) {
  return (
    // 외부 클릭으로 닫히지 않음 — 결제 진행 중 실수 방지.
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000, padding: 16,
    }}>
      <div style={{
        width: '100%', maxWidth: 420,
        background: 'var(--surface)', borderRadius: 12,
        boxShadow: '0 20px 50px rgba(0,0,0,0.25)', overflow: 'hidden',
        maxHeight: '90vh', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>SIM 충전 승인</div>
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            요청 #{row.id} · {row.user_email || `uid:${row.user_id}`}
            {' · '}{row.data_mb}MB · {row.cost_credits.toLocaleString()}원
          </div>
          {row.iccid && (
            <div style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-3)', marginTop: 4 }}>
              ICCID: {row.iccid}
            </div>
          )}
        </div>

        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>
          {/* A) API 자동 */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', marginBottom: 6, letterSpacing: 0.5 }}>
              A) API 자동
            </div>
            <button onClick={onOneClick} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '14px 16px', textAlign: 'left', width: '100%',
              background: 'var(--primary)', color: 'var(--primary-fg)',
              border: 'none', borderRadius: 10, cursor: 'pointer',
            }}>
              <Icon name="spark" size={20} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>원클릭 충전</div>
                <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>
                  1NCE API 자동 호출로 즉시 충전 (실패 시 자동 환불)
                </div>
              </div>
            </button>
          </div>

          {/* B) 콘솔 수동 */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', marginBottom: 6, letterSpacing: 0.5 }}>
              B) 콘솔 수동
            </div>
            <button onClick={onConsole} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '12px 14px', textAlign: 'left', width: '100%',
              background: 'var(--surface-2)', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 10, cursor: 'pointer',
            }}>
              <Icon name="share" size={18} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>1NCE 콘솔 열기</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                  새 탭에서 SIM 검색 페이지 — 직접 충전
                </div>
              </div>
            </button>

            <div style={{
              fontSize: 11, color: 'var(--text-3)', marginTop: 10, marginBottom: 6,
              padding: 8, background: 'var(--surface-2)', borderRadius: 6,
              border: '1px dashed var(--border)',
            }}>
              ⚠ 1NCE 가 우리 서버로 webhook 을 안 보냅니다. 콘솔에서 충전 끝낸 후 아래 버튼으로 직접 마킹하세요.
            </div>

            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={onManualComplete} style={{
                flex: 1, padding: '10px 12px', fontSize: 12, fontWeight: 700,
                background: 'transparent', color: 'var(--accent)',
                border: '1px solid var(--accent)', borderRadius: 8, cursor: 'pointer',
              }}>
                ✓ 완료 처리
              </button>
              <button onClick={onManualFail} style={{
                flex: 1, padding: '10px 12px', fontSize: 12, fontWeight: 700,
                background: 'transparent', color: 'var(--danger)',
                border: '1px solid var(--danger)', borderRadius: 8, cursor: 'pointer',
              }}>
                ✕ 실패 처리 (환불)
              </button>
            </div>
          </div>

          <button onClick={onClose} style={{
            padding: 10,
            background: 'transparent', color: 'var(--text-3)',
            border: 'none', cursor: 'pointer', fontSize: 12,
          }}>닫기</button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// 결제 내역 탭 — Toss 결제 모든 사용자 통합 조회
// ════════════════════════════════════════════════════════════
function PaymentsTab() {
  const [list, setList]     = useState(null);
  const [error, setError]   = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  async function load() {
    try { setList(await api.adminListPayments({ limit: 500 })); }
    catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, []);

  if (error) return <div style={s.empty}>{error}</div>;
  if (!list) return <div style={s.empty}>로딩...</div>;

  const STATUS_LABEL = {
    pending: '대기', done: '완료', failed: '실패', cancelled: '취소',
  };
  const STATUS_COLOR = {
    pending: 'var(--warning, #fbbf24)', done: 'var(--accent)',
    failed: '#f87171', cancelled: 'var(--text-3)',
  };
  const sterm = search.trim().toLowerCase();
  const filtered = list
    .filter(r => filter === 'all' || r.status === filter)
    .filter(r => !sterm
      || (r.user_email   || '').toLowerCase().includes(sterm)
      || (r.user_display || '').toLowerCase().includes(sterm)
      || (r.order_id     || '').toLowerCase().includes(sterm));

  // 합계 (filtered 결과의 done 만)
  const sumDone = filtered.filter(r => r.status === 'done')
    .reduce((acc, r) => acc + r.amount, 0);

  return (
    <div style={s.viewWrap}>
      <div style={s.toolRow}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {['all', 'done', 'pending', 'failed', 'cancelled'].map(f => (
            <button key={f} onClick={() => setFilter(f)}
              style={{
                ...s.subtab,
                ...(filter === f ? s.subtabOn : null),
                padding: '5px 10px', fontSize: 11,
              }}>
              {STATUS_LABEL[f] || '전체'}
              {f !== 'all' && (
                <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.7 }}>
                  ({list.filter(r => r.status === f).length})
                </span>
              )}
            </button>
          ))}
        </div>
        <input placeholder="이메일/이름/주문ID 검색"
          value={search} onChange={e => setSearch(e.target.value)}
          style={{ ...s.input, maxWidth: 240 }} />
        <button onClick={load} style={{ ...s.subtab, padding: '5px 10px', fontSize: 11 }}>
          새로고침
        </button>
        <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 'auto' }}>
          {filtered.length}건 · 완료 합계 <b style={{ color: 'var(--accent)' }}>
            {sumDone.toLocaleString()}원
          </b>
        </span>
      </div>

      <div style={s.table}>
        <div style={s.tableHead}>
          <span style={{ width: 60 }}>ID</span>
          <span style={{ flex: 2 }}>사용자</span>
          <span style={{ flex: 2, fontSize: 10 }}>주문ID</span>
          <span style={{ width: 110 }}>금액</span>
          <span style={{ width: 80 }}>상태</span>
          <span style={{ width: 80 }}>방식</span>
          <span style={{ width: 130 }}>요청 시각</span>
          <span style={{ width: 130 }}>완료 시각</span>
          <span style={{ width: 60 }}>영수증</span>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {filtered.length === 0 && <div style={s.emptyInline}>해당 항목 없음</div>}
          {filtered.map(r => (
            <div key={r.id} style={{ ...s.tableRow, cursor: 'default' }}>
              <span style={{ width: 60, fontFamily: 'monospace', color: 'var(--text-3)' }}>#{r.id}</span>
              <span style={{ flex: 2, minWidth: 0,
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <div style={{ fontWeight: 600 }}>{r.user_email || `uid:${r.user_id}`}</div>
                {r.user_display && (
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{r.user_display}</div>
                )}
              </span>
              <span style={{ flex: 2, fontSize: 10, fontFamily: 'monospace', color: 'var(--text-2)',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.order_id}
              </span>
              <span style={{ width: 110, fontWeight: 700, fontSize: 14 }}>
                {r.amount.toLocaleString()}<span style={{ fontSize: 10, color: 'var(--text-3)', marginLeft: 2 }}>원</span>
              </span>
              <span style={{ width: 80, fontSize: 11 }}>
                <div style={{ color: STATUS_COLOR[r.status], fontWeight: 600 }}>
                  {STATUS_LABEL[r.status] || r.status}
                </div>
                {r.fail_reason && (
                  <div style={{ fontSize: 9, color: 'var(--text-3)',
                                overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.fail_reason}>
                    {r.fail_reason.slice(0, 20)}
                  </div>
                )}
              </span>
              <span style={{ width: 80, fontSize: 11, color: 'var(--text-2)' }}>
                {r.method || '—'}
              </span>
              <span style={{ width: 130, fontSize: 11, color: 'var(--text-3)' }}>
                {fmtAge(r.created_at)}
              </span>
              <span style={{ width: 130, fontSize: 11, color: 'var(--text-3)' }}>
                {r.confirmed_at ? fmtAge(r.confirmed_at) : '—'}
              </span>
              <span style={{ width: 60 }}>
                {r.receipt_url
                  ? <a href={r.receipt_url} target="_blank" rel="noreferrer"
                       style={{ fontSize: 11, color: 'var(--primary)' }}>보기</a>
                  : <span style={{ fontSize: 11, color: 'var(--text-3)' }}>—</span>}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// 채팅 탭 — 좌측 thread 목록 / 우측 메시지창
// ════════════════════════════════════════════════════════════
function ChatAdminTab() {
  const [threads, setThreads] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);

  // 필터 — 사용자 검색 (스레드 목록에 즉시 반영, 클라이언트 사이드)
  const [userQuery, setUserQuery] = useState('');

  // 검색 모드 — 메시지 본문/날짜 검색 (서버 사이드)
  const [searchMode, setSearchMode] = useState(false);
  const [bodyQuery, setBodyQuery] = useState('');
  const [fromDate, setFromDate]   = useState('');     // YYYY-MM-DD
  const [toDate, setToDate]       = useState('');
  const [hits, setHits]           = useState(null);
  const [searching, setSearching] = useState(false);

  async function loadThreads() {
    try { setThreads(await api.adminChatThreads()); }
    catch (e) { setError(e.message); }
  }
  useEffect(() => {
    loadThreads();
    const iv = setInterval(loadThreads, 10_000);
    return () => clearInterval(iv);
  }, []);

  async function runSearch() {
    setSearching(true);
    try {
      const params = {};
      if (userQuery.trim()) params.user = userQuery.trim();
      if (bodyQuery.trim()) params.q    = bodyQuery.trim();
      if (fromDate) params.from = `${fromDate}T00:00:00Z`;
      if (toDate)   params.to   = `${toDate}T23:59:59Z`;
      params.limit = 200;
      setHits(await api.adminChatSearch(params));
    } catch (e) {
      alertDialog({ title: '검색 실패', body: e.message, tone: 'danger' });
    } finally { setSearching(false); }
  }

  if (error) return <div style={s.empty}>{error}</div>;
  if (!threads) return <div style={s.empty}>로딩...</div>;

  const filteredThreads = !userQuery.trim() ? threads :
    threads.filter(t => {
      const q = userQuery.trim().toLowerCase();
      return (t.user_email   || '').toLowerCase().includes(q)
          || (t.user_display || '').toLowerCase().includes(q);
    });

  return (
    <div style={{
      ...s.viewWrap,
      display: 'grid',
      gridTemplateColumns: 'minmax(240px, 320px) 1fr',
      gap: 12, padding: 12,
    }}>
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 8, overflow: 'hidden', display: 'flex', flexDirection: 'column',
      }}>
        {/* 필터 바 */}
        <div style={{ padding: 10, borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input placeholder="사용자 (이메일/이름)"
            value={userQuery} onChange={e => setUserQuery(e.target.value)}
            style={{ ...s.input, fontSize: 12 }} />
          <button onClick={() => setSearchMode(m => !m)}
            style={{
              ...s.subtab,
              ...(searchMode ? s.subtabOn : null),
              padding: '5px 10px', fontSize: 11,
            }}>
            {searchMode ? '× 메시지 검색 닫기' : '🔍 메시지 본문 / 날짜 검색'}
          </button>
          {searchMode && (
            <>
              <input placeholder="메시지 내용"
                value={bodyQuery} onChange={e => setBodyQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') runSearch(); }}
                style={{ ...s.input, fontSize: 12 }} />
              <div style={{ display: 'flex', gap: 4 }}>
                <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
                  style={{ ...s.input, fontSize: 11, flex: 1 }} title="시작일" />
                <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
                  style={{ ...s.input, fontSize: 11, flex: 1 }} title="종료일" />
              </div>
              <button onClick={runSearch} disabled={searching}
                style={{ ...s.actionBtn, fontSize: 12 }}>
                {searching ? '검색 중...' : '검색'}
              </button>
            </>
          )}
        </div>

        <div style={{ ...s.tableHead, padding: '10px 12px' }}>
          {searchMode && hits ? `검색 결과 (${hits.length})` : `스레드 (${filteredThreads.length}/${threads.length})`}
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {searchMode && hits ? (
            hits.length === 0 ? <div style={s.emptyInline}>일치하는 메시지 없음</div> :
            hits.map(h => (
              <button key={h.id} onClick={() => setSelected(h.thread_id)}
                style={{
                  width: '100%', padding: '10px 12px', textAlign: 'left',
                  background: selected === h.thread_id ? 'var(--surface-2)' : 'transparent',
                  border: 'none', borderBottom: '1px solid var(--border)',
                  cursor: 'pointer', color: 'var(--text)',
                }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ fontWeight: 600, fontSize: 12 }}>
                    {h.user_display || h.user_email || `uid:${h.user_id}`}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--text-3)' }}>
                    {h.sender_role === 'admin' ? '관리자' : '사용자'}
                  </span>
                </div>
                <div style={{
                  fontSize: 11, color: 'var(--text-2)',
                  overflow: 'hidden', textOverflow: 'ellipsis',
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                }}>
                  {h.body}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                  {new Date(h.created_at).toLocaleString('ko-KR')}
                </div>
              </button>
            ))
          ) : (
          filteredThreads.map(t => (
            <button key={t.id}
              onClick={() => setSelected(t.id)}
              style={{
                width: '100%', padding: '10px 12px', textAlign: 'left',
                background: selected === t.id ? 'var(--surface-2)' : 'transparent',
                border: 'none', borderBottom: '1px solid var(--border)',
                cursor: 'pointer', color: 'var(--text)',
              }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                marginBottom: 2,
              }}>
                <span style={{ fontWeight: 600, fontSize: 12,
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.user_display || t.user_email || `uid:${t.user_id}`}
                </span>
                {t.unread_for_admin > 0 && (
                  <span style={{
                    background: 'var(--danger)', color: 'white',
                    minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9,
                    fontSize: 10, fontWeight: 700,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}>{t.unread_for_admin}</span>
                )}
              </div>
              <div style={{
                fontSize: 11, color: 'var(--text-3)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {t.last_message_text || <em>대화 없음</em>}
              </div>
              {t.last_message_at && (
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                  {fmtAge(t.last_message_at)}
                </div>
              )}
            </button>
          ))
          )}
        </div>
      </div>

      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 8, overflow: 'hidden', display: 'flex', flexDirection: 'column',
      }}>
        {selected ? <AdminChatThread threadId={selected} onSent={loadThreads} />
                  : <div style={{ ...s.empty, height: '100%' }}>좌측에서 스레드를 선택하세요.</div>}
      </div>
    </div>
  );
}

function AdminChatThread({ threadId, onSent }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const lastIdRef = useRef(0);
  const scrollRef = useRef(null);

  async function loadInitial() {
    try {
      const list = await api.adminChatMessages(threadId);
      setMessages(list || []);
      if (list && list.length) lastIdRef.current = list[list.length - 1].id;
      try { await api.adminChatMarkRead(threadId); } catch {}
      onSent?.();
    } catch (e) { console.error(e); }
  }
  async function pollNew() {
    try {
      const list = await api.adminChatMessages(threadId, lastIdRef.current);
      if (list?.length) {
        setMessages(prev => [...prev, ...list]);
        lastIdRef.current = list[list.length - 1].id;
        try { await api.adminChatMarkRead(threadId); } catch {}
        onSent?.();
      }
    } catch {}
  }
  useEffect(() => {
    setMessages([]); lastIdRef.current = 0;
    loadInitial();
    const iv = setInterval(pollNew, 5000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);

  async function send() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const m = await api.adminChatSend(threadId, body);
      setMessages(prev => [...prev, m]);
      lastIdRef.current = m.id;
      setText('');
      onSent?.();
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div ref={scrollRef} style={{
        flex: 1, padding: 12, overflowY: 'auto',
        background: 'var(--surface-2)',
      }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-3)', fontSize: 12 }}>
            대화 없음
          </div>
        )}
        {messages.map(m => {
          if (m.sender_role === 'system') {
            return <div key={m.id} style={{
              textAlign: 'center', fontSize: 11, color: 'var(--text-3)',
              fontStyle: 'italic', margin: '6px 0',
            }}>{m.body}</div>;
          }
          const fromAdmin = m.sender_role === 'admin';
          return (
            <div key={m.id} style={{
              display: 'flex', justifyContent: fromAdmin ? 'flex-end' : 'flex-start',
              margin: '4px 0',
            }}>
              <div style={{
                maxWidth: '78%', padding: '7px 10px', borderRadius: 10, fontSize: 13,
                background: fromAdmin ? 'var(--primary)' : 'var(--surface)',
                color:      fromAdmin ? 'white' : 'var(--text)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {!fromAdmin && (
                  <div style={{ fontSize: 10, color: 'var(--text-2)', marginBottom: 2 }}>사용자</div>
                )}
                {m.body}
                <div style={{
                  fontSize: 9, opacity: 0.7, marginTop: 3, textAlign: 'right',
                  color: fromAdmin ? 'rgba(255,255,255,0.85)' : 'var(--text-3)',
                }}>
                  {new Date(m.created_at).toLocaleString('ko-KR', {
                    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{
        display: 'flex', gap: 6, padding: 8,
        borderTop: '1px solid var(--border)', background: 'var(--surface)',
      }}>
        <input value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="메시지를 입력하세요... (Enter 전송)"
          style={{ ...s.input, flex: 1 }} />
        <button onClick={send} disabled={busy || !text.trim()} style={s.actionBtn}>
          전송
        </button>
      </div>
    </>
  );
}

// ════════════════════════════════════════════════════════════
// 사용자 탭
// ════════════════════════════════════════════════════════════
function UsersTab() {
  const [users, setUsers]   = useState(null);
  const [error, setError]   = useState(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [devices, setDevices] = useState([]);
  const [busy, setBusy]     = useState(null);

  useEffect(() => {
    api.adminListUsers().then(setUsers).catch(e => setError(e.message));
  }, []);

  useEffect(() => {
    if (!selectedId) { setDetail(null); setDevices([]); return; }
    Promise.allSettled([
      api.adminUserDetail(selectedId),
      api.adminUserDevices(selectedId),
    ]).then(([d, dv]) => {
      setDetail(d.status === 'fulfilled' ? d.value : null);
      setDevices(dv.status === 'fulfilled' ? dv.value : []);
    });
  }, [selectedId]);

  async function handleImpersonate(uid, email) {
    if (!confirm(`'${email}' 계정으로 진입합니다. 모든 데이터를 보고 작업할 수 있습니다. 계속?`)) return;
    setBusy(`imp-${uid}`);
    try {
      const r = await api.adminImpersonate(uid);
      setTokens(r.access_token, r.refresh_token);
      alert(`'${email}' 로 진입합니다. 새로고침합니다.`);
      window.location.reload();
    } catch (e) { alert(e.message); }
    finally { setBusy(null); }
  }

  async function handleTopup(iccid) {
    if (!iccid) return;
    const mbStr = await promptDialog({
      title: 'SIM 데이터 직접 충전',
      body: `ICCID: ${iccid}\n충전할 데이터 용량 (MB) 을 입력하세요.\n\n* 사용자 요청 없이 관리자가 직접 1NCE 호출하는 경로입니다.`,
      placeholder: '500',
      defaultValue: '500',
      confirmLabel: '1NCE 충전',
    });
    if (mbStr == null) return;
    const mb = parseInt(mbStr, 10);
    if (!(mb > 0)) {
      await alertDialog({ title: '유효하지 않은 값', body: 'MB 는 양의 정수만 가능합니다.', tone: 'warn' });
      return;
    }
    setBusy(`top-${iccid}`);
    try {
      const r = await api.adminTopupSim(iccid, mb);
      const ok = r.api_result?.ok, st = r.api_result?.status;
      if (ok) {
        await alertDialog({
          title: '1NCE 충전 성공',
          body: `${mb}MB 충전 완료 (HTTP ${st})`,
          tone: 'success',
        });
      } else {
        await alertDialog({
          title: '1NCE 충전 실패',
          body: `HTTP ${st ?? '-'}\n${r.api_result?.error || JSON.stringify(r.api_result?.response, null, 2).slice(0, 400)}`,
          tone: 'danger',
        });
      }
    } catch (e) { await alertDialog({ title: '오류', body: e.message, tone: 'danger' }); }
    finally { setBusy(null); }
  }

  if (error)   return <div style={s.empty}>{error}</div>;
  if (!users)  return <div style={s.empty}>로딩...</div>;

  // 상세 뷰
  if (selectedId != null) {
    if (!detail) return <div style={s.empty}>로딩...</div>;
    return (
      <div style={s.viewWrap}>
        <div style={s.detailHead}>
          <button onClick={() => setSelectedId(null)} style={s.backBtn} title="뒤로">
            <Icon name="prev" size={14} />
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 15, fontWeight: 700,
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {detail.email}
              </span>
              {detail.role === 'admin' && <span style={s.roleBadge}>admin</span>}
            </div>
            <div style={s.detailSub}>
              {detail.display_name || '이름 미설정'}
              {detail.secondary_phone && ` · ${detail.secondary_phone}`}
              {' · '}디바이스 {detail.device_count}대
              {' · '}가입 {new Date(detail.created_at).toLocaleDateString('ko-KR')}
            </div>
          </div>
          <button onClick={() => handleImpersonate(detail.id, detail.email)}
            disabled={busy === `imp-${detail.id}`}
            style={s.impBtn}>
            <Icon name="user" size={13} />
            {busy === `imp-${detail.id}` ? '진입 중...' : '이 계정으로 진입'}
          </button>
        </div>

        <div style={s.section}>
          <div style={s.sectionTitle}>디바이스 ({devices.length})</div>
          {devices.length === 0 && <div style={s.emptyInline}>없음</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
            {devices.map(d => (
              <DeviceCard key={d.id} d={d} onTopup={handleTopup} busy={busy} onOpenNce={openNcePortal} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // 리스트 뷰
  const filtered = search.trim()
    ? users.filter(u => (u.email + (u.display_name || '')).toLowerCase().includes(search.toLowerCase()))
    : users;
  return (
    <div style={s.viewWrap}>
      <div style={s.toolRow}>
        <input placeholder="이메일/이름 검색"
          value={search} onChange={e => setSearch(e.target.value)}
          style={{ ...s.input, maxWidth: 320 }} />
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {filtered.length} / {users.length} 명
        </span>
      </div>

      <div style={s.table}>
        <div style={s.tableHead}>
          <span style={{ flex: 2 }}>이메일</span>
          <span style={{ flex: 1.5 }}>이름</span>
          <span style={{ width: 70 }}>역할</span>
          <span style={{ width: 80 }}>디바이스</span>
          <span style={{ width: 110 }}>마지막 활동</span>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {filtered.map(u => {
            const stale = !u.last_seen_at
              || (Date.now() - new Date(u.last_seen_at).getTime()) > 7 * 24 * 3600 * 1000;
            return (
              <button key={u.id} onClick={() => setSelectedId(u.id)} style={s.tableRow}>
                <span style={{ flex: 2, fontWeight: 600,
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {u.email}
                </span>
                <span style={{ flex: 1.5, color: 'var(--text-2)',
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {u.display_name || '—'}
                </span>
                <span style={{ width: 70 }}>
                  {u.role === 'admin'
                    ? <span style={s.roleBadge}>admin</span>
                    : <span style={{ color: 'var(--text-3)', fontSize: 11 }}>user</span>}
                </span>
                <span style={{ width: 80, color: 'var(--text-2)' }}>{u.device_count}대</span>
                <span style={{ width: 110,
                                color: stale ? 'var(--danger)' : 'var(--accent)',
                                fontSize: 11 }}>
                  {u.last_seen_at ? fmtAge(u.last_seen_at) : '없음'}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// 장치 탭
// ════════════════════════════════════════════════════════════
function DevicesTab() {
  const [list, setList]     = useState(null);
  const [error, setError]   = useState(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy]     = useState(null);

  useEffect(() => {
    api.adminListDevices().then(setList).catch(e => setError(e.message));
  }, []);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    api.adminDeviceDetail(selectedId).then(setDetail).catch(() => {});
  }, [selectedId]);

  async function handleTopup(iccid) {
    if (!iccid) return;
    const mbStr = await promptDialog({
      title: 'SIM 데이터 직접 충전',
      body: `ICCID: ${iccid}\n충전할 데이터 용량 (MB) 을 입력하세요.`,
      placeholder: '500',
      defaultValue: '500',
      confirmLabel: '1NCE 충전',
    });
    if (mbStr == null) return;
    const mb = parseInt(mbStr, 10);
    if (!(mb > 0)) return;
    setBusy(`top-${iccid}`);
    try {
      const r = await api.adminTopupSim(iccid, mb);
      const ok = r.api_result?.ok, st = r.api_result?.status;
      if (ok) {
        await alertDialog({
          title: '1NCE 충전 성공',
          body: `${mb}MB 충전 완료 (HTTP ${st})`,
          tone: 'success',
        });
      } else {
        await alertDialog({
          title: '1NCE 충전 실패',
          body: `HTTP ${st ?? '-'}\n${r.api_result?.error || JSON.stringify(r.api_result?.response, null, 2).slice(0, 400)}`,
          tone: 'danger',
        });
      }
    } catch (e) { await alertDialog({ title: '오류', body: e.message, tone: 'danger' }); }
    finally { setBusy(null); }
  }

  async function handleImpersonate(uid, email) {
    if (!confirm(`소유자 '${email}' 계정으로 진입합니다. 계속?`)) return;
    try {
      const r = await api.adminImpersonate(uid);
      setTokens(r.access_token, r.refresh_token);
      alert(`'${email}' 로 진입합니다.`);
      window.location.reload();
    } catch (e) { alert(e.message); }
  }

  if (error) return <div style={s.empty}>{error}</div>;
  if (!list) return <div style={s.empty}>로딩...</div>;

  // 상세 뷰
  if (selectedId != null) {
    if (!detail) return <div style={s.empty}>로딩...</div>;
    const d = detail.device;
    return (
      <div style={s.viewWrap}>
        <div style={s.detailHead}>
          <button onClick={() => setSelectedId(null)} style={s.backBtn}>
            <Icon name="prev" size={14} />
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {d.display_name || d.device_uid}
            </div>
            <div style={s.detailSub}>
              <code style={{ fontFamily: 'monospace' }}>{d.device_uid}</code>
              {d.owner_email && ` · 소유 ${d.owner_email}`}
            </div>
          </div>
          {d.owner_id && d.owner_email && (
            <button onClick={() => handleImpersonate(d.owner_id, d.owner_email)} style={s.impBtn}>
              <Icon name="user" size={13} /> 소유자로 진입
            </button>
          )}
        </div>

        {/* 메타 그리드 */}
        <div style={s.section}>
          <div style={s.sectionTitle}>디바이스 정보</div>
          <div style={s.metaGrid}>
            <Meta label="ICCID (1NCE 호환)"
              value={iccidCanonical(d.iccid) || '—'} mono
              hint={d.iccid && d.iccid.length === 20 ? `raw 20자리: ${d.iccid} (마지막 자리는 Luhn 체크)` : null} />
            <Meta label="IMEI"   value={d.imei  || '—'} mono />
            <Meta label="IMSI"   value={d.imsi  || '—'} mono />
            <Meta label="HW/FW"  value={`${d.hw_version || '—'} / ${d.fw_version || '—'}`} />
            <Meta label="페어링" value={d.paired_at ? new Date(d.paired_at).toLocaleString('ko-KR') : '—'} />
            <Meta label="등록"   value={new Date(d.created_at).toLocaleString('ko-KR')} />
            <Meta label="마지막 통신" value={d.last_seen_at ? fmtAge(d.last_seen_at) : '—'} />
            <Meta label="마지막 fix"  value={d.last_fix_at ? fmtAge(d.last_fix_at) : '—'} />
            <Meta label="좌표"
              value={d.last_lat != null ? `${d.last_lat.toFixed(5)}, ${d.last_lng.toFixed(5)}` : '—'} />
            <Meta label="브라운아웃"
              value={String(d.rtc_brownouts ?? 0)}
              warn={d.rtc_brownouts > 0} />
            <Meta label="GPS 실패 사이클"
              value={String(d.rtc_no_fix_cycles ?? 0)}
              warn={d.rtc_no_fix_cycles > 5} />
          </div>
        </div>

        {/* SIM 액션 */}
        {d.iccid && (
          <div style={s.section}>
            <div style={s.sectionTitle}>SIM 액션</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={() => handleTopup(d.iccid)}
                disabled={busy === `top-${d.iccid}`}
                style={s.actionBtn}>
                <Icon name="spark" size={13} />
                {busy === `top-${d.iccid}` ? '...' : 'SIM 충전 (1NCE API)'}
              </button>
              <button onClick={openNcePortal} style={s.actionBtnSec}>
                <Icon name="link" size={13} /> 1NCE 콘솔 ↗
              </button>
            </div>
          </div>
        )}

        {/* 최근 이벤트 */}
        <div style={s.section}>
          <div style={s.sectionTitle}>최근 이벤트 ({detail.recent_events?.length || 0})</div>
          {(!detail.recent_events || detail.recent_events.length === 0) && (
            <div style={s.emptyInline}>이벤트 없음</div>
          )}
          {detail.recent_events?.slice(0, 20).map(ev => (
            <div key={ev.id} style={s.eventRow}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)',
                              minWidth: 110 }}>{ev.kind}</span>
              <span style={{ fontSize: 11, color: 'var(--text-3)',
                              flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {ev.data ? JSON.stringify(ev.data).slice(0, 80) : ''}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-3)' }}>
                {new Date(ev.occurred_at).toLocaleString('ko-KR')}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // 리스트 뷰
  const q = search.trim().toLowerCase();
  const filtered = q
    ? list.filter(d =>
        (d.device_uid || '').toLowerCase().includes(q) ||
        (d.iccid || '').toLowerCase().includes(q) ||
        (d.imei || '').toLowerCase().includes(q) ||
        (d.owner_email || '').toLowerCase().includes(q) ||
        (d.display_name || '').toLowerCase().includes(q))
    : list;

  return (
    <div style={s.viewWrap}>
      <div style={s.toolRow}>
        <input placeholder="device_uid / ICCID / 소유자 이메일 검색"
          value={search} onChange={e => setSearch(e.target.value)}
          style={{ ...s.input, maxWidth: 380 }} />
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {filtered.length} / {list.length} 대
        </span>
      </div>

      <div style={s.table}>
        <div style={s.tableHead}>
          <span style={{ flex: 1.5 }}>디바이스</span>
          <span style={{ flex: 1.5 }}>소유자</span>
          <span style={{ flex: 1 }}>SIM</span>
          <span style={{ width: 110 }}>마지막 통신</span>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {filtered.map(d => {
            const stale = !d.last_seen_at
              || (Date.now() - new Date(d.last_seen_at).getTime()) > 30 * 60 * 1000;
            return (
              <button key={d.id} onClick={() => setSelectedId(d.id)} style={s.tableRow}>
                <span style={{ flex: 1.5, minWidth: 0 }}>
                  <div style={{ fontWeight: 600,
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {d.display_name || d.device_uid}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'monospace',
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {d.device_uid}
                  </div>
                </span>
                <span style={{ flex: 1.5, fontSize: 12, color: 'var(--text-2)',
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.owner_email || <em style={{ color: 'var(--text-3)' }}>미페어링</em>}
                </span>
                <span style={{ flex: 1, fontSize: 11, color: 'var(--text-2)', fontFamily: 'monospace',
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.iccid ? iccidShort(d.iccid) : '—'}
                </span>
                <span style={{ width: 110,
                                color: stale ? 'var(--danger)' : 'var(--accent)',
                                fontSize: 11 }}>
                  {d.last_seen_at ? fmtAge(d.last_seen_at) : '미접속'}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── 공용 ────────────────────────────────────────────────
function DeviceCard({ d, onTopup, busy, onOpenNce }) {
  return (
    <div style={s.devCard}>
      <div style={{ fontSize: 13, fontWeight: 600,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {d.display_name || d.device_uid}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, fontFamily: 'monospace' }}>
        {d.device_uid}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4,
                    display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {d.iccid && <span>SIM {iccidShort(d.iccid)}</span>}
        {d.imei  && <span>IMEI …{d.imei.slice(-6)}</span>}
        <span>{d.last_seen_at ? fmtAge(d.last_seen_at) : '미접속'}</span>
      </div>
      {d.iccid && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <button onClick={() => onTopup(d.iccid)}
            disabled={busy === `top-${d.iccid}`}
            style={s.topupBtn}>
            <Icon name="spark" size={12} /> 충전
          </button>
          <button onClick={onOpenNce} style={s.nceBtn}>
            <Icon name="link" size={12} /> 1NCE ↗
          </button>
        </div>
      )}
    </div>
  );
}
function Meta({ label, value, warn, mono, hint }) {
  return (
    <div style={{
      background: 'var(--surface-2)', borderRadius: 6, padding: '6px 8px',
      border: warn ? '1px solid var(--danger)' : '1px solid var(--border)',
    }} title={hint || ''}>
      <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{label}</div>
      <div style={{
        fontSize: 12, fontWeight: 500,
        color: warn ? 'var(--danger)' : 'var(--text)',
        fontFamily: mono ? 'monospace' : 'inherit',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{value}</div>
      {hint && (
        <div style={{
          fontSize: 9, color: 'var(--text-3)', marginTop: 3,
          fontFamily: mono ? 'monospace' : 'inherit',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{hint}</div>
      )}
    </div>
  );
}
function fmtAge(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1)  return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  return `${d}일 전`;
}

// SIM7080G 가 읽는 20자리 ICCID 의 마지막은 Luhn 체크 디짓.
// 1NCE API/포털은 19자리 canonical 을 사용하므로 그쪽을 prominent 표시.
function iccidCanonical(s) {
  if (!s) return '';
  return s.length === 20 ? s.slice(0, 19) : s;
}
function iccidShort(s) {
  const c = iccidCanonical(s);
  return c ? `…${c.slice(-8)}` : '';
}

// ─── 스타일 ─────────────────────────────────────────────
const s = {
  root: {
    flex: 1, minHeight: 0, minWidth: 0,
    display: 'flex', flexDirection: 'column',
    background: 'var(--bg)',
    height: '100%',
  },
  appHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px 20px',
    background: 'var(--surface)',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  subtabs: {
    display: 'flex', gap: 4,
    padding: '8px 12px',
    background: 'var(--surface)',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
    overflowX: 'auto', overflowY: 'hidden',
    whiteSpace: 'nowrap',
    WebkitOverflowScrolling: 'touch',
  },
  subtab: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '7px 14px',
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid transparent', borderRadius: 6,
    fontSize: 12, fontWeight: 500, cursor: 'pointer',
    whiteSpace: 'nowrap', flexShrink: 0,
  },
  subtabOn: {
    background: 'var(--surface-2)', color: 'var(--primary)',
    border: '1px solid var(--border)', fontWeight: 600,
  },
  body: { flex: 1, minHeight: 0, overflow: 'hidden' },

  viewWrap: {
    height: '100%', minHeight: 0,
    display: 'flex', flexDirection: 'column',
    padding: '12px 14px',
    gap: 10,
  },
  toolRow: {
    display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
    flexWrap: 'wrap',
  },
  input: {
    flex: 1, padding: '8px 10px',
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 6, color: 'var(--text)', fontSize: 12,
  },

  // 테이블 자체는 가로 스크롤 가능 — 모바일에서 fixed-px 컬럼들이 squeeze 되지 않도록.
  table: {
    flex: 1, minHeight: 0,
    display: 'flex', flexDirection: 'column',
    background: 'var(--surface)',
    border: '1px solid var(--border)', borderRadius: 8,
    overflow: 'auto',
    WebkitOverflowScrolling: 'touch',
  },
  tableHead: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '10px 14px',
    background: 'var(--surface-2)',
    borderBottom: '1px solid var(--border)',
    fontSize: 11, fontWeight: 700, color: 'var(--text-2)',
    textTransform: 'uppercase', letterSpacing: '.04em',
    flexShrink: 0,
    whiteSpace: 'nowrap',
    minWidth: 'fit-content',     // 자식 합산 폭 보장 — squeeze 방지
  },
  tableRow: {
    display: 'flex', alignItems: 'center', gap: 12,
    width: '100%', minWidth: 'fit-content',
    padding: '10px 14px',
    background: 'transparent', color: 'var(--text)',
    border: 'none',
    borderBottom: '1px solid var(--border)',
    cursor: 'pointer',
    fontSize: 12,
    textAlign: 'left',
    whiteSpace: 'nowrap',         // 글자 단위 wrap 방지
  },

  detailHead: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '12px 14px',
    background: 'var(--surface)',
    border: '1px solid var(--border)', borderRadius: 8,
    flexShrink: 0,
    flexWrap: 'wrap',
  },
  detailSub: { fontSize: 11, color: 'var(--text-2)', marginTop: 4 },
  backBtn: {
    width: 28, height: 28, borderRadius: 6,
    background: 'var(--surface-2)', color: 'var(--text)',
    border: '1px solid var(--border)', cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  roleBadge: {
    fontSize: 9, fontWeight: 700,
    padding: '1px 6px', borderRadius: 8,
    background: 'var(--primary)', color: 'var(--primary-fg)',
    textTransform: 'uppercase', letterSpacing: '.04em',
  },
  impBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '7px 12px',
    background: 'var(--primary)', color: 'var(--primary-fg)',
    border: 'none', borderRadius: 6,
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
  actionBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 12px',
    background: 'var(--primary)', color: 'var(--primary-fg)',
    border: 'none', borderRadius: 6,
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
  actionBtnSec: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 12px',
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 6,
    fontSize: 12, fontWeight: 500, cursor: 'pointer',
  },

  section: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8, padding: 14,
    flexShrink: 0,
  },
  sectionTitle: {
    fontWeight: 700, fontSize: 11, color: 'var(--text-2)',
    textTransform: 'uppercase', letterSpacing: '0.04em',
    marginBottom: 8,
  },
  metaGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: 6,
  },

  devCard: {
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 6, padding: 10,
  },
  topupBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '5px 9px',
    background: 'transparent', color: 'var(--primary)',
    border: '1px solid var(--primary)', borderRadius: 5,
    fontSize: 11, fontWeight: 500, cursor: 'pointer',
    whiteSpace: 'nowrap', flexShrink: 0,
  },
  nceBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '5px 9px',
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 5,
    fontSize: 11, fontWeight: 500, cursor: 'pointer',
    whiteSpace: 'nowrap', flexShrink: 0,
  },

  eventRow: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '6px 0',
    borderBottom: '1px solid var(--border)',
  },

  empty: {
    flex: 1, minHeight: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'var(--text-3)', fontSize: 12,
    padding: 24,
  },
  emptyInline: {
    color: 'var(--text-3)', fontSize: 12,
    padding: '12px 4px',
  },
};
