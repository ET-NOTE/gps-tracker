import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../api';

export function useCompanyMappingQueue() {
  const [state,setState]=useState({status:'',pages:[null],generation:0,paused:false});
  const params={limit:50,...(state.status?{status:state.status}:{}),...(state.pages.at(-1)?{before:state.pages.at(-1)}:{})};
  const query=useQuery({queryKey:['company-subject-mappings',params,state.generation],queryFn:({signal})=>api.companySubjectMappings(params,signal),
    enabled:!state.paused,retry:false,staleTime:0,gcTime:0,refetchInterval:30000,refetchOnWindowFocus:false,refetchOnReconnect:false});
  const data=!state.paused&&!query.isFetching&&!query.error?query.data:undefined;
  function change(status){setState(s=>({...s,status,pages:[null],paused:false,generation:s.generation+1}));}
  function reload(){setState(s=>({...s,pages:[null],paused:false,generation:s.generation+1}));}
  function next(){if(data?.next_before)setState(s=>({...s,pages:[...s.pages,data.next_before]}));}
  function previous(){setState(s=>({...s,pages:s.pages.length>1?s.pages.slice(0,-1):s.pages}));}
  function cancel(){setState(s=>({...s,paused:true,generation:s.generation+1}));}
  return {state,data,error:state.paused?null:query.error,busy:query.isFetching,change,reload,next,previous,cancel};
}

export function CompanyMappingTools({queue,states,disabled=false}) {
  const {state,data,busy,error,change,reload,next,previous,cancel}=queue;
  return <>
    <label>연결 상태 필터<select disabled={disabled} value={state.status} onChange={e=>change(e.target.value)}><option value="">전체</option>{Object.entries(states).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
    <div className="rights-actions"><button type="button" disabled={disabled||busy} onClick={reload}>연결 처음 / 새로고침</button><button type="button" disabled={disabled||busy||state.pages.length===1} onClick={previous}>연결 이전 페이지</button><button type="button" disabled={disabled||busy||!data?.next_before} onClick={next}>연결 다음 페이지</button>{busy&&<button type="button" onClick={cancel}>연결 목록 조회 취소</button>}</div>
    {busy&&<p role="status">연결 목록을 불러오는 중…</p>}
    {state.paused&&<p role="status">연결 목록 조회를 취소했습니다. 새로고침으로 다시 조회하세요.</p>}
    {error&&<p role="alert" className="rights-error">{error.message}</p>}
    {data&&<p>{state.pages.length}페이지 · 연결 {data.items.length}건{data.next_before?' · 다음 페이지 있음':''}</p>}
    {data?.items.length===0&&<p>선택한 상태에 해당하는 연결이 없습니다.</p>}
    <p>목록은 조회 시점의 상태입니다. 새 연결 요청은 처음 / 새로고침으로 확인하세요.</p>
  </>;
}

export function CompanyMappingLocations({row,onClose}) {
  const query=useQuery({queryKey:['company-mapping-locations',row.id,row.revision],queryFn:({signal})=>api.subjectLocations(row.id,signal),
    retry:false,staleTime:0,gcTime:0,refetchOnWindowFocus:false,refetchOnReconnect:false});
  const data=!query.isFetching&&!query.error?query.data:undefined;
  return <section aria-label="확인된 기간 위치"><button type="button" onClick={onClose}>위치 조회 닫기</button>
    {query.isFetching&&<p role="status">확인된 기간 위치를 불러오는 중…</p>}
    {query.error&&<p role="alert" className="rights-error">{query.error.message}</p>}
    {data&&<><p>조회 {data.items.length}건{data.more?' · 처음 500건만 표시':''}</p><div style={{maxHeight:260,overflow:'auto'}}>{data.items.map((p,i)=><p key={i}>{new Date(p.recorded_at).toLocaleString('ko-KR')} · {p.lat??'—'}, {p.lng??'—'}</p>)}</div></>}
  </section>;
}
