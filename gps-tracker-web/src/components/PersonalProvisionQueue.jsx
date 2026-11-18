import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../api';

export function usePersonalProvisionQueue(kind) {
 const [state,setState]=useState({filter:'',pages:[null],generation:0,paused:false});
 const mappings=kind==='mappings';
 const params={limit:50,...(state.filter?{[mappings?'status':'read_state']:state.filter}:{}),...(state.pages.at(-1)?{before:state.pages.at(-1)}:{})};
 const query=useQuery({queryKey:[mappings?'subject-mappings':'provision-notices',params,state.generation],
  queryFn:({signal})=>mappings?api.subjectMappingPage(params,signal):api.provisionNoticePage(params,signal),
  enabled:!state.paused,retry:false,staleTime:0,gcTime:0,refetchOnWindowFocus:false,refetchOnReconnect:false});
 // A previous response must not authorize a decision while revalidation is pending or failed.
 const data=!state.paused&&!query.isFetching&&!query.error?query.data:undefined;
 const reset=filter=>setState(s=>({...s,filter,pages:[null],generation:s.generation+1,paused:false}));
 return {state,data,error:state.paused?null:query.error,busy:query.isFetching,refetch:query.refetch,
  change:reset,reload:()=>reset(state.filter),
  next:()=>{if(data?.next_before)setState(s=>({...s,pages:[...s.pages,data.next_before]}));},
  previous:()=>setState(s=>({...s,pages:s.pages.length>1?s.pages.slice(0,-1):s.pages})),
  cancel:()=>setState(s=>({...s,paused:true,generation:s.generation+1}))};
}

export function PersonalProvisionTools({queue,kind,states,disabled=false}) {
 const {state,data,error,busy,change,reload,next,previous,cancel}=queue;
 const title=kind==='mappings'?'연결 요청':'제공 내역';
 const options=kind==='mappings'?states:{unread:'미확인',read:'확인 완료'};
 return <>
  <label>{title} 필터<select disabled={disabled} value={state.filter} onChange={e=>change(e.target.value)}><option value="">전체</option>{Object.entries(options).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
  <div className="rights-actions">
   <button disabled={disabled||busy} onClick={reload}>{title} 처음 / 새로고침</button>
   <button disabled={disabled||busy||state.pages.length===1} onClick={previous}>{title} 이전 페이지</button>
   <button disabled={disabled||busy||!data?.next_before} onClick={next}>{title} 다음 페이지</button>
   {busy&&<button disabled={disabled} onClick={cancel}>{title} 조회 취소</button>}
  </div>
  {busy&&<p role="status">{title}을 불러오는 중…</p>}
  {state.paused&&<p role="status">{title} 조회를 취소했습니다. 새로고침으로 다시 조회하세요.</p>}
  {error&&<p role="alert" className="rights-error">{error.message}</p>}
  {data&&<p>{state.pages.length}페이지 · {title} {data.items.length}건{data.next_before?' · 다음 페이지 있음':''}</p>}
  <p>조회 시점의 내역입니다. 새 요청과 통보는 처음 / 새로고침으로 확인하세요.</p>
 </>;
}
