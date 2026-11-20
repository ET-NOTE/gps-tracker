import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../api';

const actions={published:'게시',submitted:'제출',downloaded:'증빙 응답 생성',accepted:'검토 반영',changes_requested:'보완 요청',revoked:'회수'};

export function CompanyTaskHistory({reviewId,tasks=[]}){
 const [opened,setOpened]=useState(false);
 return <section><button aria-expanded={opened} onClick={()=>setOpened(v=>!v)}>{opened?'회사 처리 이력 닫기':'회사 처리 이력 보기'}</button>
  {opened&&<HistoryPage key={reviewId} reviewId={reviewId} tasks={tasks}/>}
 </section>;
}
function HistoryPage({reviewId,tasks}){
 const [state,setState]=useState({action:'',task:'',pages:[null],generation:0,paused:false});
 const before=state.pages.at(-1),params={...(before?{before}:{}),...(state.action?{action:state.action}:{}),...(state.task?{task_id:state.task}:{})};
 const q=useQuery({queryKey:['admin-company-task-events',reviewId,params,state.generation],queryFn:({signal})=>api.adminCompanyTaskEvents(reviewId,params,signal),enabled:!state.paused,retry:false,staleTime:0,gcTime:0,refetchOnWindowFocus:false,refetchOnReconnect:false});
 const data=!state.paused&&!q.isFetching&&!q.error?q.data:undefined;
 const reset=changes=>setState(s=>({...s,...changes,pages:[null],paused:false,generation:s.generation+1}));
 return <div className="rights-task-history">
  <p>이 검토 범위의 이력을 최신 순으로50건씩 표시합니다. 증빙 응답 생성은 실제 저장·전달·내용 검토 완료를 뜻하지 않습니다.</p>
  <div className="rights-queue-filters"><label>처리 이력 행위<select value={state.action} onChange={e=>reset({action:e.target.value})}><option value="">전체</option>{Object.entries(actions).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
   <label>처리 이력 요청<select value={state.task} onChange={e=>reset({task:e.target.value})}><option value="">전체</option>{tasks.map(t=><option key={t.id} value={t.id}>요청 #{t.id}</option>)}</select></label></div>
  <div className="rights-actions"><button disabled={q.isFetching} onClick={()=>reset({})}>처리 이력 처음 / 새로고침</button>
   <button disabled={q.isFetching||state.pages.length===1} onClick={()=>setState(s=>({...s,pages:s.pages.slice(0,-1),paused:false,generation:s.generation+1}))}>처리 이력 이전 페이지</button>
   <button disabled={q.isFetching||!data?.next} onClick={()=>setState(s=>({...s,pages:[...s.pages,data.next]}))}>처리 이력 다음 페이지</button>
   {q.isFetching&&<button onClick={()=>setState(s=>({...s,paused:true,generation:s.generation+1}))}>처리 이력 조회 취소</button>}</div>
  {q.isFetching&&<p role="status">회사 처리 이력을 불러오는 중…</p>}
  {state.paused&&<p role="status">처리 이력 조회를 취소했습니다. 새로고침으로 다시 조회하세요.</p>}
  {!state.paused&&q.error&&<p role="alert">{q.error.message}</p>}
  {data&&<p>{state.pages.length}페이지 · 처리 이력 {data.items.length}건{data.next?' · 다음 페이지 있음':''}</p>}
  {data?.items.length===0&&<p>선택한 조건에 해당하는 처리 이력이 없습니다.</p>}
  {data?.items.map(e=><article className="rights-request" key={e.id}><p>이력 #{e.id} · 요청 #{e.task_id} · {actions[e.action]||e.action}</p>
   <p>{new Date(e.created_at).toLocaleString('ko-KR')} · 계정 #{e.actor_id}{e.submission_id?` · 제출 #${e.submission_id}`:''}</p>
   {e.detail&&<p className="rights-text">{e.action==='downloaded'?'증빙 SHA256: ': '기록 내용: '}{e.detail}</p>}
  </article>)}
 </div>;
}
