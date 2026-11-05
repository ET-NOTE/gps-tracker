import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export default function CollectionControl() {
  const query=useQuery({queryKey:['collection-control'],queryFn:api.collectionControl,refetchInterval:15000,retry:false});
  const [selected,setSelected]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function apply() {
    setBusy(true);setError('');
    try {await api.setCollectionControl(selected.device_id,{paused:!selected.paused,epoch:selected.epoch});setSelected(null);await query.refetch();}
    catch(e) {setError(e.message);await query.refetch();} finally {setBusy(false);}
  }
  return <section className="rights-card collection-control">
    <div className="rights-heading"><h2>위치 수집</h2><button type="button" onClick={()=>query.refetch()}>새로고침</button></div>
    <p>중지하면 서버의 새 위치 저장을 즉시 차단합니다. 단말기에는 다음 통신 때 적용됩니다. 기존 기록은 유지됩니다.</p>
    <p>재개는 지원 펌웨어의 적용 확인 후 시작합니다. 중지 기간의 위치는 나중에도 저장하지 않습니다.</p>
    {(query.error||error)&&<p role="alert" className="rights-error">{error||query.error.message}</p>}
    {query.isPending&&<p role="status">장치를 불러오는 중…</p>}
    {query.data?.items.length===0&&<p>연결된 GPS 단말기가 없습니다.</p>}
    {query.data?.items.map(row=><div className="rights-request" key={row.device_id}>
      <div className="rights-heading"><strong>{row.name}</strong><span>{row.restricted?'수집 차단':row.paused?'새 위치 저장 중지':row.enforced&&!row.device_applied?'재개 적용 대기':'수집 허용'}</span></div>
      <p>{row.restricted?'삭제 처리 중인 장치는 여기서 재개할 수 없습니다.':row.device_applied?`단말기 적용 확인 · ${new Date(row.ack_at).toLocaleString('ko-KR')}`:'단말기 적용 미확인 · 절전·오프라인 상태에서는 다음 통신을 기다립니다. 지원하지 않는 펌웨어는 업데이트가 필요합니다.'}</p>
      {!row.restricted&&<button type="button" disabled={busy} onClick={()=>{setSelected(row);setError('');}}>{row.paused?'수집 재개':'수집 중지'}</button>}
      {selected?.device_id===row.device_id&&<div className="rights-impact" role="group" aria-label="위치 수집 변경 확인">
        <p>{selected.paused?'단말기 적용 후 새 위치 수집을 다시 시작할까요?':'이 SIM의 위치 수집을 중지할까요? SIM을 다른 단말기로 옮겨도 중지 설정은 유지됩니다.'}</p>
        <div className="rights-heading"><button type="button" disabled={busy} onClick={()=>setSelected(null)}>취소</button><button type="button" disabled={busy} onClick={apply}>{busy?'적용 중…':'확인'}</button></div>
      </div>}
    </div>)}
  </section>;
}
