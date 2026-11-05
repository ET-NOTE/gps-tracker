import {useEffect,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Link} from 'react-router-dom';
import {api} from '../api';
import {saveBlob} from '../lib/fileDownload';
import './PrivacyRequests.css';

const date=x=>new Date(x).toLocaleString('ko-KR');
export const deliveryState=row=>row.revoked_at?'회수됨':new Date(row.expires_at)<=new Date()?'만료됨':'다운로드 가능';
const states={received:'접수',in_review:'검토 중',needs_information:'추가 확인',fulfilled:'처리 완료',rejected:'처리 제한',cancelled:'요청 취소'};

export function PersonalDeliveries({request}) {
  const q=useQuery({queryKey:['privacy-deliveries',request.id,request.revision],queryFn:()=>api.privacyDeliveries(request.id),retry:false});
  const [password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  async function download(row) {
    setBusy(true);setError('');setMessage('');
    try {const {blob,filename}=await api.downloadPrivacyDelivery(row.id,password);await saveBlob(blob,filename);setMessage('자료 저장을 요청했습니다. 다운로드 목록을 확인해 주세요.');}
    catch(e){setError(e.message);} finally{setPassword('');setBusy(false);}
  }
  const downloadable=q.data?.some(row=>deliveryState(row)==='다운로드 가능')&&!['cancelled','rejected'].includes(request.status);
  return <section className="rights-delivery">
    {q.error&&<p role="alert">자료 목록을 불러오지 못했습니다. <button onClick={()=>q.refetch()}>다시 시도</button></p>}
    {!!q.data?.length&&<>
      <h4>개인 위치 기록 · CSV</h4><p>수신 당시 본인 계정의 기록만 제공합니다. 회사·소유자 불명 자료와 첨부파일은 별도 검토합니다. 현재 남아 있는 기록을 내려받으며, 저장한 파일은 서버에서 회수할 수 없습니다.</p>
      {downloadable&&<label>다운로드 확인용 현재 비밀번호<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/></label>}
      {q.data.map(row=><div className="rights-request" key={row.id}><p>{date(row.from_at)} ~ {date(row.until_at)} (종료 시각 제외)<br/>장치 {row.device_ids.join(', ')} · {deliveryState(row)} · 만료 {date(row.expires_at)}</p>
        {downloadable&&deliveryState(row)==='다운로드 가능'&&<button disabled={busy||!password} onClick={()=>download(row)}>{busy?'준비 중…':'CSV 내려받기'}</button>}
      </div>)}
    </>}
    {error&&<p role="alert" className="rights-error">{error}</p>}{message&&<p role="status">{message}</p>}
  </section>;
}

export function AdminDeliveries({request,refresh}) {
  const q=useQuery({queryKey:['admin-privacy-deliveries',request.id,request.revision],queryFn:()=>api.adminPrivacyDeliveries(request.id),retry:false});
  const options=useQuery({queryKey:['admin-privacy-delivery-options',request.id],queryFn:()=>api.adminPrivacyDeliveryOptions(request.id),retry:false});
  const [from,setFrom]=useState(''),[until,setUntil]=useState(''),[ids,setIds]=useState([]),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function issue(e){e.preventDefault();setBusy(true);setError('');try {
    const end=new Date(`${until}T00:00:00+09:00`);end.setUTCDate(end.getUTCDate()+1);
    await api.issuePrivacyDelivery(request.id,{revision:request.revision,device_ids:ids,from_at:new Date(`${from}T00:00:00+09:00`).toISOString(),until_at:end.toISOString(),confirmed});
    await refresh();await q.refetch();setConfirmed(false);
  }catch(e){setError(e.message);}finally{setBusy(false);}}
  async function revoke(id){setBusy(true);setError('');try{await api.revokePrivacyDelivery(id);await q.refetch();}catch(e){setError(e.message);}finally{setBusy(false);}}
  return <section className="rights-impact">
    <h3>개인 위치 기록 제공</h3>
    <p>요청 내용과 장치·기간을 검토한 뒤 발급하세요. 회사 연결 이력이 있는 장치는 별도 검토합니다. 발급은 요청 전체의 처리 완료가 아닙니다.</p>
    {['in_review','needs_information'].includes(request.status)&&request.due_at?<form onSubmit={issue}><fieldset disabled={busy}>
      <div className="rights-date-row"><label>시작일 (한국시간)<input type="date" required value={from} onChange={e=>setFrom(e.target.value)}/></label><label>종료일 (포함)<input type="date" required value={until} onChange={e=>setUntil(e.target.value)}/></label></div>
      <div>{options.data?.items.map(d=><label className="rights-confirm" key={d.id}><input type="checkbox" checked={ids.includes(d.id)} onChange={e=>setIds(e.target.checked?[...ids,d.id]:ids.filter(id=>id!==d.id))}/>{d.name||'장치'} · {d.id}</label>)}</div>
      {options.data?.items.length===0&&<p>자동 제공 가능한 개인 위치 기록이 없습니다. 회사 자료 등은 별도로 검토해 주세요.</p>}
      {options.data?.more&&<p>대상 장치가 100개를 넘습니다. 별도 범위 검토가 필요합니다.</p>}
      <p>완료된 날짜 기준 최대 31일·20개 장치·1만 건입니다. 기존 발급은 회수되고 새 발급은 24시간 동안 유효합니다.</p>
      <label className="rights-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> 요청자의 본인 자료와 제공 범위를 확인했습니다.</label>
      <button type="submit" disabled={!confirmed||!ids.length}>검토한 범위로 발급</button>
    </fieldset></form>:<p>요청 검토 상태와 처리 기한을 지정하면 자료를 발급할 수 있습니다.</p>}
    {(error||q.error||options.error)&&<p className="rights-error" role="alert">{error||q.error?.message||options.error?.message}</p>}
    {q.data?.items.map(d=><div className="rights-request" key={d.id}><p>발급 #{d.id} · {deliveryState(d)} · 만료 {date(d.expires_at)}</p>{deliveryState(d)==='다운로드 가능'&&<button disabled={busy} onClick={()=>revoke(d.id)}>다운로드 권한 회수</button>}</div>)}
    {!!q.data?.events.length&&<details><summary>자료 제공 이력</summary>{q.data.events.map(e=><p key={e.id}>{date(e.created_at)} · #{e.delivery_id} · {{issued:'발급',revoked:'회수',download_prepared:'다운로드 응답 생성'}[e.action]}{e.record_count!=null?` · ${e.record_count}건`:''}</p>)}<p>응답 생성 기록은 사용자 기기의 저장 완료를 뜻하지 않습니다.</p></details>}
  </section>;
}

export default function PrivacyResult() {
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[id,setId]=useState(''),[result,setResult]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{const clear=()=>{setPassword('');setResult(null);};window.addEventListener('pagehide',clear);return()=>window.removeEventListener('pagehide',clear);},[]);
  async function submit(e){e.preventDefault();setBusy(true);setError('');setResult(null);try{setResult(await api.privacyResult({email,password,request_id:Number(id)}));}catch(e){setError(e.message);}finally{setPassword('');setBusy(false);}}
  return <main className="rights-panel rights-result-page"><section className="rights-card">
    <h1>개인정보 요청 결과</h1><p>계정 이용 종료 후에도 접수한 요청의 결과를 확인할 수 있습니다. 일반 로그인이나 위치 조회 권한은 복구되지 않습니다.</p>
    <form onSubmit={submit}><fieldset disabled={busy}>
      <label>가입 이메일<input type="email" required autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)}/></label>
      <label>계정 비밀번호<input type="password" required autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/></label>
      <label>요청 번호<input type="number" min="1" required value={id} onChange={e=>setId(e.target.value)}/></label>
      <button type="submit" className="rights-primary">{busy?'확인 중…':'결과 확인'}</button>
    </fieldset></form>{error&&<p role="alert" className="rights-error">{error}</p>}
    {result&&<section className="rights-request" aria-live="polite"><h2>요청 #{result.id} · {states[result.status]}</h2>
      {result.account_restricted&&<p className="rights-notice">계정 이용 종료 · 자료 처리는 아래 결과를 확인해 주세요.</p>}
      <p className="rights-text">{result.scope}</p><p>접수 {date(result.created_at)}{result.due_at?` · 처리 기한 ${date(result.due_at)}`:''}</p>
      <p className="rights-text">{result.result_message||'접수되었습니다. 담당자 검토를 기다려 주세요.'}</p>
      <details><summary>처리 안내 이력</summary>{result.history.map((e,i)=><p className="rights-text" key={i}>{date(e.created_at)} · {states[e.status]}<br/>{e.message}</p>)}</details>
      <button type="button" onClick={()=>setResult(null)}>결과 닫기</button>
    </section>}
    <p><Link to="/login">로그인 화면</Link> · <Link to="/privacy">개인정보 처리방침</Link></p>
    <p>비밀번호나 요청 번호를 잃어버린 경우 고객센터에서 본인 확인이 필요합니다.</p>
  </section></main>;
}
