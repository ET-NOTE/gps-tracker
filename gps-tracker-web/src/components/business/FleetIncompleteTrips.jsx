import React,{useEffect,useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {api} from '../../api';
import {BusinessSection,BusinessButton,BusinessTask} from './BusinessWorkspace';
import {useFleetAccess} from './FleetAccess';
import {businessDate} from '../../lib/business';
import {reportVehicleLabel} from '../../lib/ntsReport';
import {inspectIncompleteTrips} from '../../lib/incompleteTrips';

export default function FleetIncompleteTrips({devices,onReport,now}){
 const access=useFleetAccess(),qc=useQueryClient();
 const [open,setOpen]=useState(false),[tick,setTick]=useState(0),[result,setResult]=useState({}),[finished,setFinished]=useState(false);
 const to=businessDate(now),from=`${to.slice(0,7)}-01`,ids=devices.map(d=>d.id).join(',');
 useEffect(()=>{if(!open)return;let cancelled=false;setResult({});setFinished(false);
  inspectIncompleteTrips(ids?ids.split(',').map(id=>({id:Number(id)})):[],d=>qc.fetchQuery({queryKey:['fleet-incomplete',access.owner_id,d.id,from,to],queryFn:()=>api.listFleetVehicleTrips(d.id,{from,to}),staleTime:0,retry:false}),r=>setResult(prev=>({...prev,[r.id]:r})),()=>cancelled).then(()=>{if(!cancelled)setFinished(true);});
  return()=>{cancelled=true;};
 },[open,tick,ids,from,to,access.owner_id,qc]);
 const rows=Object.values(result),errors=rows.filter(r=>r.error).length,count=rows.reduce((sum,r)=>sum+(r.missing||0),0);
 return <BusinessSection title="이번 달 미작성 운행" description="운전자 또는 용무를 입력하지 않은 기록" action={<BusinessButton onClick={()=>setOpen(v=>!v)}>{open?'접기':'미작성 확인'}</BusinessButton>}>
  {open&&<div className="fleet-incomplete" aria-busy={!finished}>
   <p className="fleet-team-note" role="status">{from} ~ {to} · {finished?errors?`${devices.length-errors}/${devices.length}대 확인 · 확인된 미작성 ${count}건`:`미작성 ${count}건`:`${rows.length}/${devices.length}대 조회 중…`}</p>
   {devices.map(d=>result[d.id]).filter(Boolean).map(r=>{const d=devices.find(v=>v.id===r.id);return <BusinessTask key={r.id} title={reportVehicleLabel(d)} description={r.error?'조회하지 못했습니다. 다시 확인해 주세요.':`미작성 ${r.missing} / 전체 ${r.total}건`} label={r.error?'조회 실패':r.missing?'작성 필요':'입력 완료'} action="운행기록부" onClick={()=>onReport(d,{incomplete:true,from,to})}/>;})}
   {finished&&<div className="business-section-footer"><BusinessButton onClick={()=>setTick(v=>v+1)}>다시 확인</BusinessButton></div>}
  </div>}
 </BusinessSection>;
}
