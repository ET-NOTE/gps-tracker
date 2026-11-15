import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../api';

export function useRightsQueue(admin=false) {
  const [state,setState]=useState({filters:{status:admin?'received':'',kind:'',due:'',assignment:''},pages:[null],asOf:null,generation:0,paused:false});
  const params=Object.fromEntries(Object.entries({...state.filters,before:state.pages.at(-1),as_of:state.asOf}).filter(([,v])=>v!=null&&v!==''));
  const query=useQuery({queryKey:[admin?'admin-privacy':'privacy-requests',params,state.generation],
    queryFn:({signal})=>admin?api.adminPrivacyRequests(params,signal):api.privacyRequestPage(params,signal),
    enabled:!state.paused,retry:false,staleTime:0,gcTime:0,refetchOnWindowFocus:false,refetchOnReconnect:false});
  const data=!state.paused&&!query.isFetching&&!query.error?query.data:undefined;
  function change(key,value){setState(s=>({...s,filters:{...s.filters,[key]:value,...(key==='due'&&value?{status:''}:{})},pages:[null],asOf:null,paused:false,generation:s.generation+1}));}
  function reload(){setState(s=>({...s,pages:[null],asOf:null,paused:false,generation:s.generation+1}));}
  function next(){if(data?.next)setState(s=>({...s,pages:[...s.pages,data.next],asOf:s.asOf||data.as_of}));}
  function previous(){setState(s=>({...s,pages:s.pages.length>1?s.pages.slice(0,-1):s.pages}));}
  // Changing the key unobserves the in-flight query; its consumed signal aborts.
  function cancel(){setState(s=>({...s,paused:true,generation:s.generation+1}));}
  return {state,data,error:state.paused?null:query.error,busy:query.isFetching,change,reload,next,previous,cancel};
}

export function RightsQueueTools({queue,admin=false,kinds,statuses}) {
  const {state,data,error,busy,change,reload,next,previous,cancel}=queue;
  return <>
    <div className="rights-queue-filters">
      <label>목록 처리 상태<select value={state.filters.status} onChange={e=>change('status',e.target.value)}><option value="">전체</option>{Object.entries(statuses).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
      <label>목록 요청 종류<select value={state.filters.kind} onChange={e=>change('kind',e.target.value)}><option value="">전체</option>{Object.entries(kinds).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
      {admin&&<>
        <label>처리 기한 필터<select value={state.filters.due} onChange={e=>change('due',e.target.value)}><option value="">전체</option><option value="overdue">진행 중 · 기한 경과</option><option value="undated">진행 중 · 기한 미지정</option></select></label>
        <label>담당자 필터<select value={state.filters.assignment} onChange={e=>change('assignment',e.target.value)}><option value="">전체</option><option value="mine">내 담당</option><option value="unassigned">미배정</option></select></label>
      </>}
    </div>
    <div className="rights-actions"><button type="button" onClick={reload} disabled={busy}>처음 / 새로고침</button><button type="button" onClick={previous} disabled={busy||state.pages.length===1}>이전 페이지</button><button type="button" onClick={next} disabled={busy||!data?.next}>다음 페이지</button>{busy&&<button type="button" onClick={cancel}>목록 조회 취소</button>}</div>
    {busy&&<p role="status">요청 목록을 불러오는 중…</p>}
    {state.paused&&<p role="status">목록 조회를 취소했습니다. 처음 / 새로고침으로 다시 조회할 수 있습니다.</p>}
    {error&&<p role="alert" className="rights-error">{error.message}</p>}
    {data&&<p>{state.pages.length}페이지 · 이번 페이지 {data.items.length}건{data.next?' · 다음 페이지 있음':''}</p>}
    {data?.items.length===0&&<p>선택한 조건에 해당하는 요청이 없습니다.</p>}
    {admin&&data?.as_of&&<p>기한 비교 기준: {new Date(data.as_of).toLocaleString('ko-KR')} · 담당자가 지정한 기한을 사용하며 법정 기한을 자동 결정하지 않습니다.</p>}
    <p>목록은 조회 시점의 상태입니다. 새 요청이나 처리 상태 변경은 처음 / 새로고침으로 확인하세요.</p>
  </>;
}
