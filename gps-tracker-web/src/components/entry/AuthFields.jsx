import { useEffect, useId, useState } from 'react';
import Icon from '../Icon';

export function AuthField({ label, children, ...input }) {
  const id=useId();
  return <div className="entry-field">
    <label htmlFor={id}>{label}</label>
    <input id={id} className="entry-input" {...input}/>
    {children}
  </div>;
}

export function PasswordField({label='비밀번호', ...input}) {
  const [shown,setShown]=useState(false), id=useId();
  return <div className="entry-field">
    <label htmlFor={id}>{label}</label>
    <div className="entry-password">
      <input id={id} className="entry-input" type={shown?'text':'password'} {...input}/>
      <button type="button" className="entry-reveal" aria-label={label+(shown?' 숨기기':' 표시')} aria-pressed={shown} onClick={()=>setShown(v=>!v)}><Icon name="eye" size={19}/></button>
    </div>
  </div>;
}

export function useOtpChallenge() {
  const [challenge,setChallenge]=useState(null), [code,setCode]=useState(''), [now,setNow]=useState(Date.now);
  const left=challenge?Math.max(0,Math.ceil((challenge.expires-now)/1000)):0;
  useEffect(()=>{
    if(!challenge||!left)return;
    const timer=setTimeout(()=>setNow(Date.now()),Math.max(100,Math.min(1000,challenge.expires-Date.now())));
    return ()=>clearTimeout(timer);
  },[challenge,left,now]);
  function receive(response){
    const issued=Date.now();
    setNow(issued);setChallenge({expires:issued+(response.expires_in_sec||180)*1000,remaining:response.remaining_today});
    setCode(response.dev_code||'');
  }
  function reset(){setChallenge(null);setCode('');}
  return {challenge,code,change:value=>setCode(value.replace(/\D/g,'').slice(0,4)),left,receive,reset};
}

export function OtpField({otp}) {
  const remaining=otp.challenge?.remaining;
  return <AuthField label="인증번호" name="otp_code" type="text" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{4}" maxLength={4} placeholder="인증번호 4자리" value={otp.code} onChange={e=>otp.change(e.target.value)}>
    <small className="entry-note">{otp.left?'유효 시간 '+Math.floor(otp.left/60)+':'+String(otp.left%60).padStart(2,'0'):'인증번호가 만료되었습니다. 다시 받아 주세요.'}
      {remaining!=null&&' · 오늘 남은 발송 '+remaining+'회'}</small>
  </AuthField>;
}
