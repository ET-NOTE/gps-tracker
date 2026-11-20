import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../api';

const identity={pending:'확인 전',confirmed:'본인 범위 확인',not_subject:'본인 자료 아님'};
const outcome={provided:'제공',corrected:'정정',erased:'파기',not_subject:'본인 자료 아님',limited:'제한'};
const date=v=>v?new Date(v).toLocaleString('ko-KR'):'기록 없음';
export function CompanyReviewHistory({requestId,reviews=[],statuses,categories}){
 const [opened,setOpened]=useState(false);
 return <section><button type="button" aria-expanded={opened} onClick={()=>setOpened(v=>!v)}>{opened?'검토 변경 이력 닫기':'검토 변경 이력 보기'}</button>
  {opened&&<HistoryPage key={requestId} requestId={requestId} reviews={reviews} statuses={statuses} categories={categories}/>}
 </section>;
}
function HistoryPage({requestId,reviews,statuses,categories}){
 const [state,setState]=useState({status:'',review:'',pages:[null],generation:0,paused:false});
 const before=state.pages.at(-1),params={...(before?{before}:{}),...(state.status?{status:state.status}:{}),...(state.review?{review_id:state.review}:{})};
 const q=useQuery({queryKey:['admin-company-review-events',requestId,params,state.generation],queryFn:({signal})=>api.adminCompanyReviewEvents(requestId,params,signal),enabled:!state.paused,retry:false,staleTime:0,gcTime:0,refetchOnWindowFocus:false,refetchOnReconnect:false});
 const data=!state.paused&&!q.isFetching&&!q.error?q.data:undefined;
 const reset=changes=>setState(s=>({...s,...changes,pages:[null],paused:false,generation:s.generation+1}));
 return <div className="rights-task-history">
  <p>당시 저장된 검토 내용을 최신 순으로50건씩 표시합니다. 현재 상태나 원본 자료의 정정·파기·전달 완료를 뜻하지 않습니다. 회사 제출·증빙 이력은 각 검토 항목에서 확인하세요.</p>
  <div className="rights-queue-filters"><label>변경 당시 검토 상태<select value={state.status} onChange={e=>reset({status:e.target.value})}><option value="">전체</option>{Object.entries(statuses).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
   <label>변경 이력 검토 항목<select value={state.review} onChange={e=>reset({review:e.target.value})}><option value="">전체</option>{reviews.map(r=><option key={r.id} value={r.id}>#{r.id} · {categories[r.category]||r.category}</option>)}</select></label></div>
  <div className="rights-actions"><button type="button" disabled={q.isFetching} onClick={()=>reset({})}>변경 이력 처음 / 새로고침</button>
   <button type="button" disabled={q.isFetching||state.pages.length===1} onClick={()=>setState(s=>({...s,pages:s.pages.slice(0,-1),paused:false,generation:s.generation+1}))}>변경 이력 이전 페이지</button>
   <button type="button" disabled={q.isFetching||!data?.next} onClick={()=>setState(s=>({...s,pages:[...s.pages,data.next]}))}>변경 이력 다음 페이지</button>
   {q.isFetching&&<button type="button" onClick={()=>setState(s=>({...s,paused:true,generation:s.generation+1}))}>변경 이력 조회 취소</button>}</div>
  {q.isFetching&&<p role="status">검토 변경 이력을 불러오는 중…</p>}
  {state.paused&&<p role="status">변경 이력 조회를 취소했습니다.</p>}
  {!state.paused&&q.error&&<p role="alert">{q.error.message}</p>}
  {data&&<p>{state.pages.length}페이지 · 변경 이력 {data.items.length}건{data.next?' · 다음 페이지 있음':''}</p>}
  {data?.items.length===0&&<p>선택한 조건에 해당하는 검토 변경 이력이 없습니다.</p>}
  {data?.items.map(e=><article className="rights-request" key={e.id}><h4>이력 #{e.id} · 검토 #{e.review_id} · 버전 {e.revision}</h4>
   <p>{date(e.created_at)} · 담당 계정 #{e.actor_id}</p>
   <p>당시 상태: {statuses[e.state.status]||e.state.status} · 본인 범위: {identity[e.state.identity]||e.state.identity}</p>
   <details><summary>당시 검토 내용 보기</summary>
    <p>{categories[e.state.category]||e.state.category} · {date(e.state.from_at)} ~ {date(e.state.until_at)} (종료 시각 제외)</p>
    <p>당시 검토 기한: {date(e.state.due_at)} · 기록된 처리 결과: {outcome[e.state.outcome]||e.state.outcome||'미기록'}</p>
    <p className="rights-text">내부 검토 사유: {e.state.internal_reason||'미기록'}</p>
    <p className="rights-text">본인 범위 근거: {e.state.identity_evidence||'미기록'}</p>
    <p className="rights-text">처리 근거: {e.state.evidence_reference||'미기록'}</p>
    <p className="rights-text">당시 요청자 안내: {e.state.public_message||'미기록'}</p>
   </details>
  </article>)}
 </div>;
}
