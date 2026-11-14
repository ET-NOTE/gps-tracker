import {useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {api} from '../api';

export default function ProcessingControl(){
  const qc=useQueryClient();
  const q=useQuery({queryKey:['privacy-processing'],queryFn:api.processingControl,retry:false});
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function toggle(key){
    setBusy(true);setError('');
    try{
      const c=q.data.control;
      await api.setProcessingControl({revision:c.revision,use_paused:c.use_paused,provision_paused:c.provision_paused,[key]:!c[key]});
      // Remove previously fetched locations from the app cache after a change.
      qc.removeQueries({predicate:x=>!['privacy-processing','privacy-requests','collection-control'].includes(x.queryKey[0])});
      await q.refetch();
    }catch(e){setError(e.message);await q.refetch();}finally{setBusy(false);}
  }
  return <section className="rights-card">
    <h2>위치정보 이용·제공</h2>
    <p>수집 설정과 별도로 변경합니다. 이미 전달된 자료는 회수되지 않습니다.</p>
    {(error||q.error)&&<p role="alert" className="rights-error">{error||q.error.message}</p>}
    {q.isPending&&<p role="status">설정을 불러오는 중…</p>}
    {q.data&&<>
      {[['use_paused','이용','내 위치 조회·운행 리포트·자동 분석을 중지합니다.'],['provision_paused','제공','공유 링크·회사 조회·외부 분석 전송을 중지합니다.']].map(([key,label,help])=><div className="rights-request" key={key}>
        <div className="rights-heading"><h3>{label}</h3><span>{q.data.control[key]?'중지됨':'허용'}</span></div>
        <p>{help}</p><button type="button" disabled={busy} onClick={()=>toggle(key)}>{label} {q.data.control[key]?'재개':'중지'}</button>
      </div>)}
      <p>이용 중지 중에도 본인 정보의 열람·삭제 요청은 가능합니다. 회사 공용 자료는 담당자의 범위 확인이 필요합니다.</p>
      <h3>위치 기록 보관</h3>
      <p>{q.data.retention?`동의한 보관기간: ${q.data.retention.months}개월`:'보관기간 동의가 아직 등록되지 않았습니다.'}</p>
      <p>{q.data.retention_enabled?'동의한 기간이 지난 개인 위치 기록은 정리 대상입니다.':'자동 파기는 아직 활성화되지 않았습니다.'} 파일·회사 자료·백업의 처리 상태는 삭제 요청 결과에서 확인하세요.</p>
    </>}
  </section>;
}
