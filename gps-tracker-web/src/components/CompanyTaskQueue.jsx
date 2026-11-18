import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../api';

export function useCompanyTaskQueue(){
 const [state,setState]=useState({status:'',category:'',pages:[0],generation:0,paused:false});
 const params={after:state.pages.at(-1),...(state.status?{status:state.status}:{}),...(state.category?{category:state.category}:{})};
 const q=useQuery({queryKey:['company-tasks',params,state.generation],queryFn:({signal})=>api.companyTaskPage(params,signal),enabled:!state.paused,retry:false,staleTime:0,gcTime:0,refetchOnWindowFocus:false,refetchOnReconnect:false});
 const data=!state.paused&&!q.isFetching&&!q.error?q.data:undefined;
 const reset=changes=>setState(s=>({...s,...changes,pages:[0],paused:false,generation:s.generation+1}));
 return {state,data,busy:q.isFetching,error:state.paused?null:q.error,refetch:q.refetch,
  change:(name,value)=>reset({[name]:value}),reload:()=>reset({}),
  next:()=>{if(data?.next)setState(s=>({...s,pages:[...s.pages,data.next]}));},
  previous:()=>setState(s=>({...s,pages:s.pages.length>1?s.pages.slice(0,-1):s.pages})),
  cancel:()=>setState(s=>({...s,paused:true,generation:s.generation+1}))};
}
export function CompanyTaskTools({queue,states,categories,disabled=false}){
 const {state,data,busy,error,change,reload,next,previous,cancel}=queue;
 return <>
  <div className="rights-queue-filters"><label>회사 요청 상태<select disabled={disabled} value={state.status} onChange={e=>change('status',e.target.value)}><option value="">전체</option>{Object.entries(states).filter(([k])=>k!=='revoked').map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
  <label>회사 자료 종류<select disabled={disabled} value={state.category} onChange={e=>change('category',e.target.value)}><option value="">전체</option>{Object.entries(categories).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label></div>
  <div className="rights-actions"><button disabled={disabled||busy} onClick={reload}>회사 요청 처음 / 새로고침</button><button disabled={disabled||busy||state.pages.length===1} onClick={previous}>회사 요청 이전 페이지</button><button disabled={disabled||busy||!data?.next} onClick={next}>회사 요청 다음 페이지</button>{busy&&<button disabled={disabled} onClick={cancel}>회사 요청 조회 취소</button>}</div>
  {busy&&<p role="status">회사 처리 요청을 불러오는 중…</p>}{state.paused&&<p role="status">회사 요청 조회를 취소했습니다. 새로고침으로 다시 조회하세요.</p>}
  {error&&<p role="alert">{error.message}</p>}
  {data&&<p>{state.pages.length}페이지 · 회사 요청 {data.items.length}건{data.next?' · 다음 페이지 있음':''}</p>}
  {data?.items.length===0&&<p>선택한 조건에 해당하는 유효한 요청이 없습니다.</p>}
  <p>기한 내 유효한 요청을 게시 순서로 표시합니다. 회수·기한 만료·상위 요청 종료 또는 본인 범위 확인 해제 시 목록에서 제외됩니다.</p>
 </>;
}
