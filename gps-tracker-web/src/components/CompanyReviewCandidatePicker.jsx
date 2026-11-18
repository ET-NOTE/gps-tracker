import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../api';

export function CompanyReviewCandidatePicker({requestId,onChoose,onClose,disabled=false}){
 const [draft,setDraft]=useState('');
 const [state,setState]=useState({q:'',linked:'',pages:[null],generation:0,paused:false});
 const cursor=state.pages.at(-1),params={...(cursor?{after_owner:cursor.owner_id,after_staff:cursor.staff_id}:{}),...(state.q?{q:state.q}:{}),...(state.linked?{linked:state.linked}:{})};
 const query=useQuery({queryKey:['admin-company-candidate-page',requestId,params,state.generation],queryFn:({signal})=>api.adminCompanyCandidatePage(requestId,params,signal),enabled:!state.paused,retry:false,gcTime:0,staleTime:0,refetchOnWindowFocus:false,refetchOnReconnect:false});
 const data=!state.paused&&!query.isFetching&&!query.error?query.data:undefined;
 const reset=changes=>setState(s=>({...s,...changes,pages:[null],paused:false,generation:s.generation+1}));
 const search=()=>reset({q:draft.trim()});
 return <section className="rights-card" aria-label="회사·명단 연결 단서 검색">
  <div className="rights-heading"><h4>회사·명단 연결 단서 찾기</h4><button type="button" disabled={disabled} onClick={onClose}>연결 단서 검색 닫기</button></div>
  <p>현재·과거 연결 이력만 표시합니다. 연결 여부와 관측 시각은 본인 확인이나 자료 제공 권한을 뜻하지 않습니다.</p>
  <label>회사명·회사 계정 번호·명단 번호<input maxLength={80} value={draft} disabled={disabled} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();if(!disabled)search();}}}/></label>
  <button type="button" disabled={disabled} onClick={search}>연결 단서 검색</button>
  <label>연결 단서 상태<select value={state.linked} disabled={disabled} onChange={e=>reset({linked:e.target.value})}><option value="">전체</option><option value="linked">현재 연결</option><option value="unlinked">연결 해제 이력</option></select></label>
  <p>적용된 검색어: {state.q||'전체'} · 번호는 정확히 일치하는 항목을 찾습니다.</p>
  <div className="rights-actions"><button type="button" disabled={disabled||query.isFetching} onClick={()=>reset({})}>연결 단서 처음 / 새로고침</button>
   <button type="button" disabled={disabled||query.isFetching||state.pages.length===1} onClick={()=>setState(s=>({...s,pages:s.pages.slice(0,-1),paused:false,generation:s.generation+1}))}>연결 단서 이전 페이지</button>
   <button type="button" disabled={disabled||query.isFetching||!data?.next} onClick={()=>setState(s=>({...s,pages:[...s.pages,data.next]}))}>연결 단서 다음 페이지</button>
   {query.isFetching&&<button type="button" disabled={disabled} onClick={()=>setState(s=>({...s,paused:true,generation:s.generation+1}))}>연결 단서 조회 취소</button>}</div>
  {query.isFetching&&<p role="status">회사 연결 단서를 불러오는 중…</p>}
  {state.paused&&<p role="status">연결 단서 조회를 취소했습니다.</p>}
  {!state.paused&&query.error&&<p role="alert">{query.error.message}</p>}
  {data&&<p>{state.pages.length}페이지 · 연결 단서 {data.items.length}건{data.next?' · 다음 페이지 있음':''}</p>}
  {data?.items.length===0&&<p>검색 조건에 맞는 연결 단서가 없습니다. 회사 자료가 없다는 뜻은 아닙니다.</p>}
  {data?.items.map(c=><article className="rights-request" key={`${c.owner_id}:${c.staff_id}`}><h4>{c.company_name||'회사명 미등록'}</h4>
   <p>회사 계정 #{c.owner_id} · 명단 #{c.staff_id} · {c.currently_linked?'현재 연결':'연결 해제 이력'}</p>
   <p>처음 관측 {new Date(c.first_observed).toLocaleString('ko-KR')}<br/>마지막 관측 {new Date(c.last_observed).toLocaleString('ko-KR')}</p>
   <button type="button" disabled={disabled} onClick={()=>onChoose(c)}>회사 #{c.owner_id} · 명단 #{c.staff_id} 선택</button>
  </article>)}
 </section>;
}
