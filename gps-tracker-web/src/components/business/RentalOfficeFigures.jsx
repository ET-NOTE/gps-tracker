import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Button,Modal} from '../ui';
import {api} from '../../api';
import {useRentals,qk} from '../../state';
import {authScope} from '../../authSession';
import {Field,Metrics,Table} from './RentalOfficeKit';
import {dailyFigures,readTime,returnReadingsRange,vehicleUsage,won} from '../../lib/rentalOffice';
import {fleetWorkKey} from './RentalFleetWork';
import {matchesVehicle} from '../../lib/rentalInventory';
import ExportButtons from './ExportButtons';
import RentalOfficeCharts from './RentalOfficeCharts';
import {ChartPanel,ReportBars} from './OperationsChart';

const total=(rows,value)=>rows.reduce((n,row)=>n+value(row),0);
const decimal=n=>n.toLocaleString('ko-KR',{maximumFractionDigits:1});
const dayColumns=[['날짜',r=>r.id],['이용료 수납',r=>won(r.payment)],['이용료 환불',r=>won(r.refund)],['운영비',r=>won(r.cost)],['수납 차액',r=>won(r.payment-r.refund-r.cost)]];
function distanceText({distance,measured,missing}) {
  if(!measured)return missing?'미측정 '+missing+'건':'반납 없음';
  return decimal(distance)+' km'+(missing?' · 미측정 '+missing+'건':'');
}
function csv(title,period,columns,rows) {
  return {title,filename:title+'_'+period.from+'_'+period.to,columns:columns.map(([label],key)=>({key,label})),rows};
}
function modelGroups(book,started,contracts,modelOf) {
  const groups=new Map();
  function group(row) {
    const id=modelOf(row);
    if(!groups.has(id))groups.set(id,{id,contracts:[],amount:0,paid:0,cost:0});
    return groups.get(id);
  }
  for(const c of started){const g=group(c);g.contracts.push(c);g.amount+=c.billed_krw;}
  for(const e of book.entries)if(e.kind==='payment'||e.kind==='refund'){
    const c=contracts.get(e.contract_id);if(c)group(c).paid+=e.kind==='refund'?-e.amount_krw:e.amount_krw;
  }
  for(const c of book.costs)group(c).cost+=c.amount_krw;
  return [...groups.values()].sort((a,b)=>b.contracts.length-a.contracts.length||a.id.localeCompare(b.id,'ko'));
}
export default function RentalOfficeFigures({book:all,devices:vehicles,period,dates,pending,usage,onResetPeriod}) {
  const [branch,setBranch]=useState(''),[model,setModel]=useState(''),[detail,setDetail]=useState(null);
  const profileOf=row=>vehicles.find(v=>matchesVehicle(row,v));
  const modelOf=row=>row.requested_model||profileOf(row)?.class_name||profileOf(row)?.car_model||'차종 미지정';
  const branchOf=row=>row.pickup_location||profileOf(row)?.branch||'';
  const matches=row=>(!branch||branch===branchOf(row))&&(!model||model===modelOf(row));
  const index=vehicles.map(d=>({vehicle_id:d.id,device_id:d.device_id}));
  const options=[...all.contracts,...index,...all.costs];
  const branches=[...new Set(options.map(branchOf).filter(Boolean))].sort(),models=[...new Set(options.map(modelOf))].sort();
  const contracts=all.contracts.filter(matches),byId=new Map(contracts.map(c=>[c.id,c]));
  const book={contracts,costs:all.costs.filter(matches),entries:all.entries.filter(e=>byId.has(e.contract_id))};
  const start=Date.parse(period.from+'T00:00:00+09:00'),end=Date.parse(period.to+'T00:00:00+09:00')+86400000;
  const started=contracts.filter(c=>c.status!=='cancelled'&&Date.parse(c.starts_at)>=start&&Date.parse(c.starts_at)<end);
  const daily=dailyFigures(book),pay=total(daily,r=>r.payment-r.refund),cost=total(daily,r=>r.cost);
  const groups=modelGroups(book,started,byId,modelOf);
  const params=usage?returnReadingsRange(contracts,period):null;
  const readings=useRentals(params||{},{enabled:!!params&&!pending,queryKey:[...qk.rentals(params||{}),authScope()],staleTime:30000,retry:1});
  const work=useQuery({queryKey:fleetWorkKey(),queryFn:api.rentalFleetWork,enabled:usage,staleTime:15000,retry:1});
  const workStatus=work.isError?'조회 실패':!work.data?'조회 중':'';
  const distanceStatus=params?(readings.isError?'조회 실패':!readings.data?'조회 중':''):'';
  const usageRows=usage?vehicleUsage(book,vehicles.filter((_,i)=>matches(index[i])),period,Date.now(),{
    readings:readings.data||[],work:(work.data||[]).filter(matches),
  }):[];
  const mileage={distance:total(usageRows,r=>r.distance),measured:total(usageRows,r=>r.measured),missing:total(usageRows,r=>r.missing)};
  const usageColumns=[['차량',r=>r.name],['대여 건수',r=>r.intervals.length+'건'],['대여 시간',r=>decimal(r.hours)+'시간'],['가동률',r=>decimal(r.utilization)+'%'],
    ['완료 정비 시간',r=>workStatus||decimal(r.completedHours)+'시간'],['진행·예정 일정',r=>workStatus||decimal(r.scheduledHours)+'시간'],
    ['운영비',r=>won(r.cost)],['반납 기록 거리',r=>distanceStatus||distanceText(r)],['이용료 순수납',r=>won(r.revenue)]];
  const groupColumns=[['차종',g=>g.contracts.length?<button type="button" className="fr-link" onClick={()=>setDetail(g.id)}>{g.id}</button>:g.id],['시작 계약',g=>g.contracts.length+'건'],['계약 금액',g=>won(g.amount)],['대여료 순수납',g=>won(g.paid)],['운영 지출',g=>won(g.cost)]];
  const daysCsv=csv('일별 대여·매출',period,dayColumns,daily.map(r=>[r.id,r.payment,r.refund,r.cost,r.payment-r.refund-r.cost]));
  const exportReport=usage?csv('차량 가동·운영비',period,usageColumns,usageRows.map(r=>[r.name,r.intervals.length,r.hours.toFixed(1),r.utilization.toFixed(1)+'%',
    workStatus||r.completedHours.toFixed(1),workStatus||r.scheduledHours.toFixed(1),r.cost,distanceStatus||distanceText(r),r.revenue])):
    csv('차종별 대여·매출',period,groupColumns,groups.map(g=>[g.id,g.contracts.length,g.amount,g.paid,g.cost]));
  const stats=usage?[['차량 시간 가동률',decimal(usageRows.length?total(usageRows,r=>r.utilization)/usageRows.length:0)+'%'],['총 대여 시간',decimal(total(usageRows,r=>r.hours))+'시간'],['차량 운영비',won(total(usageRows,r=>r.cost))],['반납 기록 주행거리',distanceStatus||distanceText(mileage)]]:
    [['기간 내 시작 계약',started.length+'건'],['대여료 순수납',won(pay)],['운영 지출',won(cost)],['수납 − 지출',won(pay-cost)]];
  const selected=groups.find(g=>g.id===detail);
  return <div className="ops-report">
    <div className="ops-tools"><p>{usage?'대여 중·반납·정산 완료 계약 기준':'금액은 등록된 계약·결제·지출 기록 기준입니다.'}</p><ExportButtons csvOnly csvLabel={usage?'운영 통계 다운로드':'통계 다운로드'} report={exportReport} disabled={pending||usage&&(distanceStatus==='조회 중'||workStatus==='조회 중')}/></div>
    <div className="ops-filter-box"><div className="ro-filters">{dates}
      <Field label="소속 지점"><select value={branch} onChange={e=>setBranch(e.target.value)}><option value="">전체 지점</option>{branches.map(b=><option key={b}>{b}</option>)}</select></Field>
      <Field label="차종"><select value={model} onChange={e=>setModel(e.target.value)}><option value="">전체 차종</option>{models.map(m=><option key={m}>{m}</option>)}</select></Field></div>
      <div className="ops-filter-actions"><span>{usage?'조회 차량 '+usageRows.length+'대':'기간 내 시작 계약 '+started.length+'건'}</span><button type="button" onClick={()=>{setBranch('');setModel('');onResetPeriod();}}>조회 조건 초기화</button></div></div>
    <Metrics items={stats}/>
    {usage&&work.isError&&<p className="ops-note" role="status">정비 일정을 불러오지 못했습니다. <button type="button" className="fr-link" onClick={()=>work.refetch()}>정비 일정 다시 조회</button></p>}
    {usage&&params&&readings.isError&&<p className="ops-note" role="status">반납 거리 기록을 불러오지 못했습니다. <button type="button" className="fr-link" onClick={()=>readings.refetch()}>반납 거리 다시 조회</button></p>}
    {usage?<ChartPanel title="차량별 가동률" subtitle="가동률이 높은 차량 최대 6대"><ReportBars values={usageRows.slice(0,6).map(r=>({label:r.name,value:Number(r.utilization.toFixed(1))}))} unit="%" height={170} empty="조회된 차량이 없습니다."/></ChartPanel>:
      <RentalOfficeCharts figures={daily} groups={groups} period={period}/>}
    <section className="ops-table-panel"><header className="ops-table-head"><h2>{usage?'차량별 운영 내역':'차종별 내역'}</h2>{!usage&&<small>차종을 누르면 연결 계약을 확인할 수 있습니다.</small>}</header>
      <Table columns={usage?usageColumns:groupColumns} rows={usage?usageRows:groups} empty="조회 기간에 집계할 내역이 없습니다."/></section>
    {!usage&&<section className="ops-table-panel"><header className="ops-table-head"><h2>일별 수납·지출</h2><ExportButtons csvOnly disabled={pending} report={daysCsv}/></header>
      <Table columns={dayColumns} rows={daily} empty="조회 기간에 이용료 수납·환불 또는 지출이 없습니다."/></section>}
    {selected&&<Modal open title={selected.id+' · 시작 계약'} onClose={()=>setDetail(null)}><Table columns={[[ '계약번호',c=>'#'+c.id],['고객',c=>c.renter_name],['대여 시작',c=>readTime(c.starts_at)],['계약 금액',c=>won(c.billed_krw)]]} rows={selected.contracts} empty="계약이 없습니다."/><Button onClick={()=>setDetail(null)}>닫기</Button></Modal>}
  </div>;
}
