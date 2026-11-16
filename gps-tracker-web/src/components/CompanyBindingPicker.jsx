import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../api';

const when=value=>value?new Date(value).toLocaleString('ko-KR'):'계속 연결 중';
export function CompanyBindingPicker({onChoose,onClose}) {
  const [draft,setDraft]=useState('');
  const [state,setState]=useState({q:'',pages:[null],generation:0,paused:false});
  const params={limit:50,...(state.q?{q:state.q}:{}),...(state.pages.at(-1)?{before:state.pages.at(-1)}:{})};
  const query=useQuery({queryKey:['company-subject-bindings',params,state.generation],queryFn:({signal})=>api.companySubjectBindings(params,signal),enabled:!state.paused,
    retry:false,gcTime:0,staleTime:0,refetchOnWindowFocus:false,refetchOnReconnect:false});
  const data=!state.paused&&!query.isFetching&&!query.error?query.data:undefined;
  function search(e){e.preventDefault();setState(s=>({...s,q:draft.trim(),pages:[null],paused:false,generation:s.generation+1}));}
  function reload(){setState(s=>({...s,paused:false,generation:s.generation+1}));}
  return <section className="rights-card" aria-label="과거 차량·SIM 연결 검색">
    <div className="rights-heading"><h3>과거 차량·SIM 연결 찾기</h3><button type="button" onClick={onClose}>연결 검색 닫기</button></div>
    <p>종료된 연결도 찾을 수 있습니다. 차량·SIM 연결 이력은 운전자 본인 확인이나 제공 동의를 대신하지 않습니다.</p>
    <form onSubmit={search}><label>차량명·단말기명·SIM 번호<input maxLength={80} value={draft} onChange={e=>setDraft(e.target.value)}/></label><button type="submit">연결 검색</button></form>
    <p>적용된 검색어: {state.q||'전체'}</p>
    <div className="rights-actions"><button type="button" disabled={query.isFetching} onClick={reload}>연결 다시 조회</button>
      <button type="button" disabled={query.isFetching||state.pages.length===1} onClick={()=>setState(s=>({...s,pages:s.pages.slice(0,-1),paused:false}))}>검색 이전 페이지</button>
      <button type="button" disabled={!data?.next_before} onClick={()=>setState(s=>({...s,pages:[...s.pages,data.next_before]}))}>검색 다음 페이지</button>
      {query.isFetching&&<button type="button" onClick={()=>setState(s=>({...s,paused:true,generation:s.generation+1}))}>연결 검색 취소</button>}
    </div>
    {query.isFetching&&<p role="status">차량·SIM 연결을 검색하는 중…</p>}
    {state.paused&&<p role="status">연결 검색을 취소했습니다.</p>}
    {!state.paused&&query.error&&<p role="alert" className="rights-error">{query.error.message}</p>}
    {data&&<><p>{state.pages.length}페이지 · 검색 결과 {data.items.length}건</p>{!data.enabled&&<p>새 연결 요청은 정책 검토 후 활성화됩니다.</p>}
      {!data.items.length&&<p>검색 조건에 맞는 차량·SIM 연결이 없습니다.</p>}
      {data.items.map(row=><article className="rights-request" key={row.id}><h4>{row.vehicle_name||'차량'} · 차량 #{row.vehicle_id}</h4><p>{row.terminal_name||'단말기'} · SIM #{row.device_id} · 연결 #{row.id}</p><p>{when(row.starts_at)} ~ {when(row.ends_at)}</p><button type="button" disabled={!data.enabled} onClick={()=>onChoose(row)}>연결 #{row.id} 선택</button></article>)}
    </>}
  </section>;
}
