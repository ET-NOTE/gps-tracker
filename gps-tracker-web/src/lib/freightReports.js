import {addDays,epoch,firstOrder,inputTime,nameOf} from './freightWorkflow.js';
import {shipmentFinance} from './freightFinance.js';

export function freightReport(data, filter){
  const {start,end,branch,carrier}=filter, dayCount=Math.round((epoch(end+'T00:00')-epoch(start+'T00:00'))/86400000)+1;
  if(!Number.isFinite(dayCount)||dayCount<1||dayCount>366) return {error:'시작일부터 종료일까지 최대 366일을 선택해 주세요.'};
  const day=t=>inputTime(t).slice(0,10), inPeriod=t=>day(t)>=start&&day(t)<=end;
  const matches=r=>(!branch||r.branchId===branch)&&(carrier==='*'||(r.carrierId||'')===carrier);
  const runs=data.shipments.filter(s=>s.status!=='cancelled');
  const shipments=runs.filter(s=>matches(s)&&inPeriod(s.start)).map(s=>({
    id:s.id,number:s.number,shipper:nameOf(data,'shippers',firstOrder(data,s)?.shipperId),carrier:s.carrierId?nameOf(data,'carriers',s.carrierId):'자사',
    status:s.status,...shipmentFinance(data,s)
  }));
  const groups=new Map(),totals={sell:0,buy:0,margin:0,cost:0,known:0,delivered:0};
  for(const x of shipments){
    const group=groups.get(x.shipper)||{name:x.shipper,count:0,delivered:0,sell:0,buy:0,known:0};
    group.count++; group.delivered+=Number(x.status==='delivered');totals.delivered+=Number(x.status==='delivered');
    for(const key of ['sell','buy']){group[key]+=x[key]??0;totals[key]+=x[key]??0;}
    if(x.margin!=null){group.known++;totals.known++;totals.margin+=x.margin;}
    totals.cost+=x.cost;groups.set(x.shipper,group);
  }
  const utilization=data.vehicles.filter(matches).map(v=>{
    const jobs=runs.filter(s=>s.vehicleId===v.id&&day(s.start)<=end&&day(s.end)>=start);
    const days=new Set();
    for(const s of jobs){const first=day(s.start)<start?start:day(s.start),last=day(s.end)>end?end:day(s.end);
      for(let d=first;d<=last;d=addDays(d,1))days.add(d);}
    const cost=data.services.filter(m=>m.vehicleId===v.id&&m.status==='done'&&inPeriod(m.start)).reduce((n,m)=>n+(m.cost??0),0);
    return {id:v.id,plate:v.plate,count:jobs.length,days:days.size,ratio:Math.round(days.size/dayCount*100),cost};
  });
  return {shipments,groups:[...groups.values()],totals,utilization,dayCount};
}
