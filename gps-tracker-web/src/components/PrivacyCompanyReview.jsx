import {AdminCompanyTasks} from './PrivacyCompanyTask';
import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../api';

export const companyCategories={staff:'직원 명단',trips:'운행 기록',reservations:'차량 예약',expenses:'지출',files:'첨부자료',snapshots:'이름 스냅샷·기타 기록'};
export const companyStatuses={identity_pending:'본인 범위 확인',in_review:'검토 중',awaiting_company:'회사 확인 대기',awaiting_policy:'보관·처리 기준 검토',verified:'담당자 처리 확인',excluded:'본인 자료 범위 제외',restricted:'제한 사유 안내'};
const date=x=>new Date(x).toLocaleString('ko-KR');
const local=x=>{const d=new Date(x);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
export function CompanyReviewSummary({items=[]}) {
  if(!items.length)return null;
  return <section className="rights-impact"><h3>회사 자료 검토</h3><p>항목별 처리 안내입니다. 전체 자료 삭제 완료를 뜻하지 않습니다.</p>
    {items.map(r=><article className="rights-request" key={r.id}><div className="rights-heading"><h4>#{r.id} · {companyCategories[r.category]}</h4><span>{companyStatuses[r.status]}</span></div>
      <p>{date(r.from_at)} ~ {date(r.until_at)} (종료 시각 제외)</p><p className="rights-text">{r.message}</p><p>검토 기한 {date(r.due_at)}</p>
    </article>)}
  </section>;
}
export function PersonalCompanyReviews({request}) {
 const q=useQuery({queryKey:['privacy-company',request.id,request.revision],queryFn:()=>api.privacyCompanyReviews(request.id),retry:false});
 return <>{q.error?<p role="alert">회사 자료 검토를 불러오지 못했습니다. <button onClick={()=>q.refetch()}>다시 시도</button></p>:<CompanyReviewSummary items={q.data}/>}</>;
}
export function AdminCompanyReviews({request,refresh}) {
 const q=useQuery({queryKey:['admin-privacy-company',request.id,request.revision],queryFn:()=>api.adminCompanyReviews(request.id),retry:false});
 const links=useQuery({queryKey:['admin-privacy-company-candidates',request.id,request.revision],queryFn:()=>api.adminCompanyCandidates(request.id),retry:false});
 const [selected,setSelected]=useState(''),[owner,setOwner]=useState(''),[staff,setStaff]=useState(''),[category,setCategory]=useState('staff'),[from,setFrom]=useState(''),[until,setUntil]=useState(''),[due,setDue]=useState(request.due_at?local(request.due_at):'');
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const open=['received','in_review','needs_information'].includes(request.status);
 async function create(e){e.preventDefault();setBusy(true);setError('');try{
   const [cid,sid]=selected==='manual'?[Number(owner),staff?Number(staff):null]:selected.split(':').map(Number);
   const end=new Date(`${until}T00:00:00+09:00`);end.setUTCDate(end.getUTCDate()+1);
   await api.createCompanyReview(request.id,{revision:request.revision,company_owner_id:cid,staff_id:sid,category,from_at:new Date(`${from}T00:00:00+09:00`).toISOString(),until_at:end.toISOString(),due_at:new Date(due).toISOString()});await refresh();
 }catch(e){setError(e.message);}finally{setBusy(false);}}
 return <section className="rights-impact"><h3>회사 자료 검토 대장</h3><p>연결 이력은 본인 확인의 단서입니다. 명단 재배정·동명이인·과거 스냅샷을 검토하세요. 이 화면은 회사 자료를 수정·삭제하거나 전달하지 않습니다.</p>
  {(error||q.error||links.error)&&<p role="alert" className="rights-error">{error||q.error?.message||links.error?.message}</p>}
  {open&&<details><summary>검토 범위 추가</summary><form onSubmit={create}><fieldset disabled={busy}>
    <label>회사·명단 연결 단서<select required value={selected} onChange={e=>setSelected(e.target.value)}><option value="">선택하세요</option>{links.data?.items.map(c=><option key={`${c.owner_id}:${c.staff_id}`} value={`${c.owner_id}:${c.staff_id}`}>{c.company_name||`회사 계정 ${c.owner_id}`} · 명단 {c.staff_id} · {c.currently_linked?'연결 중':'연결 해제 이력'}</option>)}<option value="manual">별도 확인한 회사·명단 지정</option></select></label>
    {links.data?.more&&<p>연결 단서가 50개를 넘습니다. 나머지는 별도 범위 검토가 필요합니다.</p>}
    {selected==='manual'&&<><p>이력이 없는 과거 자료는 이름으로 자동 매칭하지 않습니다. 관리자 자료에서 확인한 회사 계정과 명단 번호를 지정한 뒤 본인 확인 근거를 기록하세요.</p><div className="rights-date-row"><label>회사 계정 번호<input type="number" min="1" required value={owner} onChange={e=>setOwner(e.target.value)}/></label><label>명단 번호 (선택)<input type="number" min="1" value={staff} onChange={e=>setStaff(e.target.value)}/></label></div></>}
    <label>자료 종류<select value={category} onChange={e=>setCategory(e.target.value)}>{Object.entries(companyCategories).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
    <div className="rights-date-row"><label>시작일 (한국시간)<input type="date" required value={from} onChange={e=>setFrom(e.target.value)}/></label><label>종료일 (포함)<input type="date" required value={until} onChange={e=>setUntil(e.target.value)}/></label></div>
    <label>검토 기한<input type="datetime-local" required value={due} onChange={e=>setDue(e.target.value)}/></label><p>항목별 최대 366일입니다. 더 긴 기간은 나누어 등록하세요.</p>
    <button type="submit" disabled={!selected}>본인 범위 확인 항목 추가</button>
  </fieldset></form></details>}
  {q.data?.items.map(r=><details key={`${r.id}-${r.revision}`}><summary>#{r.id} · {companyCategories[r.category]} · {companyStatuses[r.status]}{new Date(r.due_at)<new Date()&&!['verified','excluded','restricted'].includes(r.status)?' · 기한 경과':''}</summary>
    <p>회사 계정 {r.company_owner_id} · 명단 {r.staff_id||'별도 확인'} · {date(r.from_at)} ~ {date(r.until_at)}</p>
    {r.staff_id?<p>등록 시점 후보 건수: 운행 {r.inventory.trips?.count??0}{r.inventory.trips?.more?'+':''} · 예약 {r.inventory.reservations?.count??0}{r.inventory.reservations?.more?'+':''} · 지출 {r.inventory.expenses?.count??0}{r.inventory.expenses?.more?'+':''}. 본인 자료 확정 건수나 전체 자료 목록이 아닙니다.</p>:<p>명단 번호가 없어 후보 건수는 산정하지 않았습니다. 첨부·스냅샷 등은 별도로 확인하세요.</p>}
    <AdminCompanyTasks row={r} request={request} refresh={refresh}>{open?<CompanyReviewEditor row={r} request={request} refresh={refresh}/>:<p>{r.public_message}</p>}</AdminCompanyTasks>
  </details>)}
  {q.data?.items.length===0&&<p>등록된 검토 항목이 없습니다. 회사 자료가 없다는 뜻은 아닙니다.</p>}
  {!!q.data?.events.length&&<details><summary>검토 변경 이력 (최근 100건)</summary>{q.data.events.map(e=><p className="rights-text" key={e.id}>{date(e.created_at)} · #{e.review_id} · {companyStatuses[e.state.status]} · 담당 계정 {e.actor_id}<br/>{e.state.internal_reason||'범위 등록'}{e.state.evidence_reference&&<><br/>근거 {e.state.evidence_reference}</>}</p>)}</details>}
 </section>;
}
export function CompanyReviewEditor({row,request,refresh}){
 const [form,setForm]=useState({status:row.status,identity:row.identity,identity_evidence:row.identity_evidence,evidence_reference:row.evidence_reference,internal_reason:row.internal_reason,public_message:row.public_message,due_at:local(row.due_at)});
 const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const terminal=['verified','excluded','restricted'].includes(form.status);
 function field(name,value){setForm(f=>({...f,[name]:value}));setConfirmed(false);}
 async function submit(e){e.preventDefault();setBusy(true);setError('');try{
   const outcome=form.status==='verified'?({access:'provided',rectification:'corrected'}[request.kind]||'erased'):form.status==='excluded'?'not_subject':form.status==='restricted'?'limited':'';
   await api.updateCompanyReview(row.id,{...form,request_revision:request.revision,revision:row.revision,due_at:new Date(form.due_at).toISOString(),outcome,confirmed});await refresh();
 }catch(e){setError(e.message);}finally{setBusy(false);}}
 return <form onSubmit={submit}><fieldset disabled={busy}>
   <label>본인 범위 판정<select value={form.identity} onChange={e=>field('identity',e.target.value)}><option value="pending">확인 전</option><option value="confirmed">본인 범위 확인</option><option value="not_subject">본인 자료 아님</option></select></label>
   <label>본인 범위 확인 근거 (내부 참조번호)<input maxLength={160} required={form.identity!=='pending'} value={form.identity_evidence} onChange={e=>field('identity_evidence',e.target.value)}/></label>
   <label>검토 상태<select value={form.status} onChange={e=>field('status',e.target.value)}>{Object.entries(companyStatuses).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
   <label>검토 기한<input type="datetime-local" required value={form.due_at} onChange={e=>field('due_at',e.target.value)}/></label>
   <label>검토 사유 (내부용)<textarea required maxLength={1000} value={form.internal_reason} onChange={e=>field('internal_reason',e.target.value)}/></label>
   <label>처리 근거 (내부 참조번호)<input required={terminal} maxLength={160} value={form.evidence_reference} onChange={e=>field('evidence_reference',e.target.value)}/></label>
   <label>요청자에게 전달할 안내<textarea required maxLength={1000} value={form.public_message} onChange={e=>field('public_message',e.target.value)}/></label>
   <p>근거에는 문서 참조번호만 기록하세요. 원본 위치·주민번호·비밀번호·타인 정보를 복사하지 마세요.</p>
   {terminal&&<label className="rights-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> 본인 범위와 실제 전달·반영 결과 또는 제외·제한 근거를 확인했습니다.</label>}
   <button type="submit" disabled={terminal&&!confirmed}>{busy?'저장 중…':'검토 내용 저장'}</button>
 </fieldset>{error&&<p role="alert" className="rights-error">{error}</p>}</form>;
}
