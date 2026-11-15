import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../api';

export function useRequestHistory(requestId) {
  const [state,setState]=useState({pages:[null],through:null,generation:0,paused:false});
  const params=Object.fromEntries(Object.entries({before:state.pages.at(-1),through:state.through}).filter(([,v])=>v!=null));
  const query=useQuery({queryKey:['privacy-requests','history',requestId,params,state.generation],
    queryFn:({signal})=>api.privacyRequestHistory(requestId,params,signal),enabled:!state.paused,
    retry:false,staleTime:0,gcTime:0,refetchOnWindowFocus:false,refetchOnReconnect:false});
  const data=!state.paused&&!query.isFetching&&!query.error?query.data:undefined;
  function reload(){setState(s=>({pages:[null],through:null,generation:s.generation+1,paused:false}));}
  function next(){if(data?.next)setState(s=>({...s,pages:[...s.pages,data.next],through:data.through}));}
  function previous(){setState(s=>({...s,pages:s.pages.length>1?s.pages.slice(0,-1):s.pages}));}
  function cancel(){setState(s=>({...s,paused:true,generation:s.generation+1}));}
  return {state,data,busy:query.isFetching,error:state.paused?null:query.error,reload,next,previous,cancel};
}

const date=value=>value?new Date(value).toLocaleString('ko-KR'):'미지정';
export function HistoryContents({requestId,statuses}) {
  const {state,data,busy,error,reload,next,previous,cancel}=useRequestHistory(requestId);
  return <div className="rights-history-body">
    <p>이 요청에 기록된 상태 변경과 안내를 최신순으로 보여드립니다. 새 처리 내용은 처음 / 새로고침으로 확인하세요.</p>
    <div className="rights-actions">
      <button type="button" onClick={reload} disabled={busy}>이력 처음 / 새로고침</button>
      <button type="button" onClick={previous} disabled={busy||state.pages.length===1}>이력 이전</button>
      <button type="button" onClick={next} disabled={busy||!data?.next}>이력 다음</button>
      {busy&&<button type="button" onClick={cancel}>이력 조회 취소</button>}
    </div>
    {busy&&<p role="status">처리 이력을 불러오는 중…</p>}
    {state.paused&&<p role="status">이력 조회를 취소했습니다. 새로고침으로 다시 조회할 수 있습니다.</p>}
    {error&&<p role="alert" className="rights-error">{error.message}</p>}
    {data&&<>
      <p>{state.pages.length}페이지 · 이력 {data.items.length}건</p>
      {data.current_revision>data.through&&<p role="status">새 처리 내용이 있습니다. 처음 / 새로고침으로 확인하세요.</p>}
      {data.items.length===0&&<p>이 범위에 기록된 처리 이력이 없습니다.</p>}
      <ol className="rights-history-list">{data.items.map(event=><li key={event.revision}>
        <strong>{statuses[event.status]||'처리 상태 확인 필요'}</strong> · <time dateTime={event.created_at}>{date(event.created_at)}</time>
        <p className="rights-text">{event.message||'별도 안내문이 없습니다.'}</p>
        <p>당시 처리 기한: {date(event.due_at)}</p>
      </li>)}</ol>
    </>}
  </div>;
}

export default function PersonalRequestHistory({requestId,statuses}) {
  const [expanded,setExpanded]=useState(false);
  return <section className="rights-impact" aria-label={`요청 #${requestId} 처리 이력`}>
    <button type="button" aria-expanded={expanded} aria-controls={`rights-history-${requestId}`} onClick={()=>setExpanded(v=>!v)}>처리 이력 {expanded?'접기':'보기'}</button>
    {expanded&&<div id={`rights-history-${requestId}`}><HistoryContents key={requestId} requestId={requestId} statuses={statuses}/></div>}
  </section>;
}
