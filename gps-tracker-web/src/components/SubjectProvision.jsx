import {useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {api} from '../api';
import './PrivacyRequests.css';

const when=v=>v?new Date(v).toLocaleString('ko-KR'):'—';
const stateName={pending:'본인 확인 대기',confirmed:'본인 확인됨',rejected:'거절됨',revoked:'철회됨'};
const deliveryName={pending:'푸시 발송 대기',provider_accepted:'푸시 서버 접수',review:'발송 확인 필요'};
const localNow=()=>new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);
function Period({row}){return <p>{when(row.starts_at??row.range_from)} ~ {when(row.ends_at??row.range_until)}</p>;}
function Error({value}){return value?<p role="alert" className="rights-error">{value.message||value}</p>:null;}

export function SubjectMappings(){
 const [before,setBefore]=useState(null),qc=useQueryClient(),q=useQuery({queryKey:['subject-mappings',before],queryFn:()=>api.subjectMappings(before),retry:false});
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 async function decide(row,action){setBusy(true);setError('');try{
  await api.subjectDecision(row.id,{action,revision:row.revision,consent_version:q.data.consent_version});
  qc.removeQueries({predicate:x=>!['subject-mappings','provision-notices'].includes(x.queryKey[0])});await q.refetch();
 }catch(e){setError(e);await q.refetch();}finally{setBusy(false);}}
 if(q.data&&!q.data.enabled&&!q.data.items.length&&!before)return null;
 return <section className="rights-card"><h2>운전자 연결 확인</h2><Error value={error||q.error}/>
 {q.isPending&&<p role="status">불러오는 중…</p>}
 {q.data&&<><p>차량과 기간이 본인의 실제 운행과 일치하는지 확인하세요. 다른 사람의 운행은 거절해 주세요.</p>
 {!q.data.items.length&&<p>확인할 연결 요청이 없습니다.</p>}
 {q.data.items.map(row=><article className="rights-request" key={row.id}>
  <div className="rights-heading"><h3>{row.owner_name||'회사'} #{row.owner_id} · {row.vehicle_name||'차량'} #{row.vehicle_id}</h3><span>{stateName[row.status]}</span></div>
  <p>SIM 연결 #{row.device_id} · 목적: 차량 운영</p><Period row={row}/>
  {row.status==='pending'&&<><p>{q.data.consent_text}</p><div className="rights-actions">
   <button disabled={busy||!q.data.enabled} onClick={()=>decide(row,'confirmed')}>본인 운행 확인 및 동의</button>
   <button disabled={busy||!q.data.enabled} onClick={()=>decide(row,'rejected')}>내 운행이 아닙니다</button></div></>}
  {row.status==='confirmed'&&<button disabled={busy} onClick={()=>decide(row,'revoked')}>이 연결의 제공 동의 철회</button>}
 </article>)}</>}
 <div className="rights-actions">{before&&<button onClick={()=>setBefore(null)}>최근 연결 요청</button>}{q.data?.next_before&&<button onClick={()=>setBefore(q.data.next_before)}>이전 연결 요청</button>}</div>
 </section>;
}

export function ProvisionNotices(){
 const [before,setBefore]=useState(null),q=useQuery({queryKey:['provision-notices',before],queryFn:()=>api.provisionNotices(before),retry:false});
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 async function action(id,kind){setBusy(true);setError('');try{await(kind==='read'?api.readProvisionNotice(id):api.retryProvisionNotice(id));await q.refetch();}catch(e){setError(e);}finally{setBusy(false);}}
 return <section className="rights-card"><div className="rights-heading"><h2>위치정보 제공 내역</h2><button onClick={()=>q.refetch()}>새로고침</button></div>
 <p>앱 내 통보 기록입니다. 푸시 서버 접수는 휴대폰 수신이나 열람 완료를 뜻하지 않습니다.</p><Error value={error||q.error}/>
 {q.isPending&&<p role="status">불러오는 중…</p>}
 {q.data&&!q.data.items.length&&<p>표시할 제공 내역이 없습니다.</p>}
 {q.data?.items.map(row=><article key={row.id} className="rights-request">
  <div className="rights-heading"><h3>{row.owner_name||'회사'} #{row.owner_id}에 제공</h3><span>{row.outcome==='delivery_unknown'||row.outcome==='transport_unknown'?'전달 결과 미확인':'서버 응답 준비됨'}</span></div>
  <p>처리 계정 #{row.actor_id} · 차량 #{row.vehicle_id} · 차량 운영 목적</p><Period row={row}/>
  <p>처리 시각: {when(row.started_at)} · {deliveryName[row.delivery]||row.delivery}</p>
  <p>{row.read_at?`본인 확인: ${when(row.read_at)}`:'아직 확인하지 않은 내역입니다.'}</p>
  <div className="rights-actions">{!row.read_at&&<button disabled={busy} onClick={()=>action(row.id,'read')}>내역 확인 완료</button>}
   {row.delivery==='review'&&<button disabled={busy} onClick={()=>action(row.id,'retry')}>푸시 다시 요청</button>}</div>
 </article>)}
 <div className="rights-actions">{before&&<button onClick={()=>setBefore(null)}>최근 내역</button>}{q.data?.next_before&&<button onClick={()=>setBefore(q.data.next_before)}>이전 내역</button>}</div>
 </section>;
}

export function CompanySubjectMappings(){
 const q=useQuery({queryKey:['company-subject-mappings'],queryFn:api.companySubjectMappings,retry:false});
 const [locations,setLocations]=useState(null);
 async function view(id){setBusy(true);setError('');setLocations(null);try{setLocations(await api.subjectLocations(id));}catch(e){setError(e);}finally{setBusy(false);}}
 const [staff,setStaff]=useState(''),[binding,setBinding]=useState(''),[from,setFrom]=useState(localNow),[until,setUntil]=useState(localNow);
 const [key,setKey]=useState(()=>crypto.randomUUID()),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 function change(setter,value){setter(value);setKey(crypto.randomUUID());setMessage('');}
 async function submit(e){e.preventDefault();setBusy(true);setError('');try{
  await api.proposeSubjectMapping({request_key:key,staff_id:Number(staff),binding_id:Number(binding),starts_at:new Date(from).toISOString(),ends_at:new Date(until).toISOString()});
  setMessage('요청했습니다. 해당 사용자가 내 정보에서 직접 확인해야 연결됩니다.');await q.refetch();setKey(crypto.randomUUID());
 }catch(e){setError(e);}finally{setBusy(false);}}
 return <section className="rights-panel rights-card"><h2>운전자와 위치 기록 연결</h2><p>SIM 소유·예약 배정과 별도입니다. 실제 운전자에게 해당 기간의 확인과 제공 동의를 요청하세요.</p>
 <Error value={error||q.error}/>{message&&<p role="status">{message}</p>}
 {q.data&&!q.data.enabled&&<p>정책 검토 후 활성화됩니다.</p>}
 {q.data?.enabled&&<form onSubmit={submit}><fieldset disabled={busy}>
  <label>운전자 계정<select required value={staff} onChange={e=>change(setStaff,e.target.value)}><option value="">선택</option>{q.data.people.map(p=><option key={p.staff_id} value={p.staff_id}>{p.name} · 계정 #{p.subject_id}</option>)}</select></label>
  <label>차량·SIM 연결<select required value={binding} onChange={e=>change(setBinding,e.target.value)}><option value="">선택</option>{q.data.bindings.map(b=><option key={b.id} value={b.id}>차량 #{b.vehicle_id} · SIM #{b.device_id} · {when(b.starts_at)}</option>)}</select></label>
  <label>시작<input required type="datetime-local" value={from} onChange={e=>change(setFrom,e.target.value)}/></label>
  <label>종료<input required type="datetime-local" value={until} onChange={e=>change(setUntil,e.target.value)}/></label>
  <p>최대 31일, 같은 SIM의 운전자 확인 기간은 겹칠 수 없습니다.</p><button type="submit">본인 확인 요청</button>
 </fieldset></form>}
 {q.data?.items.map(row=><article className="rights-request" key={row.id}><h3>차량 #{row.vehicle_id} · 사용자 #{row.subject_id}</h3><Period row={row}/><span>{stateName[row.status]}</span>{row.status==='confirmed'&&<button disabled={busy} onClick={()=>view(row.id)}>확인된 기간 위치 조회</button>}</article>)}
 {locations&&<div role="region" aria-label="확인된 기간 위치"><p>조회 {locations.items.length}건{locations.more?' · 처음 500건만 표시':''}</p><div style={{maxHeight:260,overflow:'auto'}}>{locations.items.map((p,i)=><p key={i}>{when(p.recorded_at)} · {p.lat??'—'}, {p.lng??'—'}</p>)}</div></div>}
 </section>;
}
