import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import './PrivacyRequests.css';
import CollectionControl from './CollectionControl';
import {PersonalDeliveries,AdminDeliveries} from './PrivacyDelivery';

export const rightsKinds = {access:'정보 열람',rectification:'정보 정정',erasure:'정보 삭제',account_closure:'회원 탈퇴'};
export const rightsStatuses = {received:'접수',in_review:'검토 중',needs_information:'추가 확인',fulfilled:'처리 완료',rejected:'처리 제한',cancelled:'요청 취소'};
const isOpen = row => ['received','in_review','needs_information'].includes(row.status);
const date = value => value ? new Date(value).toLocaleString('ko-KR') : '미지정';
const localDate = value => value ? new Date(new Date(value).getTime()-new Date(value).getTimezoneOffset()*60000).toISOString().slice(0,16) : '';
function ErrorMessage({error}) {return error ? <p role="alert" className="rights-error">{error.message || String(error)}</p> : null;}

function Impact({requestId}) {
  const [show,setShow]=useState(false);
  const query=useQuery({queryKey:['privacy-impact',requestId || 'self'],queryFn:()=>requestId?api.adminPrivacyImpact(requestId):api.privacyImpact(),enabled:show,staleTime:0,retry:false});
  return <section className="rights-impact">
    <button type="button" onClick={()=>setShow(!show)} aria-expanded={show}>자료 범위 {show?'접기':'확인'}</button>
    {show&&<>
      <p>현재 연결을 해제한 단말기의 과거 기록도 수신 당시 계정 기준으로 확인합니다. 조회만 하며 자료를 삭제하지 않습니다.</p>
      {query.isPending&&<p role="status">자료 범위를 확인하고 있습니다.</p>}
      <ErrorMessage error={query.error}/>
      {query.data&&<>
        <dl className="rights-counts">{query.data.items.filter(x=>x.count).map(x=><div key={x.key}><dt>{x.label}</dt><dd>{x.count.toLocaleString()}{x.more?' 초과':''}</dd></div>)}</dl>
        {!query.data.items.some(x=>x.count)&&<p>집계 대상 자료가 없습니다. 아래 별도 확인 범위는 남아 있습니다.</p>}
        <p>별도 확인: {query.data.manual_review.join(' · ')}</p>
      </>}
    </>}
  </section>;
}

export default function PrivacyRequests() {
  const qc=useQueryClient();
  const query=useQuery({queryKey:['privacy-requests'],queryFn:api.privacyRequests,retry:false});
  const [kind,setKind]=useState('access'),[scope,setScope]=useState(''),[password,setPassword]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(null),[message,setMessage]=useState('');
  const [key,setKey]=useState(()=>crypto.randomUUID());
  function change(setter,value) {setter(value);setKey(crypto.randomUUID());setMessage('');}
  async function submit(e) {
    e.preventDefault();setBusy(true);setError(null);setMessage('');
    try {
      const row=await api.createPrivacyRequest({request_key:key,kind,scope,password});
      setPassword('');setScope('');setKey(crypto.randomUUID());
      setMessage(`요청 #${row.id}을 접수했습니다. 아래에서 처리 상태를 확인하세요.`);
      await qc.invalidateQueries({queryKey:['privacy-requests']});
    } catch(e) {setError(e);} finally {setBusy(false);}
  }
  async function cancel(row) {
    setBusy(true);setError(null);
    try {await api.cancelPrivacyRequest(row.id,row.revision);await qc.invalidateQueries({queryKey:['privacy-requests']});}
    catch(e) {setError(e);} finally {setBusy(false);}
  }
  return <div className="rights-panel">
    <CollectionControl/>
    <section className="rights-card">
      <h2>개인정보 요청</h2>
      <p>본인 정보의 열람·정정·삭제와 회원 탈퇴를 요청할 수 있습니다.</p>
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          <label>요청 종류<select value={kind} onChange={e=>change(setKind,e.target.value)}>{Object.entries(rightsKinds).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
          <label>대상과 요청 내용<textarea required maxLength={2000} rows={3} value={scope} onChange={e=>change(setScope,e.target.value)} placeholder="해당 장치·기간과 원하는 처리를 적어 주세요."/></label>
          <p>비밀번호·인증키·위치 원본 파일은 요청 내용에 넣지 마세요. 회사에 남은 운전자 정보는 회사명과 대상 기간을 적어 주세요.</p>
          <label>현재 비밀번호<input type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)}/></label>
          <p className="rights-notice">접수만으로 위치 수집이 중지되거나 계정·기록이 삭제되지는 않습니다. 실제 처리 결과를 아래에서 확인하세요.</p>
          <button type="submit" className="rights-primary">{busy?'처리 중…':'요청 접수'}</button>
        </fieldset>
      </form>
      <ErrorMessage error={error}/>{message&&<p role="status">{message}</p>}
      <Impact/>
    </section>
    <section className="rights-card">
      <div className="rights-heading"><h2>요청 내역</h2><button type="button" onClick={()=>query.refetch()} disabled={query.isFetching}>새로고침</button></div>
      <ErrorMessage error={query.error}/>
      {query.isPending&&<p role="status">요청을 불러오고 있습니다.</p>}
      {query.data?.length===0&&<p>접수한 요청이 없습니다.</p>}
      {query.data?.map(row=><article key={row.id} className="rights-request">
        <div className="rights-heading"><h3>#{row.id} · {rightsKinds[row.kind]}</h3><span>{rightsStatuses[row.status]}</span></div>
        <p className="rights-text">{row.scope}</p><p>접수 {date(row.created_at)} · 처리 기한 {date(row.due_at)}</p>
        {row.result_message&&<p className="rights-text rights-notice">{row.result_message}</p>}
        {row.kind==='access'&&<PersonalDeliveries request={row}/>}
        {row.status==='needs_information'&&<p>추가 확인 내용은 관리자 채팅으로 요청 번호와 함께 전달해 주세요.</p>}
        {isOpen(row)&&<button type="button" disabled={busy} onClick={()=>cancel(row)}>이 요청 취소</button>}
      </article>)}
    </section>
  </div>;
}

export function AdminPrivacyRequests() {
  const [filter,setFilter]=useState('received'),[before,setBefore]=useState(null),[selected,setSelected]=useState(null);
  const query=useQuery({queryKey:['admin-privacy',filter,before],queryFn:()=>api.adminPrivacyRequests({status:filter||undefined,before:before||undefined}),retry:false});
  return <div className="rights-panel rights-admin">
    <section className="rights-card"><h2>개인정보 요청</h2><p>담당자가 본인·대리인 여부와 처리 범위, 적용 법정 기한을 확인하세요. 접수와 실행 완료는 별도입니다.</p>
      <label>처리 상태<select value={filter} onChange={e=>{setFilter(e.target.value);setBefore(null);setSelected(null);}}><option value="">전체</option>{Object.entries(rightsStatuses).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
      <ErrorMessage error={query.error}/>{query.isPending&&<p role="status">불러오는 중…</p>}
      {query.data?.items.length===0&&<p>해당 요청이 없습니다.</p>}
      {query.data?.items.map(row=><div className="rights-request" key={row.id}>
        <button type="button" onClick={()=>setSelected(selected===row.id?null:row.id)} aria-expanded={selected===row.id}>#{row.id} · 계정 {row.user_id} · {rightsKinds[row.kind]} · {rightsStatuses[row.status]}</button>
        <p>{date(row.created_at)} · {row.due_at ? `기한 ${date(row.due_at)}` : '기한 지정 필요'}</p>
        {row.due_at&&isOpen(row)&&new Date(row.due_at)<new Date()&&<p className="rights-error">처리 기한 경과</p>}
        {selected===row.id&&<AdminReview key={`${row.id}-${row.revision}`} id={row.id}/>}
      </div>)}
      <div className="rights-heading"><button type="button" onClick={()=>{setBefore(null);query.refetch();}}>처음 / 새로고침</button>{query.data?.next&&<button type="button" onClick={()=>{setBefore(query.data.next);setSelected(null);}}>다음</button>}</div>
    </section>
  </div>;
}
function AdminReview({id}) {
  const qc=useQueryClient();
  const query=useQuery({queryKey:['admin-privacy-detail',id],queryFn:()=>api.adminPrivacyDetail(id),retry:false});
  return <><ErrorMessage error={query.error}/>{query.data&&<ReviewForm key={query.data.request.revision} detail={query.data} refresh={async()=>{await qc.invalidateQueries({queryKey:['admin-privacy']});await qc.invalidateQueries({queryKey:['admin-privacy-detail',id]});}}/>}</>;
}
function ReviewForm({detail,refresh}) {
  const row=detail.request;
  const [status,setStatus]=useState('in_review'),[due,setDue]=useState(localDate(row.due_at)),[message,setMessage]=useState(''),[evidence,setEvidence]=useState(detail.evidence_reference);
  const [busy,setBusy]=useState(false),[error,setError]=useState(null);
  const destructive=['erasure','account_closure'].includes(row.kind);
  const [confirmed,setConfirmed]=useState(false);
  async function closeAccount() {
    setBusy(true);setError(null);
    try {await api.startAccountClosure(row.id,row.revision);await refresh();}
    catch(e) {setError(e);} finally {setBusy(false);}
  }
  async function save(e) {
    e.preventDefault();setBusy(true);setError(null);
    try {await api.reviewPrivacyRequest(row.id,{revision:row.revision,status,message,evidence_reference:evidence,due_at:due?new Date(due).toISOString():null});await refresh();}
    catch(e) {setError(e);} finally {setBusy(false);}
  }
  return <div>
    <p className="rights-text">{row.scope}</p><Impact requestId={row.id}/>
    {row.kind==='access'&&<AdminDeliveries request={row} refresh={refresh}/>}
    {destructive&&<p className="rights-notice">계정 이용 종료와 전체 자료 삭제 완료는 별도입니다. 회사·거래 자료, 계정 정보와 백업은 확인 후 처리해야 합니다.</p>}
    {row.kind==='account_closure'&&!detail.closure&&isOpen(row)&&<section className="rights-impact">
      <h3>계정 이용 종료</h3><p>시작하면 로그인·실시간 조회·공유·추가 수집을 차단합니다. 기존 SIM 연결은 검토가 끝날 때까지 유지하며 자동 재등록하지 않습니다.</p>
      <label className="rights-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> 본인의 탈퇴 요청과 처리 범위를 확인했습니다.</label>
      <button type="button" disabled={busy||!confirmed} onClick={closeAccount}>이용 종료 및 자료 처리 시작</button><ErrorMessage error={error}/>
    </section>}
    {detail.closure&&<section className="rights-impact"><h3>계정 이용 종료 · 자료 검토 중</h3>
      <p>자동 처리 범위: {detail.closure.personal_scope_verified?'처리 확인됨':'처리 대기 또는 추가 확인'}. 전체 삭제 완료로 표시하지 않습니다.</p>
      {detail.closure.state==='retry'&&<p role="alert">일시적인 처리 오류로 재시도 대기 중입니다.</p>}
      <ul>{detail.closure.review_reasons.map(reason=><li key={reason}>{({company_membership_subject_review:'다른 회사에 남은 직원·운전자 정보',company_or_financial_scope_review:'회사 및 거래 자료의 보관·삭제 범위',account_profile_and_audit_review:'계정 정보와 감사 기록',backups_and_external_copies_unverified:'백업·외부 전달본',SIM_reuse_requires_review:'SIM 재사용 및 연결 해제',unattributed_history_review:'수집 당시 계정이 없는 과거 기록',legacy_aggregate_scope_review:'계정 구분이 없는 과거 집계',private_files_pending_or_shared:'첨부파일 삭제 또는 공동 참조 확인'})[reason]||'추가 범위 확인'}</li>)}</ul>
      <p>최근 처리: {date(detail.closure.updated_at)}</p>
    </section>}
    {isOpen(row)&&!detail.closure&&<form onSubmit={save}><fieldset disabled={busy}>
      <label>처리 상태<select value={status} onChange={e=>setStatus(e.target.value)}>{['in_review','needs_information',...(!destructive?['fulfilled']:[]),'rejected'].map(k=><option key={k} value={k}>{rightsStatuses[k]}</option>)}</select></label>
      <label>처리 기한<input type="datetime-local" required={['in_review','needs_information'].includes(status)} value={due} onChange={e=>setDue(e.target.value)}/></label>
      <label>사용자에게 전달할 안내<textarea required maxLength={2000} rows={3} value={message} onChange={e=>setMessage(e.target.value)}/></label>
      <label>처리 근거 참조번호 (내부용)<input maxLength={160} required={['fulfilled','rejected'].includes(status)} value={evidence} onChange={e=>setEvidence(e.target.value)} placeholder="검토·정정·전달 증빙 번호"/></label>
      <p>열람은 본인 확인과 타인 정보 제외 후 안전하게 전달하고, 정정은 실제 반영을 확인한 뒤 완료 처리하세요.</p>
      <button type="submit" className="rights-primary">{busy?'저장 중…':'내가 담당하여 저장'}</button>
    </fieldset><ErrorMessage error={error}/></form>}
    <details><summary>처리 이력 {detail.events.length}건</summary>{detail.events.map(event=><p key={event.revision} className="rights-text">{date(event.created_at)} · {rightsStatuses[event.status]} · 담당 계정 {event.actor_id || '삭제됨'}<br/>{event.message}{event.due_at&&<><br/>기한 {date(event.due_at)}</>}{event.evidence_reference&&<><br/>근거 {event.evidence_reference}</>}</p>)}</details>
  </div>;
}
