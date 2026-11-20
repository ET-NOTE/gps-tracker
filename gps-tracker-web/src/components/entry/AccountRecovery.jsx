import {useState} from 'react';
import {api} from '../../api';
import Modal from '../ui/Modal';
import {AuthField, PasswordField, OtpField, useOtpChallenge} from './AuthFields';

export default function AccountRecovery({kind,initialEmail,onClose,onReset}){
  const reset=kind==='password', title=reset?'비밀번호 찾기':'아이디 찾기';
  const [email,setEmail]=useState(initialEmail||''),[phone,setPhone]=useState(''),[password,setPassword]=useState('');
  const [accounts,setAccounts]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const otp=useOtpChallenge();
  async function submit(e){
    e.preventDefault();
    if(busy)return;
    setBusy(true);setError('');
    try{
      if(!otp.challenge){
        const result=reset?await api.resetSendOtp(email.trim(),phone):await api.findIdSendOtp(phone);
        otp.receive(result);
      }else{
        if(!otp.left||otp.challenge.expires<=Date.now())throw Error('인증번호가 만료되었습니다. 다시 받아 주세요.');
        if(reset){await api.resetVerify(email.trim(),phone,otp.code,password);onReset(email.trim());}
        else{const result=await api.findIdVerify(phone,otp.code);setAccounts(result.accounts||[]);}
      }
    }catch(err){setError(err.message||'처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');}
    finally{setBusy(false);}
  }
  return <Modal open size="md" mobileForm title={title} closeOnBackdrop={false} onClose={busy?undefined:onClose}>
    {accounts?<div className="entry-recovery">
      <p role="status">{accounts.length?'등록된 계정 '+accounts.length+'개를 찾았습니다.':'이 번호로 등록한 계정이 없습니다.'}</p>
      {accounts.map((a,i)=><div className="entry-result" key={i}><strong>{a.email_masked}</strong><small>{new Date(a.created_at).toLocaleDateString('ko-KR')} 가입</small></div>)}
      <button type="button" className="entry-primary" onClick={onClose}>닫기</button>
    </div>:<form onSubmit={submit} className="entry-fields entry-recovery">
      {otp.challenge?<><p>{phone}로 보낸 인증번호를 입력해 주세요.</p>
        <OtpField otp={otp}/>{reset&&<PasswordField label="새 비밀번호" name="new_password" autoComplete="new-password" required minLength={8} placeholder="8자 이상" value={password} onChange={e=>setPassword(e.target.value)}/>}
      </>:<>
        <p>{reset?'이메일과 계정에 연결된 휴대폰 번호를 입력해 주세요.':'가입할 때 등록한 휴대폰 번호로 본인 확인을 진행합니다.'}</p>
        {reset&&<AuthField label="이메일" name="email" type="email" autoComplete="email" required disabled={busy} value={email} onChange={e=>setEmail(e.target.value)} maxLength={254}/>}
        <AuthField label="휴대폰 번호" name="phone" type="tel" autoComplete="tel-national" required disabled={busy} placeholder="010-0000-0000" value={phone} onChange={e=>setPhone(e.target.value.replace(/[^0-9-]/g,''))}/>
      </>}
      {error&&<p className="entry-error" role="alert">{error}</p>}
      <button className="entry-primary" disabled={busy||!!otp.challenge&&!otp.left}>{busy?'처리 중…':!otp.challenge?'인증번호 받기':reset?'비밀번호 재설정':'아이디 확인'}</button>
      {otp.challenge&&<button type="button" className="entry-secondary" disabled={busy} onClick={()=>{otp.reset();setPassword('');setError('');}}>다시 입력</button>}
    </form>}
  </Modal>;
}
