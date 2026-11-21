import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { businessDate, vehicleName } from '../../lib/business';
import { addBusinessDays, boardDays, rentalOnDay } from '../../lib/businessWorkspace';
import { kstDateTime, rentalReport } from '../../lib/businessExport';
import { fleetWorkOnDay, isIncident, repairNames, workStageName, workState } from '../../lib/rentalFleet';
import { isAssigned, matchesVehicle } from '../../lib/rentalInventory';
import { useRentalOperations } from './useBusinessData';
import { fleetWorkKey } from './RentalFleetWork';
import { policyKey } from './RentalPolicy';
import { BusinessButton, BusinessError } from './BusinessWorkspace';
import ExportButtons from './ExportButtons';
import { StageBadge } from './RentalStageTable';

const weekdays = ['월','화','수','목','금','토','일'];
const mondayOf = date => addBusinessDays(date,-((new Date(date+'T12:00:00Z').getUTCDay()+6)%7));

function workTimeRange(work) {
  const start = kstDateTime(work.starts_at);
  const finish = kstDateTime(isIncident(work.kind) ? work.inspection_released_at : work.closed_at || work.ends_at);
  if (!finish) return start.slice(-5);
  if (finish.slice(0, 10) === start.slice(0, 10)) return start.slice(-5) + '–' + finish.slice(-5);
  return start.slice(5) + ' – ' + finish.slice(5);
}

export default function RentalDispatchWeek({vehicles,inventoryReady,inventoryError,branches,now,tabs,onNew,onContract,onWork}) {
  const today=businessDate(now);
  const [week,setWeek]=useState(()=>mondayOf(today));
  const [branch,setBranch]=useState(''), [vehicleClass,setVehicleClass]=useState('');
  const [assignment,setAssignment]=useState(''), [query,setQuery]=useState('');
  const days=boardDays(week);
  const rentals=useRentalOperations(now,{from:week+'T00:00:00+09:00',to:addBusinessDays(week,7)+'T00:00:00+09:00'});
  const service=useQuery({queryKey:fleetWorkKey(),queryFn:api.rentalFleetWork,staleTime:15_000});
  const policy=useQuery({queryKey:policyKey(),queryFn:api.rentalOperatingPolicy,staleTime:60_000});
  const contracts=(rentals.data||[]).filter(c=>c.status!=='cancelled');
  const classOf=v=>v?.class_name||v?.car_model||'';
  const branchNames=[...new Set([...branches.map(b=>typeof b==='string'?b:b.name),...vehicles.map(v=>v.branch),...contracts.map(c=>c.pickup_location)].filter(Boolean))].sort();
  const classNames=[...new Set([...vehicles.map(classOf),...contracts.map(c=>c.rental_terms?.requested_model)].filter(Boolean))].sort();
  const term=query.trim().toLocaleLowerCase();
  const matchesText=values=>!term||values.some(v=>String(v||'').toLocaleLowerCase().includes(term));
  const byVehicle=vehicles.filter(v=>(!branch||v.branch===branch)&&(!vehicleClass||classOf(v)===vehicleClass));
  const rows=contracts.map(c=>({c,v:vehicles.find(v=>matchesVehicle(c,v))})).filter(({c,v})=>
    (!branch||(c.pickup_location||v?.branch)===branch) &&
    (!vehicleClass||classOf(v)===vehicleClass||c.rental_terms?.requested_model===vehicleClass) &&
    (!assignment||isAssigned(c)===(assignment==='assigned')) &&
    matchesText(['R-'+c.id,c.renter_name,c.rental_terms?.requested_model,v&&vehicleName(v)]) &&
    days.some(d=>rentalOnDay(c,d,now))
  ).sort((a,b)=>Date.parse(a.c.starts_at)-Date.parse(b.c.starts_at));
  const work=(assignment?[]:(service.data||[])).map(w=>({w,v:byVehicle.find(v=>matchesVehicle(w,v))}))
    .filter(({w,v})=>v&&w.starts_at&&matchesText([vehicleName(v),repairNames[w.kind]]));
  const assigned=rows.filter(({c})=>isAssigned(c)).length;
  const loaded=rentals.isSuccess && (inventoryReady||!branch&&!vehicleClass&&!term);
  const daysLoaded=loaded && (assignment||service.isSuccess&&inventoryReady);
  const error=rentals.isError||service.isError||inventoryError;
  const metrics=[['조회 대여 일정',loaded?rows.length:null,'건'],['배차 대기',loaded?rows.length-assigned:null,'건'],
    ['배차 완료',loaded?assigned:null,'건'],['준비 시간',policy.data?.buffer_minutes,'분']];
  const report=rentalReport(rows.map(({c})=>c),{now,filterText:week+' ~ '+days[6]+' 배차 일정'});
  return <div className="rental-workflow rental-dispatch-week">
    <div className="rental-stage-metrics">{metrics.map(([name,value,unit])=><div key={name}><span>{name}</span>
      <strong>{value==null?'—':<>{value.toLocaleString('ko-KR')}<small>{unit}</small></>}</strong></div>)}</div>
    <div className="rental-workflow-toolbar">{tabs}<div><ExportButtons report={report} csvOnly disabled={!loaded}/>
      <BusinessButton primary icon="plus" onClick={onNew}>예약 등록</BusinessButton></div></div>
    <div className="rental-workflow-filters">
      <label>인수 지점<select aria-label="인수 지점" value={branch} onChange={e=>setBranch(e.target.value)}><option value="">전체 지점</option>{branchNames.map(n=><option key={n}>{n}</option>)}</select></label>
      <label>차종<select aria-label="차종" value={vehicleClass} onChange={e=>setVehicleClass(e.target.value)}><option value="">전체 차종</option>{classNames.map(n=><option key={n}>{n}</option>)}</select></label>
      <label>배차 상태<select aria-label="배차 상태" value={assignment} onChange={e=>setAssignment(e.target.value)}><option value="">전체</option><option value="waiting">배차 대기</option><option value="assigned">배차 완료</option></select></label>
      <label className="rental-stage-search">검색<input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="고객, 차량, 예약번호"/></label>
      <BusinessButton icon="refresh" onClick={()=>{setBranch('');setVehicleClass('');setAssignment('');setQuery('');}}>조건 초기화</BusinessButton>
    </div>
    {rentals.isError&&<BusinessError onRetry={rentals.refetch}>대여 일정을 불러오지 못했습니다.</BusinessError>}
    {service.isError&&<BusinessError onRetry={service.refetch}>차량 준비 일정을 불러오지 못했습니다.</BusinessError>}
    {policy.isError&&<BusinessError onRetry={policy.refetch}>준비 시간을 불러오지 못했습니다.</BusinessError>}
    <section className="rental-week-panel" aria-label="주간 배차 일정"><header><div>
      <BusinessButton onClick={()=>setWeek(addBusinessDays(week,-7))}>이전 주</BusinessButton><span aria-live="polite" aria-atomic="true">{week.replaceAll('-','.')} – {days[6].replaceAll('-','.')}</span>
      <BusinessButton onClick={()=>setWeek(addBusinessDays(week,7))}>다음 주</BusinessButton></div>
      <BusinessButton onClick={()=>setWeek(mondayOf(today))}>이번 주</BusinessButton></header>
      <div className="rental-week-grid" tabIndex={0} role="region" aria-label="월요일부터 일요일까지 배차 일정">
        {days.map((day,i)=>{
          const dayRows=rows.filter(({c})=>rentalOnDay(c,day,now));
          const dayWork=work.filter(({w})=>fleetWorkOnDay(w,day));
          return <section key={day} className="rental-week-day"><header>
            <span aria-current={day===today?'date':undefined}>{Number(day.slice(8))}일 {weekdays[i]}</span>
            <small>{daysLoaded?(dayRows.length+dayWork.length)+'건':'—'}</small></header>
            {dayRows.map(({c,v})=><button type="button" key={c.id} className="rental-week-event" onClick={()=>onContract(c)}>
              <strong>{v?vehicleName(v):isAssigned(c)?(c.license_plate||'배정 차량'):(c.rental_terms?.requested_model||'차종 미지정')+' · 미배정'}</strong>
              <small>{c.renter_name} · {kstDateTime(c.starts_at).slice(-5)} 인수</small><StageBadge contract={c} now={now}/></button>)}
            {dayWork.map(({w,v})=><button type="button" key={w.id} className="rental-week-event is-work" onClick={()=>onWork(isIncident(w.kind)?'incidents':'service',w.id)}>
              <strong>{vehicleName(v)}</strong><small>{repairNames[w.kind]||'차량 준비'} · {workTimeRange(w)}</small>
              <span className={'rental-status'+(workState(w)==='done'?'':' amber')}>{workStageName(w)}</span></button>)}
            {!dayRows.length&&!dayWork.length&&<p>{daysLoaded?'일정 없음':error?'조회 미완료':'조회 중…'}</p>}
          </section>;
        })}
      </div>
    </section>
  </div>;
}
