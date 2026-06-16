import { useEffect, useState } from 'react';
import { api, setTokens } from '../api';

export default function Auth({ onLogin }) {
  const [tab, setTab]           = useState('login');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone]       = useState('');
  const [otpCode, setOtpCode]   = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  // OTP 단계
  const [otpSent, setOtpSent] = useState(false);
  const [otpExpiresAt, setOtpExpiresAt] = useState(null);
  const [otpRemain, setOtpRemain] = useState(null);
  const [tick, setTick] = useState(0);
  // 로그인 기억하기 — true 면 30일, false 면 1일 (브라우저 닫으면 sessionStorage 도 사라짐).
  const [rememberMe, setRememberMe] = useState(true);

  // 모달
  const [findIdOpen, setFindIdOpen] = useState(false);
  const [resetOpen, setResetOpen]   = useState(false);

  useEffect(() => {
    if (!otpExpiresAt) return;
    const iv = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, [otpExpiresAt]);
  const otpSecondsLeft = otpExpiresAt
    ? Math.max(0, Math.floor((otpExpiresAt - Date.now()) / 1000))
    : 0;
  const otpExpired = otpSent && otpSecondsLeft === 0;

  function switchTab(t) {
    setTab(t); setError(''); setOtpSent(false); setOtpCode(''); setOtpExpiresAt(null);
  }

  async function handleSendOtp() {
    setError('');
    if (!phone.trim()) { setError('휴대폰 번호를 입력하세요.'); return; }
    setLoading(true);
    try {
      const r = await api.sendOtp(phone);
      setOtpSent(true);
      setOtpExpiresAt(Date.now() + (r.expires_in_sec || 180) * 1000);
      setOtpRemain(r.remaining_today);
      setOtpCode('');
      if (r.dev_code) setOtpCode(r.dev_code);
    } catch (e) {
      setError(e.message || 'SMS 발송 실패');
    } finally { setLoading(false); }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (tab === 'register') {
        if (!displayName.trim()) { setError('이름을 입력하세요.'); setLoading(false); return; }
        if (password !== passwordConfirm) { setError('비밀번호 확인이 일치하지 않습니다.'); setLoading(false); return; }
        if (!otpSent) { setError('인증번호를 먼저 받아주세요.'); setLoading(false); return; }
        if (otpExpired) { setError('인증번호가 만료됐습니다. 다시 받아주세요.'); setLoading(false); return; }
        if (!/^\d{4}$/.test(otpCode.trim())) { setError('인증번호 4자리를 입력하세요.'); setLoading(false); return; }
        await api.register({
          email, password, phone,
          display_name: displayName.trim(),
          otp_code: otpCode.trim(),
        });
      }
      const data = await api.login(email, password, rememberMe);
      setTokens(data.access_token, data.refresh_token, rememberMe);
      onLogin();
    } catch (err) {
      setError(err.message || '오류가 발생했습니다');
    } finally {
      setLoading(false);
    }
  }

  void tick;

  return (
    <div style={st.root}>
      <div style={st.bgGlow} />
      <div style={st.card}>
        <div style={st.hero}>
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="시리얼링크"
            style={st.heroLogo} />
          <div style={st.heroTitle}>시리얼링크 위치추적기</div>
          <div style={st.heroSub}>실시간 위치 · 운행 기록 · 알림</div>
        </div>

        <div style={st.tabs}>
          {['login', 'register'].map(t => (
            <button key={t} type="button" onClick={() => switchTab(t)}
              style={{ ...st.tab, ...(tab === t ? st.tabActive : {}) }}>
              {t === 'login' ? '로그인' : '회원가입'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} style={{ marginTop: 18 }}>
          <Field icon={<MailIcon />}>
            <input type="email" placeholder="이메일" value={email} required
              onChange={e => setEmail(e.target.value)} style={st.input} />
          </Field>

          <Field icon={<LockIcon />} style={{ marginTop: 10 }}>
            <input type="password" placeholder="비밀번호 (8자 이상)" value={password} required minLength={8}
              onChange={e => setPassword(e.target.value)} style={st.input} />
          </Field>

          {tab === 'register' && (
            <>
              <Field icon={<LockIcon />} style={{ marginTop: 10 }}>
                <input type="password" placeholder="비밀번호 확인" value={passwordConfirm} required
                  onChange={e => setPasswordConfirm(e.target.value)} style={st.input} />
              </Field>
              {passwordConfirm && password !== passwordConfirm && (
                <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4, paddingLeft: 4 }}>
                  비밀번호 확인이 일치하지 않습니다.
                </div>
              )}
              <Field icon={<UserIcon />} style={{ marginTop: 10 }}>
                <input type="text" placeholder="이름 (예: 홍길동)" value={displayName}
                  required maxLength={20}
                  onChange={e => setDisplayName(e.target.value)} style={st.input} />
              </Field>
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                <Field icon={<PhoneIcon />} style={{ flex: 1 }}>
                  <input type="tel" placeholder="휴대폰 (010...)"
                    value={phone}
                    onChange={e => setPhone(e.target.value.replace(/[^0-9-]/g, ''))}
                    required
                    style={st.input} />
                </Field>
                <button type="button" onClick={handleSendOtp}
                  disabled={loading || !phone.trim() || (otpSent && !otpExpired)}
                  style={{
                    ...st.btnGhost,
                    flexShrink: 0,
                    padding: '0 12px', fontSize: 12,
                    opacity: (loading || !phone.trim() || (otpSent && !otpExpired)) ? 0.5 : 1,
                  }}>
                  {otpSent && !otpExpired ? `${Math.floor(otpSecondsLeft/60)}:${String(otpSecondsLeft%60).padStart(2,'0')}` : (otpSent ? '재발송' : '인증번호')}
                </button>
              </div>
              {otpSent && (
                <>
                  <input type="text" placeholder="인증번호 4자리"
                    value={otpCode}
                    onChange={e => setOtpCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
                    inputMode="numeric" autoComplete="one-time-code" maxLength={4}
                    style={{
                      ...st.input, marginTop: 8,
                      letterSpacing: '0.4em', textAlign: 'center', fontSize: 18, fontWeight: 600,
                      padding: '12px',
                    }} />
                  <div style={{ fontSize: 11, color: otpExpired ? 'var(--danger)' : 'var(--text-3)', marginTop: 4 }}>
                    {otpExpired
                      ? '인증번호가 만료되었습니다 — 재발송하세요.'
                      : `${Math.floor(otpSecondsLeft/60)}:${String(otpSecondsLeft%60).padStart(2,'0')} 안에 입력`}
                    {otpRemain != null && (
                      <span style={{ float: 'right' }}>오늘 남은 발송 {otpRemain}회</span>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          {error && <div style={st.error}>{error}</div>}

          {tab === 'login' && (
            <label style={st.rememberRow}>
              <input type="checkbox" checked={rememberMe}
                onChange={e => setRememberMe(e.target.checked)} />
              <span>로그인 기억하기 (최대 30일)</span>
            </label>
          )}

          <button type="submit" disabled={loading} style={{ ...st.btn, marginTop: 16, opacity: loading ? 0.7 : 1 }}>
            {loading ? '...' : tab === 'login' ? '로그인' : '가입하기'}
          </button>

          {tab === 'login' && (
            <div style={st.helperRow}>
              <button type="button" onClick={() => setFindIdOpen(true)} style={st.helperBtn}>아이디 찾기</button>
              <span style={st.helperDot}>·</span>
              <button type="button" onClick={() => setResetOpen(true)} style={st.helperBtn}>비밀번호 찾기</button>
            </div>
          )}
        </form>

        <div style={st.legal}>
          <a href={`${import.meta.env.BASE_URL}privacy`} target="_blank" rel="noreferrer" style={st.legalLink}>개인정보 처리방침</a>
          <span style={st.helperDot}>·</span>
          <a href={`${import.meta.env.BASE_URL}terms`} target="_blank" rel="noreferrer" style={st.legalLink}>이용약관</a>
        </div>
      </div>

      {findIdOpen && <FindIdModal onClose={() => setFindIdOpen(false)} />}
      {resetOpen && <ResetPasswordModal onClose={() => setResetOpen(false)} onDone={(em) => {
        setResetOpen(false);
        setEmail(em);
      }} />}
    </div>
  );
}

// ───────────────────────────────────────────────────────────
// 아이디 찾기 모달 — 2-step (번호 OTP → 결과)
// ───────────────────────────────────────────────────────────
function FindIdModal({ onClose }) {
  const [step, setStep]       = useState(1);
  const [phone, setPhone]     = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [results, setResults] = useState(null);
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);
  const [otpExpiresAt, setOtpExpiresAt] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!otpExpiresAt) return;
    const iv = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, [otpExpiresAt]);
  const secLeft = otpExpiresAt ? Math.max(0, Math.floor((otpExpiresAt - Date.now()) / 1000)) : 0;
  void tick;

  async function sendOtp(e) {
    e.preventDefault();
    setError('');
    if (!phone.trim()) { setError('휴대폰 번호를 입력하세요.'); return; }
    setLoading(true);
    try {
      const r = await api.findIdSendOtp(phone);
      setOtpExpiresAt(Date.now() + (r.expires_in_sec || 180) * 1000);
      if (r.dev_code) setOtpCode(r.dev_code);
      setStep(2);
    } catch (e) {
      setError(e.message || '발송 실패');
    } finally { setLoading(false); }
  }

  async function verify(e) {
    e.preventDefault();
    setError('');
    if (!/^\d{4}$/.test(otpCode.trim())) { setError('인증번호 4자리를 입력하세요.'); return; }
    setLoading(true);
    try {
      const r = await api.findIdVerify(phone, otpCode.trim());
      setResults(r.accounts || []);
      setStep(3);
    } catch (e) {
      setError(e.message || '인증 실패');
    } finally { setLoading(false); }
  }

  return (
    <ModalOverlay onClose={onClose} title="아이디 찾기">
      {step === 1 && (
        <form onSubmit={sendOtp}>
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 8 }}>
            가입 시 등록한 휴대폰 번호로 인증을 진행합니다.
          </div>
          <Field icon={<PhoneIcon />}>
            <input type="tel" placeholder="휴대폰 (010...)" value={phone}
              onChange={e => setPhone(e.target.value.replace(/[^0-9-]/g, ''))}
              style={st.input} autoFocus />
          </Field>
          {error && <div style={st.error}>{error}</div>}
          <button type="submit" disabled={loading} style={{ ...st.btn, marginTop: 14, opacity: loading ? 0.7 : 1 }}>
            {loading ? '발송 중...' : '인증번호 받기'}
          </button>
        </form>
      )}

      {step === 2 && (
        <form onSubmit={verify}>
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 8 }}>
            {phone} 로 발송된 인증번호 4자리를 입력하세요.
          </div>
          <input type="text" placeholder="인증번호 4자리"
            value={otpCode}
            onChange={e => setOtpCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
            inputMode="numeric" autoComplete="one-time-code" maxLength={4}
            style={{
              ...st.input,
              letterSpacing: '0.4em', textAlign: 'center', fontSize: 18, fontWeight: 600,
              padding: '12px',
            }} autoFocus />
          <div style={{ fontSize: 11, color: secLeft <= 0 ? 'var(--danger)' : 'var(--text-3)', marginTop: 4 }}>
            {secLeft > 0 ? `${Math.floor(secLeft/60)}:${String(secLeft%60).padStart(2,'0')} 안에 입력` : '만료 — 재발송'}
          </div>
          {error && <div style={st.error}>{error}</div>}
          <button type="submit" disabled={loading} style={{ ...st.btn, marginTop: 14, opacity: loading ? 0.7 : 1 }}>
            {loading ? '확인 중...' : '확인'}
          </button>
          <button type="button" onClick={() => setStep(1)} style={{ ...st.btnGhost, width: '100%', marginTop: 8, padding: 10 }}>
            ← 다시 입력
          </button>
        </form>
      )}

      {step === 3 && (
        <div>
          {results && results.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-2)', textAlign: 'center', padding: '20px 0' }}>
              이 번호를 메인으로 사용하는 계정이 없습니다.
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>
                이 번호를 메인으로 사용하는 계정 ({results.length} / 최대 3)
              </div>
              {results.map((a, i) => (
                <div key={i} style={st.resultRow}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{a.email_masked}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                    {new Date(a.created_at).toLocaleDateString()} 가입
                  </div>
                </div>
              ))}
            </>
          )}
          <button type="button" onClick={onClose} style={{ ...st.btn, marginTop: 14 }}>
            닫기
          </button>
        </div>
      )}
    </ModalOverlay>
  );
}

// ───────────────────────────────────────────────────────────
// 비밀번호 재설정 모달
// step1: email + phone → OTP 발송
// step2: OTP + 새 비밀번호 → 재설정
// ───────────────────────────────────────────────────────────
function ResetPasswordModal({ onClose, onDone }) {
  const [step, setStep]       = useState(1);
  const [email, setEmail]     = useState('');
  const [phone, setPhone]     = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [newPw, setNewPw]     = useState('');
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);
  const [otpExpiresAt, setOtpExpiresAt] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!otpExpiresAt) return;
    const iv = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, [otpExpiresAt]);
  const secLeft = otpExpiresAt ? Math.max(0, Math.floor((otpExpiresAt - Date.now()) / 1000)) : 0;
  void tick;

  async function sendOtp(e) {
    e.preventDefault();
    setError('');
    if (!email.trim()) { setError('이메일을 입력하세요.'); return; }
    if (!phone.trim()) { setError('휴대폰 번호를 입력하세요.'); return; }
    setLoading(true);
    try {
      const r = await api.resetSendOtp(email.trim(), phone);
      setOtpExpiresAt(Date.now() + (r.expires_in_sec || 180) * 1000);
      if (r.dev_code) setOtpCode(r.dev_code);
      setStep(2);
    } catch (e) {
      setError(e.message || '발송 실패');
    } finally { setLoading(false); }
  }

  async function verify(e) {
    e.preventDefault();
    setError('');
    if (!/^\d{4}$/.test(otpCode.trim())) { setError('인증번호 4자리를 입력하세요.'); return; }
    if (newPw.length < 8) { setError('비밀번호는 8자 이상이어야 합니다.'); return; }
    setLoading(true);
    try {
      await api.resetVerify(email.trim(), phone, otpCode.trim(), newPw);
      onDone(email.trim());
    } catch (e) {
      setError(e.message || '재설정 실패');
    } finally { setLoading(false); }
  }

  return (
    <ModalOverlay onClose={onClose} title="비밀번호 찾기">
      {step === 1 && (
        <form onSubmit={sendOtp}>
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 8 }}>
            이메일과 등록된 휴대폰 번호 (메인/서브 모두 가능) 를 입력하세요.
          </div>
          <Field icon={<MailIcon />}>
            <input type="email" placeholder="이메일" value={email} required autoFocus
              onChange={e => setEmail(e.target.value)} style={st.input} />
          </Field>
          <Field icon={<PhoneIcon />} style={{ marginTop: 10 }}>
            <input type="tel" placeholder="휴대폰 (010...)" value={phone} required
              onChange={e => setPhone(e.target.value.replace(/[^0-9-]/g, ''))}
              style={st.input} />
          </Field>
          {error && <div style={st.error}>{error}</div>}
          <button type="submit" disabled={loading} style={{ ...st.btn, marginTop: 14, opacity: loading ? 0.7 : 1 }}>
            {loading ? '발송 중...' : '인증번호 받기'}
          </button>
        </form>
      )}

      {step === 2 && (
        <form onSubmit={verify}>
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 8 }}>
            {phone} 로 발송된 인증번호와 새 비밀번호를 입력하세요.
          </div>
          <input type="text" placeholder="인증번호 4자리"
            value={otpCode}
            onChange={e => setOtpCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
            inputMode="numeric" autoComplete="one-time-code" maxLength={4}
            style={{
              ...st.input,
              letterSpacing: '0.4em', textAlign: 'center', fontSize: 18, fontWeight: 600,
              padding: '12px',
            }} />
          <div style={{ fontSize: 11, color: secLeft <= 0 ? 'var(--danger)' : 'var(--text-3)', marginTop: 4 }}>
            {secLeft > 0 ? `${Math.floor(secLeft/60)}:${String(secLeft%60).padStart(2,'0')} 안에 입력` : '만료 — 재발송'}
          </div>
          <Field icon={<LockIcon />} style={{ marginTop: 10 }}>
            <input type="password" placeholder="새 비밀번호 (8자 이상)" value={newPw} minLength={8}
              onChange={e => setNewPw(e.target.value)} style={st.input} />
          </Field>
          {error && <div style={st.error}>{error}</div>}
          <button type="submit" disabled={loading} style={{ ...st.btn, marginTop: 14, opacity: loading ? 0.7 : 1 }}>
            {loading ? '재설정 중...' : '비밀번호 재설정'}
          </button>
          <button type="button" onClick={() => setStep(1)} style={{ ...st.btnGhost, width: '100%', marginTop: 8, padding: 10 }}>
            ← 다시 입력
          </button>
        </form>
      )}
    </ModalOverlay>
  );
}

// ───────────────────────────────────────────────────────────
// 공통 — Modal Overlay, Field wrapper, Icons
// ───────────────────────────────────────────────────────────
// 외부 클릭으로 닫히지 않음 — 중요한 인증/결제 흐름이라 X 버튼/취소 버튼으로만 닫음.
function ModalOverlay({ children, onClose, title }) {
  return (
    <div style={st.overlay}>
      <div style={st.modal}>
        <div style={st.modalHead}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{title}</div>
          <button onClick={onClose} style={st.closeBtn} aria-label="close">×</button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  );
}

function Field({ children, icon, style }) {
  return (
    <div style={{ ...st.field, ...style }}>
      {icon && <div style={st.fieldIcon}>{icon}</div>}
      <div style={{ flex: 1, display: 'flex' }}>{children}</div>
    </div>
  );
}

function MailIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>
    </svg>
  );
}
function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  );
}
function PhoneIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>
    </svg>
  );
}
function UserIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/>
    </svg>
  );
}

const st = {
  root: {
    minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg)', padding: 16, position: 'relative', overflow: 'hidden',
  },
  bgGlow: {
    position: 'absolute', top: '-30%', left: '50%', transform: 'translateX(-50%)',
    width: 800, height: 800, borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(59,130,246,0.18) 0%, rgba(59,130,246,0) 60%)',
    pointerEvents: 'none',
  },
  card: {
    width: '100%', maxWidth: 500,
    background: 'var(--surface)', borderRadius: 16, padding: 32,
    boxShadow: '0 10px 40px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.05)',
    border: '1px solid var(--border)',
    position: 'relative', zIndex: 1,
  },
  hero: {
    textAlign: 'center', marginBottom: 22,
  },
  heroIcon: {
    width: 56, height: 56, borderRadius: 14, margin: '0 auto 10px',
    background: 'linear-gradient(135deg, var(--primary) 0%, #8B5CF6 100%)',
    color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 8px 20px rgba(59,130,246,0.35)',
  },
  heroLogo: {
    width: 80, height: 80, margin: '0 auto 12px',
    display: 'block',
    // 로고 PNG 자체에 둥근 사각 모양이 박혀있으므로 CSS borderRadius 추가하지 않음
    // (이중 마스킹 시 가장자리 흰 슬라이버 발생).
    filter: 'drop-shadow(0 6px 12px rgba(0,0,0,0.15))',
  },
  heroTitle: { fontSize: 22, fontWeight: 700, color: 'var(--text)', letterSpacing: -0.4 },
  heroSub:   { fontSize: 12, color: 'var(--text-3)', marginTop: 4 },

  tabs: {
    display: 'flex', gap: 4, padding: 4,
    background: 'var(--surface-2)', borderRadius: 10,
  },
  tab: {
    flex: 1, padding: '8px 0', background: 'transparent', color: 'var(--text-3)',
    border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
    transition: 'all .2s',
  },
  tabActive: {
    color: 'var(--text)', background: 'var(--surface)',
    boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
  },

  field: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: 'var(--surface-2)', border: '1px solid var(--border)',
    borderRadius: 10, padding: '0 12px',
    transition: 'border-color .15s',
  },
  fieldIcon: { color: 'var(--text-3)', display: 'flex', alignItems: 'center' },
  input: {
    flex: 1, padding: '12px 0', background: 'transparent', border: 'none',
    fontSize: 14, color: 'var(--text)', outline: 'none', width: '100%',
  },

  error: {
    color: 'var(--danger)', fontSize: 13, marginTop: 10,
    background: 'rgba(239,68,68,0.08)', padding: '8px 10px', borderRadius: 6,
  },
  btn: {
    display: 'block', width: '100%', padding: 12,
    background: 'var(--primary)', color: 'var(--primary-fg)',
    border: 'none', borderRadius: 10, fontWeight: 700, cursor: 'pointer', fontSize: 14,
    transition: 'transform .05s',
  },
  btnGhost: {
    background: 'var(--surface-2)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 10,
    fontWeight: 600, cursor: 'pointer',
  },

  rememberRow: {
    display: 'flex', alignItems: 'center', gap: 6,
    marginTop: 12, fontSize: 12, color: 'var(--text-2)',
    cursor: 'pointer', userSelect: 'none',
  },
  helperRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    gap: 8, marginTop: 14,
  },
  helperBtn: {
    background: 'transparent', border: 'none', cursor: 'pointer',
    color: 'var(--text-2)', fontSize: 12, padding: 4,
  },
  helperDot: { color: 'var(--text-3)', fontSize: 12 },

  legal: {
    display: 'flex', justifyContent: 'center', alignItems: 'center',
    gap: 8, marginTop: 22, paddingTop: 16,
    borderTop: '1px solid var(--border)',
    fontSize: 11, color: 'var(--text-3)',
  },
  legalLink: {
    color: 'var(--text-3)', textDecoration: 'none',
  },

  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16, zIndex: 1000,
  },
  modal: {
    width: '100%', maxWidth: 380, background: 'var(--surface)',
    borderRadius: 14, overflow: 'hidden',
    boxShadow: '0 20px 50px rgba(0,0,0,0.25)',
  },
  modalHead: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '16px 20px', borderBottom: '1px solid var(--border)',
  },
  closeBtn: {
    background: 'transparent', border: 'none', cursor: 'pointer',
    fontSize: 24, lineHeight: 1, color: 'var(--text-3)',
    width: 28, height: 28, padding: 0,
  },

  resultRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '10px 12px', background: 'var(--surface-2)',
    borderRadius: 8, marginBottom: 6,
  },
};
