import React,{useEffect,useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {api} from '../../api';
import {BusinessButton,BusinessTask} from './BusinessWorkspace';
import {useFleetAccess} from './FleetAccess';
import {businessDate} from '../../lib/business';
import {reportVehicleLabel} from '../../lib/ntsReport';
import {inspectIncompleteTrips} from '../../lib/incompleteTrips';

const AUTO_VEHICLES=20;

export default function FleetIncompleteTrips({devices,onReport,now}){
 const access=useFleetAccess(),qc=useQueryClient();
 const [open,setOpen]=useState(false),[scan,setScan]=useState(null),[state,setState]=useState(null);
 const to=businessDate(now),from=`${to.slice(0,7)}-01`,ids=devices.map(d=>d.id).join(',');
 const scope=JSON.stringify([access.owner_id,access.role,access.staff_id,access.manage_reports,from,to,ids]);
 const limit=scan?.scope===scope?scan.limit:AUTO_VEHICLES,revision=scan?.scope===scope?scan.revision:0;
 const current=state?.scope===scope&&state.revision===revision?state:null;
 const result=current?.rows||{},finished=current?.finished||!devices.length;

 useEffect(()=>{
  let cancelled=false;
  // Extending a large fleet keeps completed results. A retry or scope change
  // starts over; old-company rows never render while the next effect starts.
  const rows=state?.scope===scope&&state.revision===revision?state.rows:{};
  const permissionErrors=new Set(),queryKey=['fleet-incomplete',scope];
  const queue=(ids?ids.split(',').map(id=>({id:Number(id)})):[]).slice(0,limit).filter(d=>!rows[d.id]);
  setState({scope,revision,rows,finished:false});
  inspectIncompleteTrips(queue,d=>qc.fetchQuery({
   queryKey:[...queryKey,d.id],
   queryFn:({signal})=>api.listFleetVehicleTrips(d.id,{from,to},{signal}),
   staleTime:0,gcTime:60_000,retry:false,
  }).catch(error=>{if([401,403].includes(error.status))permissionErrors.add(d.id);throw error;}),
  row=>setState(previous=>previous?.scope===scope&&previous.revision===revision
   ?{...previous,rows:{...previous.rows,[row.id]:{...row,permission:permissionErrors.has(row.id)}}}:previous),
  ()=>cancelled).then(()=>{if(!cancelled)setState(previous=>previous?.scope===scope&&previous.revision===revision?{...previous,finished:true}:previous);});
  return()=>{cancelled=true;qc.cancelQueries({queryKey});};
 },[scope,revision,limit,qc]); // A scan changes only with its scope, retry or explicit next batch.

 const rows=Object.values(result),errors=rows.filter(r=>r.error).length,checked=rows.length-errors;
 const permission=rows.some(r=>r.permission),count=rows.reduce((sum,r)=>sum+(r.missing||0),0);
 const remaining=Math.max(0,devices.length-Math.min(limit,devices.length));
 const partial=errors>0||remaining>0;
 const title=!devices.length?'이번 달 미작성 운행 · 등록 차량 없음'
  :!finished?(count?`확인된 미작성 ${count}건`:'이번 달 미작성 운행 조회 중…')
  :!checked&&errors?'이번 달 미작성 운행 조회 실패'
  :partial?(count?`확인된 미작성 ${count}건`:'이번 달 미작성 운행 집계 미완료')
  :`이번 달 미작성 ${count}건`;
 const description=`${from} ~ ${to} · ${checked}/${devices.length}대 조회${!finished?' 중…':''}${errors?` · ${errors}대 조회 실패`:''}${finished&&remaining?` · ${remaining}대 미조회`:''}${permission?' · 권한·이용권 확인 필요':''}`;
 const label=!devices.length?'—':!finished?'조회 중':partial?(checked?'일부 조회':'조회 실패'):count?'작성 필요':'미작성 없음';
 return <div className="fleet-incomplete" aria-label="이번 달 미작성 운행" aria-busy={!finished}>
  <div role="status" aria-live="polite"><BusinessTask title={title} description={description} label={label} tone={count||errors?'info':''} action={open?'차량별 접기':'차량별 보기'} onClick={devices.length?()=>setOpen(value=>!value):undefined}/></div>
  {open&&<div style={{maxHeight:320,overflowY:'auto'}}>
   {devices.map(d=>result[d.id]&&{device:d,...result[d.id]}).filter(Boolean).sort((a,b)=>Number(b.error)-Number(a.error)||b.missing-a.missing).map(row=><BusinessTask key={row.id} title={reportVehicleLabel(row.device)} description={row.error?(row.permission?'권한·이용권을 확인한 뒤 다시 조회해 주세요.':'조회하지 못했습니다. 다시 확인해 주세요.'):`미작성 ${row.missing} / 전체 ${row.total}건`} label={row.error?'조회 실패':row.missing?'작성 필요':row.total?'입력 완료':'운행 없음'} action="운행기록부" onClick={()=>onReport(row.device,{incomplete:true,from,to})}/>)}
  </div>}
  {finished&&devices.length>0&&(open||errors||remaining>0)&&<div className="business-section-footer">
   {remaining>0&&<BusinessButton onClick={()=>setScan({scope,limit:limit+AUTO_VEHICLES,revision})}>다음 {Math.min(AUTO_VEHICLES,remaining)}대 확인</BusinessButton>}
   <BusinessButton onClick={()=>setScan({scope,limit,revision:revision+1})}>다시 확인</BusinessButton>
  </div>}
 </div>;
}
