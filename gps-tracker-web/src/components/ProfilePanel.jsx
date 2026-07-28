// 내정보 패널 — 서브탭 구조: 계정 / 포인트 / 채팅 / 알림 / 테마.
// 채팅 탭은 admin 본인은 노출 안 함 (자기 자신과의 채팅 thread 가 admin inbox 에 잡히지 않게).
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, clearTokens } from '../api';
import Icon from './Icon';
import ChatPanel from './ChatPanel';
import NotificationSettings from './NotificationSettings';
import { currentTheme, toggleTheme } from '../theme';
import { confirmDialog, alertDialog, promptDialog } from './Dialog';

function initialProfileTab() {
  if (typeof window === 'undefined') return 'account';
  const v = localStorage.getItem('profile_tab');
  return ['account','credit','chat','notif','theme','lab'].includes(v) ? v : 'account';
}

// (2026-07-28) accountType + onAccountTypeChange 를 상위 Dashboard 에서 내려받음.
// 이전엔 AccountTypeCard 가 자체 fetch/state 를 유지해서 PATCH 성공 후 Dashboard 는
// stale — SideRail/BottomNav 가 corporate 탭 렌더 안 함 → 새로고침해야 반영되던 회귀.
export default function ProfilePanel({ onLogout, accountType, onAccountTypeChange }) {
  const [me, setMe] = useState(null);
  const [tab, setTabRaw] = useState(initialProfileTab);
  const setTab = (v) => { setTabRaw(v); try { localStorage.setItem('profile_tab', v); } catch {} };
  const [chatUnread, setChatUnread] = useState(0);

  useEffect(() => {
    api.getMe().then(setMe).catch(console.error);
  }, []);

  // 채팅 unread 폴링 — 탭 뱃지용
  useEffect(() => {
    if (me && me.role === 'admin') return;        // admin 은 채팅 탭 자체가 없음
    let iv;
    async function pull() {
      try {
        const t = await api.chatMyThread();
        setChatUnread(t.unread_for_user || 0);
      } catch { /* noop */ }
    }
    pull();
    iv = setInterval(pull, 10_000);
    return () => clearInterval(iv);
  }, [me]);

  if (!me) return <div style={{ color: 'var(--text-3)', padding: 16 }}>로딩...</div>;

  const isAdmin = me.role === 'admin';
  const tabs = [
    { id: 'account',  label: '계정',     icon: 'user' },
    { id: 'credit',   label: '포인트',   icon: 'coin' },
    ...(isAdmin ? [] : [
      { id: 'chat',   label: '관리자 채팅', icon: 'message', badge: chatUnread },
    ]),
    { id: 'notif',    label: '알림',     icon: 'warn' },
    { id: 'theme',    label: '테마',     icon: currentTheme() === 'dark' ? 'moon' : 'sun' },
    // 연구소 — 실험적 / 옵트인 기능. 안정화되면 다른 곳으로 옮겨가거나 default 화.
    { id: 'lab',      label: '연구소',   icon: 'spark' },
  ];

  return (
    <div style={st.wrap}>
      <div style={st.tabBar}>
        {tabs.map(t => {
          const on = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              style={{
                ...st.tabBtn,
                color: on ? 'var(--primary)' : 'var(--text-2)',
                background: on ? 'var(--surface-2)' : 'transparent',
                fontWeight: on ? 600 : 500,
                borderBottom: on ? '2px solid var(--primary)' : '2px solid transparent',
              }}>
              <Icon name={t.icon} size={14} />
              <span>{t.label}</span>
              {t.badge > 0 && (
                <span style={st.badge}>{t.badge}</span>
              )}
            </button>
          );
        })}
      </div>

      <div style={tab === 'chat' ? st.bodyFill : st.body}>
        {tab === 'account' && <AccountTab me={me} setMe={setMe} onLogout={onLogout}
          accountType={accountType} onAccountTypeChange={onAccountTypeChange} />}
        {tab === 'credit'  && <CreditTab />}
        {tab === 'chat'    && !isAdmin && <ChatTab onRead={() => setChatUnread(0)} />}
        {tab === 'notif'   && <NotifTab />}
        {tab === 'theme'   && <ThemeTab />}
        {tab === 'lab'     && <LabTab />}
      </div>
    </div>
  );
}

// ─── 계정 (이메일/이름/비번/탈퇴) ─────────────────────────
// (2026-07-28) accountType + onAccountTypeChange 는 ProfilePanel 이 상위 Dashboard 에서
// 받아서 여기까지 그대로 pass-through. AccountTypeCard 에 prop 으로 내려줌.
function AccountTab({ me, setMe, onLogout, accountType, onAccountTypeChange }) {
  const [name, setName]     = useState(me.display_name || '');
  const [savingProfile, setSavingProfile] = useState(false);

  const [pwOpen, setPwOpen] = useState(false);
  const [pwCur, setPwCur]   = useState('');
  const [pwNew, setPwNew]   = useState('');
  const [pwBusy, setPwBusy] = useState(false);

  const [delOpen, setDelOpen] = useState(false);
  const [delPw, setDelPw]     = useState('');
  const [delBusy, setDelBusy] = useState(false);

  async function saveProfile() {
    setSavingProfile(true);
    try {
      const next = await api.updateMe({ display_name: name || null });
      setMe(next);
    } catch (e) { alert(e.message); }
    finally { setSavingProfile(false); }
  }

  async function changePassword() {
    if (pwNew.length < 8) { alert('새 비밀번호는 8자 이상'); return; }
    setPwBusy(true);
    try {
      await api.changePassword(pwCur, pwNew);
      setPwOpen(false); setPwCur(''); setPwNew('');
      alert('비밀번호 변경 완료. 다시 로그인해주세요.');
      clearTokens(); onLogout();
    } catch (e) { alert('현재 비밀번호가 올바르지 않습니다.'); }
    finally { setPwBusy(false); }
  }

  async function deleteAccount() {
    if (!confirm('정말 회원탈퇴하시겠습니까? 모든 디바이스 데이터가 사라집니다.')) return;
    setDelBusy(true);
    try {
      await api.deleteMe(delPw);
      clearTokens(); onLogout();
    } catch (e) { alert('비밀번호가 올바르지 않습니다.'); }
    finally { setDelBusy(false); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Card>
        <Field label="이메일" value={me.email} />
        <Field label="권한"   value={me.role} />
      </Card>

      <AccountTypeCard cur={accountType} onChange={onAccountTypeChange} />

      <PhonesCard me={me} setMe={setMe} />

      <Card title="프로필">
        <input placeholder="이름 (표시될 이름)" value={name}
          onChange={e => setName(e.target.value)} style={st.input} />
        <button onClick={saveProfile} disabled={savingProfile}
          style={{ ...st.btn, marginTop: 8, opacity: savingProfile ? 0.6 : 1 }}>
          {savingProfile ? '저장 중...' : '저장'}
        </button>
      </Card>

      <Card title="보안">
        {!pwOpen ? (
          <button onClick={() => setPwOpen(true)} style={st.btnSecondary}>비밀번호 변경</button>
        ) : (
          <>
            <input type="password" placeholder="현재 비밀번호" value={pwCur}
              onChange={e => setPwCur(e.target.value)} style={st.input} />
            <input type="password" placeholder="새 비밀번호 (8자 이상)" value={pwNew}
              onChange={e => setPwNew(e.target.value)} style={{ ...st.input, marginTop: 6 }} />
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button onClick={changePassword} disabled={pwBusy} style={{ ...st.btn, flex: 1 }}>
                {pwBusy ? '...' : '변경'}
              </button>
              <button onClick={() => { setPwOpen(false); setPwCur(''); setPwNew(''); }}
                style={{ ...st.btnSecondary, flex: 1 }}>취소</button>
            </div>
          </>
        )}
      </Card>

      <CleanupCard />

      <Card title="계정">
        <button onClick={() => { clearTokens(); onLogout(); }} style={st.btnSecondary}>로그아웃</button>
        {!delOpen ? (
          <button onClick={() => setDelOpen(true)} style={{ ...st.btnDanger, marginTop: 8 }}>
            <Icon name="trash2" size={14} /> 회원탈퇴
          </button>
        ) : (
          <>
            <input type="password" placeholder="비밀번호 확인" value={delPw}
              onChange={e => setDelPw(e.target.value)} style={{ ...st.input, marginTop: 8 }} />
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button onClick={deleteAccount} disabled={delBusy} style={{ ...st.btnDanger, flex: 1 }}>
                {delBusy ? '...' : '탈퇴 확인'}
              </button>
              <button onClick={() => { setDelOpen(false); setDelPw(''); }}
                style={{ ...st.btnSecondary, flex: 1 }}>취소</button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

// ─── 데이터 일괄 정리 ─────────────────────────────────────
// 사용자가 한 번 입력했지만 더 이상 안 쓰는 부수 데이터 선택 정리.
// 비밀번호로 명시적 인증 후 진행.
function CleanupCard() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pw, setPw]     = useState('');
  const [opts, setOpts] = useState({
    corporate_info:   false,
    staff:            false,
    device_overrides: false,
  });
  const anySelected = Object.values(opts).some(v => v);

  async function run() {
    if (!anySelected) { alert('정리할 항목을 1개 이상 선택하세요.'); return; }
    if (!pw)          { alert('비밀번호를 입력하세요.');          return; }
    if (!confirm('선택한 데이터를 영구히 삭제합니다. 진행할까요?')) return;
    setBusy(true);
    try {
      const r = await api.cleanupMe({ password: pw, ...opts });
      const lines = [];
      if (r.corporate_info_deleted   != null) lines.push(`회사 정보: ${r.corporate_info_deleted}건 삭제`);
      if (r.staff_deleted            != null) lines.push(`직원 명단: ${r.staff_deleted}명 삭제`);
      if (r.device_overrides_cleared != null) lines.push(`디바이스 계정유형 오버라이드: ${r.device_overrides_cleared}대 정리`);
      alert('정리 완료\n' + lines.join('\n'));
      setOpen(false); setPw('');
      setOpts({ corporate_info: false, staff: false, device_overrides: false });
    } catch (e) {
      alert(e.message || '정리 실패');
    } finally { setBusy(false); }
  }

  return (
    <Card title="데이터 일괄 정리">
      {!open ? (
        <>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8, lineHeight: 1.5 }}>
            계정 유형을 자주 바꿔서 회사 정보 / 직원 명단 / 디바이스 오버라이드 등이 남았다면 일괄 정리할 수 있습니다.
          </div>
          <button onClick={() => setOpen(true)} style={st.btnSecondary}>정리 메뉴 열기</button>
        </>
      ) : (
        <>
          <CheckRow
            checked={opts.corporate_info}
            onChange={v => setOpts(o => ({ ...o, corporate_info: v }))}
            label="회사 정보"
            desc="사업자 등록번호 / 회사명 / 주소 / 대표자 (corporate_fleet 유형에 사용)"
          />
          <CheckRow
            checked={opts.staff}
            onChange={v => setOpts(o => ({ ...o, staff: v }))}
            label="직원 명단"
            desc="등록한 직원 모두 삭제. 운행 일지의 운전자 참조는 NULL 처리됨 (이력 보존)"
          />
          <CheckRow
            checked={opts.device_overrides}
            onChange={v => setOpts(o => ({ ...o, device_overrides: v }))}
            label="디바이스 계정유형 오버라이드"
            desc="device 별 account_type_override 를 NULL 로 — 사용자 기본 유형 따름"
          />
          <input type="password" placeholder="비밀번호 확인" value={pw}
            onChange={e => setPw(e.target.value)}
            style={{ ...st.input, marginTop: 10 }} />
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button onClick={run} disabled={busy || !anySelected || !pw}
              style={{ ...st.btnDanger, flex: 1, opacity: (!anySelected || !pw || busy) ? 0.5 : 1 }}>
              {busy ? '정리 중...' : '선택 항목 정리'}
            </button>
            <button onClick={() => { setOpen(false); setPw(''); }}
              style={{ ...st.btnSecondary, flex: 1 }}>취소</button>
          </div>
        </>
      )}
    </Card>
  );
}

function CheckRow({ checked, onChange, label, desc }) {
  return (
    <label style={{
      display: 'flex', alignItems: 'flex-start', gap: 8,
      padding: '8px 10px', marginBottom: 6,
      background: 'var(--surface-2)', borderRadius: 6,
      border: '1px solid var(--border)',
      cursor: 'pointer',
    }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
        style={{ marginTop: 2, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, lineHeight: 1.5 }}>{desc}</div>
      </div>
    </label>
  );
}

// ─── 계정 유형 (운영 성격) ─────────────────────────────
// rentcar / corporate_fleet / delivery / unspecified
// 유형마다 특화 메뉴 (예: corporate_fleet → 법인운행 리포트) 가 활성화됨.
const TYPE_META = {
  unspecified:     { label: '미지정',         icon: 'spark', desc: '운영 성격을 정하면 맞춤 메뉴가 활성화됩니다.' },
  rentcar:         { label: '렌트카 운영',    icon: 'list',  desc: '렌탈 차량 — 차량별 사용자 매칭/대여 이력 관리 (개발 중)' },
  corporate_fleet: { label: '법인차 운영',    icon: 'list',  desc: '회사 차량 — 운행일지, 운전자/유류 관리, 인쇄 가능한 운행 리포트' },
  delivery:        { label: '배달 운영',      icon: 'list',  desc: '배달 — 건별 추적, 평균 운행 시간 (개발 중)' },
};

// ─── 휴대폰 (다중 번호 + OTP 인증) ─────────────────────
//
// 메인(primary) 번호 하나 + 부가 번호 여러 개. 추가는 OTP 인증 거쳐야 등록.
// 다른 사용자가 인증한 번호는 추가 못 함 (글로벌 중복 차단).
function PhonesCard({ me, setMe }) {
  const [phones, setPhones] = useState(null);
  const [adding, setAdding] = useState(false);
  // 모달 prefill — 미인증 번호 "재인증" 클릭 시 기존 번호 + 메인 여부 자동 채워줌.
  const [prefill, setPrefill] = useState(null);   // { phone, setPrimary } | null

  async function refresh() {
    try {
      const list = await api.listPhones();
      setPhones(list || []);
      // me 의 phone/phone_verified 도 갱신 — 메인 번호가 바뀌었을 수 있음
      const next = await api.getMe();
      setMe(next);
    } catch { setPhones([]); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  async function promote(id) {
    if (!confirm('이 번호를 메인 번호로 변경하시겠어요?')) return;
    try {
      await api.setPrimaryPhone(id);
      await refresh();
    } catch (e) { alert(e.message); }
  }
  async function remove(id) {
    if (!confirm('이 번호를 삭제하시겠어요?')) return;
    try {
      await api.deletePhone(id);
      await refresh();
    } catch (e) { alert(e.message); }
  }

  return (
    <Card title="휴대폰">
      {phones === null
        ? <div style={{ fontSize: 12, color: 'var(--text-3)' }}>로딩...</div>
        : phones.length === 0
          ? <div style={{ fontSize: 12, color: 'var(--text-3)' }}>등록된 번호가 없습니다.</div>
          : phones.map(p => (
              <div key={p.id} style={phs.row}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    {p.phone}
                    {p.is_primary && <span style={st.badgeOk}>메인</span>}
                    {!p.is_verified && <span style={st.badgeWarn}>미인증</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {!p.is_verified && (
                    <button onClick={() => {
                      setPrefill({ phone: p.phone, setPrimary: p.is_primary });
                      setAdding(true);
                    }} style={{ ...phs.btnSmall, color: 'var(--primary)' }}>재인증</button>
                  )}
                  {!p.is_primary && p.is_verified && (
                    <button onClick={() => promote(p.id)} style={phs.btnSmall}>메인으로</button>
                  )}
                  {!p.is_primary && (
                    <button onClick={() => remove(p.id)}
                      style={{ ...phs.btnSmall, color: 'var(--danger)' }}>삭제</button>
                  )}
                </div>
              </div>
            ))
      }
      <button onClick={() => { setPrefill(null); setAdding(true); }}
        style={{ ...st.btnSecondary, width: '100%', marginTop: 8 }}>
        + 새 번호 추가
      </button>
      {adding && (
        <AddPhoneModal
          onClose={() => { setAdding(false); setPrefill(null); }}
          onAdded={refresh}
          hasAny={(phones || []).length > 0}
          prefill={prefill}
        />
      )}
    </Card>
  );
}

// 번호 추가/재인증 — OTP 발송 → 인증 → 등록 / (옵션) 메인 승격.
//
// prefill 이 주어지면 기존 미인증 번호 재인증 모드로 시작.
// 사용자는 같은 번호 그대로 인증할 수도, 다른 번호로 바꿔 입력할 수도 있음.
function AddPhoneModal({ onClose, onAdded, hasAny, prefill }) {
  const [phone, setPhone] = useState(prefill?.phone || '');
  const [otp, setOtp]     = useState('');
  const [sent, setSent]   = useState(false);
  const [setPrimary, setSetPrimary] = useState(prefill ? !!prefill.setPrimary : !hasAny);
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);
  const [remaining, setRemaining] = useState(0);   // 만료 카운트다운 (초)
  const isReverify = !!prefill;

  useEffect(() => {
    if (!sent) return;
    const t = setInterval(() => setRemaining(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [sent]);

  async function handleSend() {
    setError(null); setBusy(true);
    try {
      const r = await api.sendPhoneOtp(phone.trim());
      setSent(true);
      setRemaining(r.expires_in_sec || 180);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function handleVerify() {
    setError(null); setBusy(true);
    try {
      await api.verifyPhone(phone.trim(), otp.trim(), setPrimary);
      onAdded();
      onClose();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    // 외부 클릭으로 닫히지 않음 — OTP 입력 도중 실수 방지.
    <div style={phs.backdrop}>
      <div style={phs.modal}>
        <div style={phs.title}>{isReverify ? '번호 재인증 / 변경' : '번호 추가'}</div>
        {isReverify && (
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8, lineHeight: 1.5 }}>
            본인 번호로 인증하세요. 다른 번호로 변경 시, 기존 미인증 번호는 부가 번호로 남으며 별도 삭제 가능합니다.
          </div>
        )}
        <input placeholder="010xxxxxxxx" value={phone}
          onChange={e => setPhone(e.target.value)}
          disabled={sent}
          style={st.input} />

        {!sent ? (
          <button onClick={handleSend} disabled={busy || phone.length < 10}
            style={{ ...st.btn, width: '100%', marginTop: 8 }}>
            {busy ? '...' : '인증번호 받기'}
          </button>
        ) : (
          <>
            <input placeholder="인증번호 4자리" value={otp}
              onChange={e => setOtp(e.target.value)}
              style={{ ...st.input, marginTop: 8 }}
              maxLength={4} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12 }}>
              <input type="checkbox" checked={setPrimary}
                onChange={e => setSetPrimary(e.target.checked)} />
              메인 번호로 설정
            </label>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
              남은 시간: {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2,'0')}
            </div>
            <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
              <button onClick={handleVerify} disabled={busy || otp.length < 4 || remaining === 0}
                style={{ ...st.btn, flex: 1 }}>
                {busy ? '...' : '확인'}
              </button>
              <button onClick={() => { setSent(false); setOtp(''); }} style={st.btnSecondary}>
                재전송
              </button>
            </div>
          </>
        )}
        {error && <div style={{ marginTop: 8, fontSize: 11, color: 'var(--danger)' }}>{error}</div>}
        <button onClick={onClose} style={{ ...st.btnSecondary, width: '100%', marginTop: 8 }}>
          취소
        </button>
      </div>
    </div>
  );
}

const phs = {
  row: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 8, padding: '6px 0',
    borderBottom: '1px solid var(--border)',
  },
  btnSmall: {
    padding: '4px 8px', fontSize: 11,
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 4,
    cursor: 'pointer',
  },
  backdrop: {
    position: 'fixed', inset: 0, zIndex: 950,
    background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16,
  },
  modal: {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 12, padding: 16,
    width: '100%', maxWidth: 360,
  },
  title: { fontSize: 14, fontWeight: 700, marginBottom: 10, color: 'var(--text)' },
};

// (2026-07-28) cur/onChange 를 상위에서 내려받음 (dual-state 제거).
// 이전 자체 state 유지 구조는 Dashboard 의 accountType 과 어긋나 SideRail/BottomNav
// 리렌더 안 됨 → 계정 유형 바꿔도 새로고침 전엔 corporate 탭 안 나타남.
function AccountTypeCard({ cur, onChange }) {
  const [busy, setBusy] = useState(false);

  async function pick(type) {
    if (type === cur) return;
    setBusy(true);
    try {
      const r = await api.setAccountType(type);
      onChange?.(r.account_type);
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!cur) return null;

  return (
    <Card title="계정 유형">
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8 }}>
        {TYPE_META[cur]?.desc || ''}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {Object.entries(TYPE_META).map(([id, meta]) => {
          const on = cur === id;
          return (
            <button key={id} onClick={() => pick(id)} disabled={busy}
              style={{
                padding: '10px 8px',
                background: on ? 'var(--primary)' : 'var(--surface)',
                color:      on ? 'var(--primary-fg)' : 'var(--text)',
                border: on ? 'none' : '1px solid var(--border)',
                borderRadius: 8,
                cursor: busy ? 'not-allowed' : 'pointer',
                fontSize: 12, fontWeight: on ? 700 : 500,
                textAlign: 'left',
                opacity: busy ? 0.6 : 1,
              }}>
              {meta.label}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

// ─── 포인트 ─────────────────────────────────────────────
function CreditTab() {
  const [balance, setBalance] = useState(null);
  const [log,     setLog]     = useState([]);
  const [requests, setRequests] = useState([]);
  const [open,    setOpen]    = useState(false);
  const [amount,  setAmount]  = useState(10000);
  const [busy,    setBusy]    = useState(false);

  async function refresh() {
    try {
      const [b, l, r] = await Promise.all([
        api.getCreditBalance(),
        api.getCreditLog(),
        api.listMyCreditRequests(),
      ]);
      setBalance(b.balance);
      setLog(l || []);
      setRequests(r || []);
    } catch { /* noop */ }
  }
  useEffect(() => {
    refresh();
    // pending 요청이 있으면 polling — 관리자가 승인했는지 보기 위해
    const iv = setInterval(refresh, 15_000);
    return () => clearInterval(iv);
  }, []);

  async function submitRequest() {
    setBusy(true);
    try {
      await api.createCreditRequest(amount, null);
      setOpen(false);
      refresh();
      await alertDialog({
        title: '요청 전송 완료',
        body: `${amount.toLocaleString()}원 충전 요청을 보냈습니다. 관리자 승인 후 즉시 반영됩니다.`,
        tone: 'success',
      });
    } catch (e) {
      await alertDialog({ title: '요청 실패', body: e.message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  const REASON = {
    topup:           '충전',
    ai_analysis:     'AI 분석',
    ai_refund:       'AI 환불',
    sim_topup:       'SIM 충전',
    sim_topup_refund:'SIM 환불',
    admin_grant:     '관리자 지급',
    share_create:    '공유 링크 생성',
    share_extend:    '공유 링크 연장',
  };
  const REQ_STATUS = {
    pending:   { label: '대기', color: 'var(--warning, #fbbf24)' },
    approved:  { label: '승인 완료', color: 'var(--accent)' },
    rejected:  { label: '반려됨', color: 'var(--danger)' },
    cancelled: { label: '취소됨', color: 'var(--text-3)' },
  };

  const pendingReqs = requests.filter(r => r.status === 'pending');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Card>
        <div style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          marginBottom: 8,
        }}>
          <span style={{ fontSize: 11, color: 'var(--text-2)' }}>보유 포인트</span>
          <span style={{ fontSize: 26, fontWeight: 700, color: 'var(--text)' }}>
            {balance != null ? balance.toLocaleString() : '—'}
            <span style={{ fontSize: 13, color: 'var(--text-3)', marginLeft: 4 }}>원</span>
          </span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 10 }}>
          1 credit = 1 KRW · AI 분석 회당 20원, SIM 100MB = 100원
        </div>

        {!open ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setOpen(true)}
              style={{ ...st.btnSecondary, flex: 1, fontWeight: 600 }}>
              포인트 충전 요청
            </button>
            <TossPayButton amount={null} onPaid={refresh} fullWidth />
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 6 }}>
              {[10000, 30000, 50000, 100000].map(v => (
                <button key={v} onClick={() => setAmount(v)}
                  style={{
                    ...st.btnSecondary, flex: 1,
                    padding: '6px 4px', fontSize: 11,
                    border: amount === v ? '1px solid var(--primary)' : '1px solid var(--border)',
                    color: amount === v ? 'var(--primary)' : 'var(--text)',
                  }}>
                  {(v/10000).toFixed(0)}만
                </button>
              ))}
            </div>
            <input type="number" value={amount} min={1000}
              onChange={e => setAmount(parseInt(e.target.value, 10) || 0)}
              style={{ ...st.input, marginTop: 6 }} />
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button onClick={submitRequest} disabled={busy || amount <= 0}
                style={{ ...st.btn, flex: 1, opacity: busy ? 0.6 : 1 }}>
                {busy ? '...' : `${amount.toLocaleString()}원 요청`}
              </button>
              <button onClick={() => { setOpen(false); }}
                style={{ ...st.btnSecondary, flex: 1 }}>취소</button>
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <TossPayButton amount={amount} onPaid={refresh} fullWidth />
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 6 }}>
              * 요청 = 관리자 승인 후 반영. 직접 결제 = Toss 카드/간편결제 즉시 충전.
            </div>
          </>
        )}
      </Card>

      {/* 통합 거래 내역 — 충전 요청·승인/반려·소비·환불·관리자 지급·직접 결제 모두 시간순.
          승인된 충전 요청은 credit_log 의 ref_id 로 매칭해 중복 표시 차단. */}
      <Card>
        <div style={st.cardTitle}>
          거래 내역
          {pendingReqs.length > 0 && (
            <span style={{
              marginLeft: 6, fontSize: 11, color: 'var(--warning, #fbbf24)',
              fontWeight: 600,
            }}>· 대기 {pendingReqs.length}</span>
          )}
        </div>
        {(() => {
          const events = [];
          for (const r of requests) {
            // request 모델은 created_at 이 아닌 requested_at 필드 사용 — 혼동 주의.
            events.push({
              kind: 'request', id: `r${r.id}`,
              sortAt: r.requested_at, raw: r,
            });
          }
          for (const e of log) {
            // 관리자 승인으로 만들어진 topup 은 위 request 행에서 이미 표시됨 → 중복 제거
            if (e.reason === 'topup' && e.ref_id != null) continue;
            events.push({
              kind: 'log', id: `l${e.id}`,
              sortAt: e.created_at, raw: e,
            });
          }
          events.sort((a, b) => new Date(b.sortAt) - new Date(a.sortAt));

          if (events.length === 0) {
            return <div style={{ fontSize: 12, color: 'var(--text-3)' }}>아직 거래 내역이 없습니다.</div>;
          }

          return (
            // paddingRight: 스크롤바와 상태 배지/금액 사이 숨 쉴 공간 확보.
            <div style={{ maxHeight: 480, overflowY: 'auto', paddingRight: 8 }}>
              {events.map(ev =>
                ev.kind === 'request'
                  ? <CreditReqRow key={ev.id} r={ev.raw} REQ_STATUS={REQ_STATUS} onCancelled={refresh} />
                  : <CreditLogRow  key={ev.id} e={ev.raw} REASON={REASON} />
              )}
            </div>
          );
        })()}
      </Card>
    </div>
  );
}

// 통합 타임라인 안의 credit_log 한 줄. ref_id null + reason='topup' 은 직접 결제(Toss).
function CreditLogRow({ e, REASON }) {
  const isDirectPay = e.reason === 'topup' && e.ref_id == null;
  const title = isDirectPay ? '직접 결제 (Toss)' : (REASON[e.reason] || e.reason);
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      fontSize: 11, padding: '8px 0',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ color: 'var(--text)', fontSize: 12, fontWeight: 500 }}>{title}</div>
        <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
          {new Date(e.created_at).toLocaleString('ko-KR')}
        </div>
      </div>
      <div style={{ textAlign: 'right', marginLeft: 8 }}>
        <div style={{
          color: e.delta >= 0 ? 'var(--accent)' : 'var(--danger)',
          fontWeight: 600, fontSize: 13,
        }}>
          {e.delta > 0 ? '+' : ''}{e.delta.toLocaleString()}원
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-3)' }}>
          잔액 {e.balance.toLocaleString()}
        </div>
      </div>
    </div>
  );
}

// Toss SDK 동적 로딩 — `https://js.tosspayments.com/v1/payment` script.
// 한 번만 로드, 이후 호출은 캐시된 Promise 재사용.
let _tossScriptPromise = null;
function loadTossSDK() {
  if (window.TossPayments) return Promise.resolve(window.TossPayments);
  if (_tossScriptPromise) return _tossScriptPromise;
  _tossScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://js.tosspayments.com/v1/payment';
    s.async = true;
    s.onload  = () => resolve(window.TossPayments);
    s.onerror = () => { _tossScriptPromise = null; reject(new Error('Toss SDK 로드 실패')); };
    document.head.appendChild(s);
  });
  return _tossScriptPromise;
}

// 우리가 토스에서 승인받은 결제수단 (이미지 참조).
const TOSS_METHODS = [
  { id: '카드',     label: '신용·체크카드', desc: '국민·하나·BC·신한·삼성·현대·롯데·농협·우리' },
  { id: '계좌이체', label: '계좌이체',      desc: '실시간 이체 — 즉시 충전' },
  { id: '가상계좌', label: '가상계좌',      desc: '발급 후 입금 — 입금 확인 시 자동 충전' },
];

// Toss 직접 결제 버튼.
//   amount: null 이면 사용자에게 prompt 로 금액 받음.
//   onPaid: 결제 redirect 직전 호출 (실 잔액 갱신은 redirect 복귀 후).
function TossPayButton({ amount: amountProp, onPaid, fullWidth }) {
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerAmount, setPickerAmount] = useState(amountProp || 0);

  async function startFlow() {
    // 1) 백엔드 cfg
    const cfg = await api.tossConfig();
    if (!cfg.enabled || !cfg.client_key) {
      await alertDialog({
        title: 'Toss 결제 미설정',
        body: '서버에 TOSS_CLIENT_KEY 가 설정되지 않았습니다.',
        tone: 'warn',
      });
      return;
    }

    // 2) 금액 결정
    let amount = amountProp;
    if (!amount || amount < 1000) {
      const v = await promptDialog({
        title: '직접 결제 — 금액',
        body: '1,000 ~ 1,000,000 원',
        placeholder: '예: 30000',
        defaultValue: '10000',
        confirmLabel: '다음',
      });
      if (v === null) return;
      amount = parseInt(v, 10);
      if (!(amount >= 1000 && amount <= 1_000_000)) {
        await alertDialog({ title: '금액 오류', body: '1,000 ~ 1,000,000 원만 가능', tone: 'warn' });
        return;
      }
    }
    setPickerAmount(amount);
    setPickerOpen(true);   // 결제수단 선택 모달 노출
  }

  async function payWithMethod(methodId) {
    setPickerOpen(false);
    setBusy(true);
    try {
      const init = await api.tossInit(pickerAmount);
      const TossPayments = await loadTossSDK();
      const tp = TossPayments(init.client_key);
      const me = await api.getMe().catch(() => null);

      const base = window.location.origin
        + (window.location.pathname.startsWith('/gps-tracker/app/')
            ? '/gps-tracker/app' : '');

      onPaid?.();

      tp.requestPayment(methodId, {
        amount:    pickerAmount,
        orderId:   init.order_id,
        orderName: init.order_name,
        successUrl: `${base}/payments/toss/success`,
        failUrl:    `${base}/payments/toss/fail`,
        customerEmail: me?.email || undefined,
        customerName:  me?.display_name || undefined,
      }).catch(async (err) => {
        await alertDialog({
          title: '결제 취소됨',
          body: err?.message || '결제를 진행할 수 없습니다.',
          tone: 'warn',
        });
      });
    } catch (e) {
      await alertDialog({ title: '결제 오류', body: e.message || '실패', tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button onClick={startFlow} disabled={busy}
        style={{
          ...st.btn,
          flex: fullWidth ? 1 : undefined,
          background: 'linear-gradient(135deg, #3182f6 0%, #1d6ed8 100%)',
          color: 'white',
          opacity: busy ? 0.6 : 1,
          whiteSpace: 'nowrap',
        }}>
        {busy ? '...' : (amountProp ? `${amountProp.toLocaleString()}원 직접 결제` : '직접 결제')}
      </button>

      {/* 결제수단 선택 모달 — 외부 다이얼로그 시스템 활용 못 해서 여기서 직접 렌더 */}
      {pickerOpen && (
        <div style={pst.backdrop} onClick={() => setPickerOpen(false)}>
          <div style={pst.modal} onClick={e => e.stopPropagation()}>
            <div style={pst.title}>결제수단 선택</div>
            <div style={pst.subtitle}>{pickerAmount.toLocaleString()}원 충전</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
              {TOSS_METHODS.map(m => (
                <button key={m.id} onClick={() => payWithMethod(m.id)}
                  style={pst.methodBtn}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{m.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{m.desc}</div>
                </button>
              ))}
            </div>
            <button onClick={() => setPickerOpen(false)} style={pst.cancelBtn}>닫기</button>
          </div>
        </div>
      )}
    </>
  );
}

// picker 모달 스타일
const pst = {
  backdrop: {
    position: 'fixed', inset: 0, zIndex: 950,
    background: 'rgba(0,0,0,0.5)',
    backdropFilter: 'blur(4px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16,
    animation: 'fadeInUp .15s ease-out',
  },
  modal: {
    width: '100%', maxWidth: 380,
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 14,
    padding: 20,
    boxShadow: '0 20px 60px rgba(0,0,0,.4)',
    animation: 'fadeInUp .18s ease-out',
  },
  title:    { fontSize: 16, fontWeight: 700 },
  subtitle: { fontSize: 12, color: 'var(--text-2)', marginTop: 2 },
  methodBtn: {
    padding: '12px 14px', textAlign: 'left',
    background: 'var(--surface-2)', border: '1px solid var(--border)',
    borderRadius: 10, cursor: 'pointer',
  },
  cancelBtn: {
    width: '100%', marginTop: 12, padding: 10,
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 8,
    fontSize: 13, cursor: 'pointer',
  },
};

// 한 줄 — pending 이면 취소 버튼.
function CreditReqRow({ r, REQ_STATUS, onCancelled }) {
  const [busy, setBusy] = useState(false);
  const s = REQ_STATUS[r.status] || { label: r.status, color: 'var(--text-2)' };

  async function cancel() {
    const ok = await confirmDialog({
      title: '충전 요청 취소',
      body: `요청 #${r.id} (${r.amount.toLocaleString()}원) 을(를) 취소하시겠어요?`,
      confirmLabel: '취소하기',
      cancelLabel: '닫기',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.cancelMyCreditRequest(r.id);
      onCancelled?.();
    } catch (e) {
      // 409 = 그 사이 관리자가 승인/반려한 경우. 가장 흔한 race
      await alertDialog({
        title: '취소 실패',
        body: e.message || '이미 처리된 요청일 수 있습니다.',
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
      fontSize: 12, padding: '6px 0', gap: 8,
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ color: 'var(--text)', fontWeight: 600 }}>
          #{r.id} · {r.amount.toLocaleString()}원
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-3)' }}>
          {new Date(r.requested_at).toLocaleString('ko-KR')}
          {r.note ? ` · ${r.note}` : ''}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: s.color, fontWeight: 600, fontSize: 11 }}>
          {s.label}
        </span>
        {r.status === 'pending' && (
          <button onClick={cancel} disabled={busy}
            style={{
              padding: '3px 8px', fontSize: 11,
              background: 'transparent', color: 'var(--danger)',
              border: '1px solid var(--danger)', borderRadius: 4,
              cursor: 'pointer', opacity: busy ? 0.5 : 1,
            }}>
            {busy ? '...' : '취소'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── 채팅 ───────────────────────────────────────────────
// 부모(st.bodyFill) 가 flex 컨테이너이므로 여기서 flex:1 로 남은 높이 전부 차지.
// ChatPanel 의 wrap 도 flex:1 로 받아 입력바 + 스크롤 영역을 화면 끝까지 늘림.
function ChatTab({ onRead }) {
  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column',
      background: 'var(--surface-2)',
      border: '1px solid var(--border)',
      borderRadius: 10, padding: 12,
    }}>
      <div style={{ ...st.cardTitle, marginBottom: 6, flexShrink: 0 }}>관리자 채팅</div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8, flexShrink: 0 }}>
        SIM 충전, 결제, 기타 문의를 자유롭게 보내주세요. 관리자가 확인 후 답변합니다.
      </div>
      <ChatPanel onRead={onRead} />
    </div>
  );
}

// ─── 알림 ───────────────────────────────────────────────
function NotifTab() {
  return (
    <Card>
      <div style={{ ...st.cardTitle, marginBottom: 8 }}>알림 설정</div>
      <NotificationSettings />
    </Card>
  );
}

// ─── 테마 ───────────────────────────────────────────────
function ThemeTab() {
  const [, force] = useState(0);
  const cur = currentTheme();
  return (
    <Card>
      <div style={{ ...st.cardTitle, marginBottom: 8 }}>화면 테마</div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 10 }}>
        현재: <b style={{ color: 'var(--text)' }}>{cur === 'dark' ? '다크' : '라이트'}</b>
      </div>
      <button onClick={() => { toggleTheme(); force(x => x + 1); }} style={{
        ...st.btnSecondary,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      }}>
        <Icon name={cur === 'dark' ? 'sun' : 'moon'} size={14} />
        {cur === 'dark' ? '라이트로 전환' : '다크로 전환'}
      </button>
    </Card>
  );
}

// ─── 연구소 — 실험적/옵트인 기능 토글 모음 ───────────────
// 안정화되면 default ON 또는 별도 위치 이전. 현재는 사용자가 명시 ON 해야 동작.
function LabTab() {
  const navigate = useNavigate();
  const [prefs, setPrefs] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getMyPrefs().then(p => setPrefs(p || {})).catch(() => setPrefs({}));
  }, []);

  async function togglePref(key, next) {
    if (busy) return;
    setBusy(true);
    setPrefs(p => ({ ...p, [key]: next }));   // optimistic
    try {
      const p = await api.patchMyPrefs({ [key]: next });
      setPrefs(p);
    } catch (e) {
      setPrefs(p => ({ ...p, [key]: !next }));   // rollback
      alertDialog({ title: '저장 실패', body: e.message || '알 수 없는 오류' });
    } finally {
      setBusy(false);
    }
  }

  if (!prefs) return <Card><div style={{ fontSize: 12, color: 'var(--text-3)' }}>로딩...</div></Card>;

  return (
    <>
      <Card>
        <div style={{ ...st.cardTitle, marginBottom: 8 }}>실험 기능</div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 12 }}>
          ⚗️ 안정화되지 않은 기능들. 사용해보고 어색하면 끄세요.
        </div>

        <LabToggleRow
          label="오늘 첫 열람 — 어제 운행 요약 팝업"
          desc={
            <>
              디바이스를 잡으면 어제 운행 요약 (이동거리 · 운행시간 · 정지구간 · 최고속도) 을 띄움.<br />
              <b>OFF</b>: 디바이스별 최초 1회만 노출 (인트로).&nbsp;
              <b>ON</b>: 디바이스를 잡을 때마다 매번 노출.
            </>
          }
          on={!!prefs.lab_first_view_summary}
          onChange={(v) => togglePref('lab_first_view_summary', v)}
          busy={busy}
        />

        <LabToggleRow
          label="사이클 seeker — wake/sleep 단위 탐색 + 삭제"
          desc={
            <>
              seeker 에 사이클 목록 추가. boot/wake → sleep_enter 묶음별로 보기 / 삭제 가능.<br />
              테스트 사이클 누적 데이터 정리에 유용. <b>주의:</b> 삭제 시 해당 사이클 events + location_records 모두 영구 삭제.
            </>
          }
          on={!!prefs.lab_cycle_seeker}
          onChange={(v) => togglePref('lab_cycle_seeker', v)}
          busy={busy}
        />
      </Card>

      <Card>
        <div style={{ ...st.cardTitle, marginBottom: 8 }}>도구</div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 10 }}>
          1회성 인트로 / 튜토리얼을 다시 보거나 reset 합니다.
        </div>
        <button
          onClick={() => navigate('/devices/pair?tutorial=1')}
          className="btn-bounce"
          style={{
            ...st.btnSecondary,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}>
          <Icon name="route" size={14} />
          페어링 튜토리얼 다시 보기
        </button>
      </Card>
    </>
  );
}

function LabToggleRow({ label, desc, on, onChange, busy }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      gap: 12, padding: '10px 0',
      borderTop: '1px solid var(--border)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{label}</div>
        {desc && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.5 }}>{desc}</div>}
      </div>
      <button onClick={() => !busy && onChange(!on)}
        disabled={busy}
        style={{
          position: 'relative', width: 40, height: 22, borderRadius: 11,
          border: 'none', padding: 0,
          cursor: busy ? 'wait' : 'pointer',
          background: on ? 'var(--primary)' : 'var(--surface-2)',
          transition: 'background .15s',
          flexShrink: 0,
        }}>
        <span style={{
          position: 'absolute', top: 2, left: 2,
          width: 18, height: 18, borderRadius: 9,
          background: 'white',
          transform: `translateX(${on ? 18 : 0}px)`,
          transition: 'transform .15s',
        }} />
      </button>
    </div>
  );
}

// ─── 공용 sub-컴포넌트 ─────────────────────────────────
function Card({ title, children }) {
  return (
    <div style={st.card}>
      {title && <div style={st.cardTitle}>{title}</div>}
      {children}
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div style={st.row}>
      <span style={{ color: 'var(--text-2)', fontSize: 12 }}>{label}</span>
      <span style={{ color: 'var(--text)', fontSize: 13 }}>{value || '—'}</span>
    </div>
  );
}

const st = {
  wrap: {
    display: 'flex', flexDirection: 'column',
    height: '100%', minHeight: 0,
  },
  tabBar: {
    display: 'flex', overflowX: 'auto',
    background: 'var(--surface)',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
    scrollbarWidth: 'thin',
  },
  tabBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '10px 12px',
    background: 'transparent',
    border: 'none',
    fontSize: 12, cursor: 'pointer',
    whiteSpace: 'nowrap', flexShrink: 0,
    transition: 'background .12s, color .12s',
  },
  badge: {
    minWidth: 16, height: 16, padding: '0 5px',
    background: 'var(--danger)', color: 'white',
    borderRadius: 8, fontSize: 9, fontWeight: 700,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    marginLeft: 2,
  },
  badgeOk: {
    fontSize: 9, fontWeight: 700,
    background: 'var(--accent)', color: 'white',
    borderRadius: 4, padding: '2px 6px',
  },
  badgeWarn: {
    fontSize: 9, fontWeight: 700,
    background: 'var(--warning, #fbbf24)', color: '#1A1A2E',
    borderRadius: 4, padding: '2px 6px',
  },
  body: {
    flex: 1, minHeight: 0, overflowY: 'auto', padding: 12,
  },
  // 채팅 탭 전용 — 안 스크롤 + flex 컨테이너로 자식이 남은 높이 다 차지하게.
  bodyFill: {
    flex: 1, minHeight: 0, padding: 12,
    display: 'flex', flexDirection: 'column',
  },
  card: {
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 10, padding: 12,
  },
  cardTitle: {
    fontWeight: 700, fontSize: 11, color: 'var(--text-2)',
    textTransform: 'uppercase', letterSpacing: '0.04em',
    marginBottom: 8,
  },
  row: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '6px 0',
  },
  input: {
    display: 'block', width: '100%', padding: '8px 10px',
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 6, color: 'var(--text)', fontSize: 13,
    boxSizing: 'border-box',
  },
  btn: {
    display: 'block', width: '100%', padding: 9,
    background: 'var(--primary)', color: 'var(--primary-fg)',
    border: 'none', borderRadius: 6,
    fontWeight: 600, fontSize: 13, cursor: 'pointer',
  },
  btnSecondary: {
    display: 'block', width: '100%', padding: 9,
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6,
    fontSize: 13, cursor: 'pointer',
  },
  btnDanger: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    width: '100%', padding: 9,
    background: 'transparent', color: 'var(--danger)',
    border: '1px solid var(--danger)', borderRadius: 6,
    fontSize: 13, cursor: 'pointer', fontWeight: 600,
  },
};
