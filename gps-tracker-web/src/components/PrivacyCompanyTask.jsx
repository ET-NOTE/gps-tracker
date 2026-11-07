import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../api';
import {saveBlob} from '../lib/fileDownload';

const states={requested:'처리 보고 요청',submitted:'담당자 검토 중',changes_requested:'보완 요청',accepted:'담당자 확인',revoked:'요청 회수'};
const kinds={access:'정보 열람',rectification:'정보 정정',erasure:'정보 삭제',account_closure:'회원 탈퇴'};
const categories={staff:'직원 명단',trips:'운행 기록',reservations:'예약',expenses:'지출',files:'첨부자료',snapshots:'스냅샷·기타'};
const results={provided:'전달 완료',corrected:'정정 반영',erased:'삭제 반영',limited:'처리 제한'};
const expected=k=>({access:'provided',rectification:'corrected'}[k]||'erased');
const date=x=>new Date(x).toLocaleString('ko-KR');
const local=x=>new Date(new Date(x).getTime()-new Date(x).getTimezoneOffset()*60000).toISOString().slice(0,16);
const open=r=>['received','in_review','needs_information'].includes(r.status);
async function save(t,p,admin){const blob=await api.companyProof(t.id,p.id,admin);await saveBlob(blob,`company-proof-${p.id}.${({'application/pdf':'pdf','image/png':'png','image/jpeg':'jpg'})[p.mime]||'bin'}`);}

export function CompanyTaskInbox(){
 const [after,setAfter]=useState(0),[selected,setSelected]=useState(null);
 const q=useQuery({queryKey:['company-tasks',after],queryFn:()=>api.companyTasks(after),retry:false});
 if(!q.error&&!q.data?.items.length&&!after)return null;
 return <section className="rights-card"><div className="rights-heading"><h2>회사 자료 처리 요청</h2><button onClick={()=>q.refetch()}>새로고침</button></div>
  <p>회사 소유 계정에 지정된 범위입니다. 제출한 보고서와 증빙은 플랫폼 담당자가 검토합니다.</p>
  {q.error&&<p role="alert">{q.error.message}</p>}
  {q.data?.items.map(t=><details key={`${t.id}-${t.revision}`} open={selected===t.id} onToggle={e=>{if(e.currentTarget.open)setSelected(t.id);else if(selected===t.id)setSelected(null);}}><summary>#{t.id} · {categories[t.category]} · {states[t.status]}</summary>
   {selected===t.id&&<OwnerCompanyTask id={t.id} refresh={()=>q.refetch()}/>}
  </details>)}
  {(after>0||q.data?.next)&&<div className="rights-heading"><button disabled={!after} onClick={()=>{setAfter(0);setSelected(null);}}>처음</button><button disabled={!q.data?.next} onClick={()=>{setAfter(q.data.next);setSelected(null);}}>다음</button></div>}
 </section>;
}
function ProofList({task,proofs,admin,onRead}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 async function download(p){setBusy(true);setError('');try{await save(task,p,admin);onRead?.(p);}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <><p>증빙은 파일로 내려받습니다. 필요한 정보만 확인하고 별도 전달·보관 범위를 지켜 주세요.</p>{proofs.map(p=><article className="rights-request" key={p.id}>
  <p>제출 #{p.id} · {date(p.created_at)} · {results[p.outcome]}</p><p>처리 {date(p.executed_at)} · {p.affected_count}건</p><p className="rights-text">{p.summary}</p><p>근거 {p.evidence_reference}</p>
  <div className="rights-package-file"><span>{p.filename} · {Math.ceil(p.size/1024)}KB</span><button disabled={busy} onClick={()=>download(p)}>증빙 내려받기</button></div>
 </article>)}{error&&<p role="alert">{error}</p>}</>;
}
export function OwnerCompanyTask({id,refresh}){
 const q=useQuery({queryKey:['company-task',id],queryFn:()=>api.companyTask(id),retry:false});
 if(q.error)return <p role="alert">{q.error.message} <button onClick={()=>q.refetch()}>다시 확인</button></p>;
 if(!q.data)return <p role="status">불러오는 중…</p>;
 const {task:t,submissions}=q.data;
 return <div><p>{kinds[t.kind]} · 회사 명단 #{t.staff_id} · {categories[t.category]}</p><p>{date(t.from_at)} ~ {date(t.until_at)} (종료 시각 제외)</p><p>제출 기한 {date(t.expires_at)}</p><p className="rights-text">{t.instructions}</p>
  {t.feedback&&<p className="rights-notice rights-text">담당자 안내: {t.feedback}</p>}
  {['requested','changes_requested'].includes(t.status)&&<CompanySubmissionForm key={t.revision} task={t} refresh={async()=>{await q.refetch();await refresh();}}/>}
  {!!submissions.length&&<ProofList task={t} proofs={submissions}/>}
 </div>;
}
export function CompanySubmissionForm({task,refresh}){
 const [form,setForm]=useState({outcome:expected(task.kind),executed_at:local(new Date()),affected_count:0,summary:'',evidence_reference:''});
 const [file,setFile]=useState(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 function field(k,v){setForm(f=>({...f,[k]:v}));setConfirmed(false);}
 async function submit(e){e.preventDefault();if(!confirmed||!file)return;setBusy(true);setError('');try{
  if(file.size>2*1024*1024||!['application/pdf','image/png','image/jpeg'].includes(file.type))throw Error('PDF·PNG·JPG 파일을 2MB 이하로 첨부해 주세요.');
  const file_base64=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=()=>reject(Error('파일을 읽지 못했습니다.'));r.readAsDataURL(file);});
  await api.submitCompanyTask(task.id,{...form,revision:task.revision,executed_at:new Date(form.executed_at).toISOString(),affected_count:Number(form.affected_count),filename:file.name,mime:file.type,file_base64,confirmed});await refresh();
 }catch(e){setError(e.message);}finally{setBusy(false);}}
 return <form onSubmit={submit}><fieldset disabled={busy}>
  <label>처리 결과<select value={form.outcome} onChange={e=>field('outcome',e.target.value)}>{[expected(task.kind),'limited'].map(k=><option key={k} value={k}>{results[k]}</option>)}</select></label>
  <div className="rights-date-row"><label>실제 처리 시각<input required type="datetime-local" value={form.executed_at} onChange={e=>field('executed_at',e.target.value)}/></label><label>처리 건수<input required type="number" min="0" max="10000000" value={form.affected_count} onChange={e=>field('affected_count',e.target.value)}/></label></div>
  <label>처리 방법·결과 또는 제한 사유<textarea required maxLength={2000} rows={3} value={form.summary} onChange={e=>field('summary',e.target.value)}/></label>
  <label>내부 처리 문서·작업 참조번호<input required maxLength={160} value={form.evidence_reference} onChange={e=>field('evidence_reference',e.target.value)}/></label>
  <label>처리 증빙 (PDF·PNG·JPG, 2MB 이하)<input required type="file" accept="application/pdf,image/png,image/jpeg" onChange={e=>{setFile(e.target.files?.[0]||null);setConfirmed(false);}}/></label>
  <p>처리 범위와 결과를 확인할 수 있는 증빙만 첨부하세요. 불필요한 원본 위치, 주민번호, 비밀번호와 타인 정보는 가려 주세요. 제출 이력은 덮어쓰지 않으며, 보관·삭제는 별도 검토합니다.</p>
  <label className="rights-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> 지정 범위의 실제 처리 결과와 첨부 내용이 일치함을 확인했습니다.</label>
  <button type="submit" disabled={!confirmed||!file}>{busy?'제출 중…':'처리 보고서 제출'}</button><p>제출만으로 요청이 완료되지 않습니다. 회사 원본 자료는 이 화면에서 변경하지 않습니다.</p>
 </fieldset>{error&&<p role="alert" className="rights-error">{error}</p>}</form>;
}

export function AdminCompanyTasks({row,request,refresh,children}){
 const q=useQuery({queryKey:['admin-company-tasks',row.id,request.revision],queryFn:()=>api.adminCompanyTasks(row.id),retry:false});
 const [instructions,setInstructions]=useState(''),[expires,setExpires]=useState(local(Date.now()+7*86400000)),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const active=q.data?.items.some(x=>x.task.status!=='revoked');
 const renew=async()=>{await q.refetch();await refresh();};
 async function publish(e){e.preventDefault();setBusy(true);setError('');try{await api.publishCompanyTask(row.id,{request_revision:request.revision,review_revision:row.revision,instructions,expires_at:new Date(expires).toISOString(),confirmed});await renew();}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <section className="rights-impact"><h4>회사 처리 결과·증빙</h4>
  {q.error?<p role="alert">{q.error.message} <button onClick={()=>q.refetch()}>다시 확인</button></p>:!q.data?<p>제출 요청 확인 중…</p>:<>
   {!active&&children}
   {active&&open(request)&&<p>회사 제출 요청이 연결되어 있습니다. 아래에서 증빙을 검토하세요. 대장을 직접 수정하려면 요청을 회수하세요.</p>}
   {!active&&open(request)&&row.identity==='confirmed'&&row.staff_id&&!['verified','excluded','restricted'].includes(row.status)&&<details><summary>회사에 처리 보고 요청</summary><form onSubmit={publish}><fieldset disabled={busy}>
    <p>회사 소유 계정 #{row.company_owner_id}에 명단 #{row.staff_id}, 자료 종류·기간·요청 종류와 아래 안내만 공개합니다. 알림은 별도로 발송하지 않습니다.</p>
    <label>회사 담당자에게 전달할 안내<textarea required maxLength={1000} value={instructions} onChange={e=>{setInstructions(e.target.value);setConfirmed(false);}}/></label>
    <label>제출 기한 (최대 14일)<input required type="datetime-local" value={expires} onChange={e=>{setExpires(e.target.value);setConfirmed(false);}}/></label>
    <label className="rights-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> 본인 범위와 해당 회사에 공개할 내용을 확인했습니다.</label><button type="submit" disabled={!confirmed}>회사 계정에 요청 게시</button>
   </fieldset></form></details>}
   {q.data.items.map(x=><CompanyTaskDecision key={`${x.task.id}-${x.task.revision}`} item={x} row={row} request={request} refresh={renew}/>)}
   {!!q.data.events.length&&<details><summary>제출·증빙 확인 이력 (최근 100건)</summary>{q.data.events.map(e=><p key={e.id}>#{e.task_id} · {date(e.created_at)} · {({published:'게시',submitted:'제출',downloaded:'증빙 응답 생성',accepted:'검토 반영',changes_requested:'보완 요청',revoked:'회수'})[e.action]} · 계정 {e.actor_id}</p>)}</details>}
  </>}{error&&<p role="alert">{error}</p>}
 </section>;
}
export function CompanyTaskDecision({item,row,request,refresh}){
 const {task:t,submissions}=item,latest=submissions[0];
 const [read,setRead]=useState(null),[confirmed,setConfirmed]=useState(false),[feedback,setFeedback]=useState(''),[message,setMessage]=useState(''),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const canReview=open(request)&&t.status==='submitted'&&new Date(t.expires_at)>new Date();
 async function run(accept){setBusy(true);setError('');try{await api.decideCompanyTask(t.id,{request_revision:request.revision,review_revision:row.revision,revision:t.revision,submission_id:latest.id,sha256:read.sha256,accept,confirmed,feedback,public_message:message});await refresh();}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function revoke(e){e.preventDefault();setBusy(true);setError('');try{await api.revokeCompanyTask(t.id,{request_revision:request.revision,revision:t.revision,reason});await refresh();}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <article className="rights-request"><div className="rights-heading"><h4>제출 요청 #{t.id}</h4><span>{states[t.status]}</span></div><p>기한 {date(t.expires_at)}</p><p className="rights-text">{t.instructions}</p>{t.feedback&&<p className="rights-notice rights-text">{t.feedback}</p>}
  {!!submissions.length&&<ProofList task={t} proofs={submissions} admin onRead={p=>{setRead(p);setConfirmed(false);}}/>}
  {canReview&&<fieldset disabled={busy}><label>회사에 전달할 검토 결과<textarea maxLength={1000} value={feedback} onChange={e=>{setFeedback(e.target.value);setConfirmed(false);}}/></label>
   <label>요청자에게 전달할 안내<textarea maxLength={1000} value={message} onChange={e=>{setMessage(e.target.value);setConfirmed(false);}}/></label>
   <p>최신 증빙을 내려받아 실제 전달·정정·삭제 또는 제한 근거를 확인하세요. 다운로드 기록과 파일 해시만으로 처리 사실이 증명되지는 않습니다.</p>
   <label className="rights-confirm"><input type="checkbox" disabled={read?.id!==latest?.id} checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> 최신 증빙의 내용과 실제 처리 결과를 확인했습니다.</label>
   <div className="rights-heading"><button disabled={!confirmed||read?.id!==latest?.id||!feedback.trim()||!message.trim()} onClick={()=>run(false)}>보완 요청</button><button disabled={!confirmed||read?.id!==latest?.id||!feedback.trim()||!message.trim()} onClick={()=>run(true)}>검토 결과 대장에 반영</button></div><p>이 범위의 검토 결과만 반영합니다. 전체 개인정보 요청은 별도로 처리하세요.</p>
  </fieldset>}
  {open(request)&&t.status!=='revoked'&&<details><summary>제출 요청 회수</summary><form onSubmit={revoke}><fieldset disabled={busy}><label>회수 사유<input required maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label><p>회사 접근을 차단하고 해당 검토 항목을 대기 상태로 돌립니다. 기존 증빙·이력은 보존합니다.</p><button type="submit">요청 회수</button></fieldset></form></details>}
  {error&&<p role="alert" className="rights-error">{error}</p>}
 </article>;
}
