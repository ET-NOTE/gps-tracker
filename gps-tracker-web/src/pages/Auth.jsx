import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, setTokens } from '../api';
import AccountRecovery from '../components/entry/AccountRecovery';
import { AuthField, OtpField, PasswordField, useOtpChallenge } from '../components/entry/AuthFields';
import LoginLayout from '../components/entry/LoginLayout';

const emailKey = 'seriallink.rememberedEmail';
function rememberedEmail() {
  try { return localStorage.getItem(emailKey) || ''; } catch { return ''; }
}
function saveEmail(email) {
  try {
    if (email) localStorage.setItem(emailKey, email);
    else localStorage.removeItem(emailKey);
  } catch { /* Login also works when the browser disallows remembering an email. */ }
}

export default function Auth({ onLogin, loginNext }) {
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState(rememberedEmail);
  const [rememberEmail, setRememberEmail] = useState(Boolean(email));
  const [rememberLogin, setRememberLogin] = useState(true);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [recovery, setRecovery] = useState(null);
  const otp = useOtpChallenge();

  useEffect(() => {
    const previous = document.title;
    const title = (register ? '회원가입' : '로그인') + ' · 시리얼링크';
    document.title = title;
    return () => { if (document.title === title) document.title = previous; };
  }, [register]);

  function switchForm(next) {
    setRegister(next);
    setError(''); setNotice(''); setPassword(''); setConfirm(''); setPhone(''); setName('');
    otp.reset();
  }

  async function sendOtp() {
    if (!phone.trim() || busy) return;
    setBusy(true); setError('');
    try { otp.receive(await api.sendOtp(phone)); }
    catch (err) { setError(err.message || '인증번호를 발송하지 못했습니다.'); }
    finally { setBusy(false); }
  }

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    let created = false;
    const address = email.trim();
    try {
      if (register) {
        if (!name.trim()) throw Error('이름을 입력해 주세요.');
        if (password !== confirm) throw Error('비밀번호 확인이 일치하지 않습니다.');
        if (!otp.challenge) throw Error('휴대폰 인증번호를 먼저 받아 주세요.');
        if (otp.challenge.expires <= Date.now()) throw Error('인증번호가 만료되었습니다. 다시 받아 주세요.');
        if (!/^\d{4}$/.test(otp.code)) throw Error('인증번호 4자리를 입력해 주세요.');
        await api.register({email: address, password, phone, display_name: name.trim(), otp_code: otp.code});
        created = true;
      }
      const tokens = await api.login(address, password, rememberLogin);
      setTokens(tokens.access_token, tokens.refresh_token, rememberLogin);
      if (!register) saveEmail(rememberEmail ? address : '');
      onLogin();
    } catch (err) {
      if (created) {
        switchForm(false);
        setNotice('가입이 완료되었습니다. 새 계정으로 로그인해 주세요.');
      } else setError(err.message || '요청을 처리하지 못했습니다. 다시 시도해 주세요.');
    } finally { setBusy(false); }
  }

  return <LoginLayout register={register}>
    <form className="entry-fields" onSubmit={submit} onChange={() => { if (error) setError(''); }}>
      <AuthField label="이메일" name="email" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus={window.matchMedia('(pointer:fine)').matches} placeholder="이메일을 입력해 주세요" required value={email} disabled={busy} onChange={e => setEmail(e.target.value)}/>
      <PasswordField key={register ? 'new' : 'current'} name="password" autoComplete={register ? 'new-password' : 'current-password'} placeholder={register ? '8자 이상' : '비밀번호를 입력해 주세요'} minLength={8} required value={password} disabled={busy} onChange={e => setPassword(e.target.value)}/>
      {register ? <>
        <PasswordField label="비밀번호 확인" name="password_confirm" autoComplete="new-password" placeholder="비밀번호 다시 입력" required value={confirm} disabled={busy} onChange={e => setConfirm(e.target.value)}/>
        <AuthField label="이름" name="display_name" autoComplete="name" maxLength={20} required value={name} disabled={busy} onChange={e => setName(e.target.value)}/>
        <div className="entry-phone">
          <AuthField label="휴대폰 번호" name="phone" type="tel" autoComplete="tel-national" required value={phone} disabled={busy} placeholder="010-0000-0000" onChange={e => {setPhone(e.target.value.replace(/[^0-9-]/g,'')); otp.reset();}}/>
          <button type="button" className="entry-secondary" disabled={busy || !phone || otp.left > 0} onClick={sendOtp}>{otp.challenge ? (otp.left ? '발송 완료' : '재발송') : '인증번호 받기'}</button>
        </div>
        {otp.challenge && <OtpField otp={otp}/>}
      </> : <div className="entry-options">
        <label><input type="checkbox" aria-label="이메일 기억하기" checked={rememberEmail} onChange={e => {setRememberEmail(e.target.checked); if (!e.target.checked) saveEmail('');}}/><span>이메일 기억<span className="entry-option-long">하기</span></span></label>
        <label title="최대 30일"><input type="checkbox" aria-label="로그인 상태 유지" checked={rememberLogin} onChange={e => setRememberLogin(e.target.checked)}/><span>로그인 <span className="entry-option-long">상태 </span>유지</span></label>
        <button type="button" className="entry-text-button" disabled={busy} onClick={() => setRecovery('password')}>비밀번호 찾기</button>
      </div>}
      {notice && <p className="entry-notice" role="status">{notice}</p>}
      {error && <p className="entry-error" role="alert">{error}</p>}
      <button type="submit" className="entry-primary" disabled={busy}>{busy ? '처리 중…' : register ? '가입하기' : '로그인'}</button>
    </form>
    {!register && <>
      <div className="entry-demo-divider">계정 없이 둘러보기</div>
      <Link className="entry-demo-link" to="/demo" state={{loginNext}}>데모 체험하기</Link>
    </>}
    <div className="entry-links">
      {register ? <button type="button" disabled={busy} onClick={() => switchForm(false)}>로그인으로 돌아가기</button> : <>
        <button type="button" disabled={busy} onClick={() => setRecovery('id')}>아이디 찾기</button>
        <button type="button" disabled={busy} onClick={() => switchForm(true)}>회원가입</button>
      </>}
    </div>
    {recovery && <AccountRecovery key={recovery} kind={recovery} initialEmail={email} onClose={() => setRecovery(null)} onReset={address => {
      setRecovery(null); setPassword(''); setEmail(address); setError(''); setNotice('비밀번호를 변경했습니다. 새 비밀번호로 로그인해 주세요.');
    }}/>}
  </LoginLayout>;
}
