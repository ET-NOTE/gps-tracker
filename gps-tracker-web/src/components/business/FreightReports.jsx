import {useState} from 'react';
import {freightReport} from '../../lib/freightReports';
import {freightPages} from '../../lib/freightMenu';
import {stamp,costLabel,firstOrder,routeName,nameOf,vehicleName,timeLabel,shipStates} from '../../lib/freightWorkflow';
import {csvCell} from '../../lib/businessExport';
import {saveBlob} from '../../lib/fileDownload';
import {FreightField,FreightOptions,FreightStats,FreightTable,FreightButton} from './FreightKit';
import {FreightRecordActions} from './FreightWorkflow';
import {Status} from './FreightDetail';
import {ChartPanel,ReportBars} from './OperationsChart';

function ReportsView({page,data,onPage,open}){
  const today=stamp().slice(0,10), defaults={start:today.slice(0,7)+'-01',end:today,branch:'',carrier:'*'};
  const [filters,set]=useState(defaults),[failure,fail]=useState('');
  const update=k=>e=>set({...filters,[k]:e.target.value}),r=freightReport(data,filters);
  const util=page==='cargo-utilization',profit=page==='cargo-profit';
  let stats=[],columns=[],rows=[],amounts=[];
  if(!r.error){
    const t=r.totals;
    if(util){
      const u=r.utilization;
      columns=['차량번호','운송 건수','배차일','조회 일수','배차일 비율 (%)','완료 정비비'];amounts=[5];
      rows=u.map(v=>({id:v.id,cells:[v.plate,v.count,v.days,r.dayCount,v.ratio,v.cost]}));
      stats=[['조회 차량',u.length+'대'],['배차 일정 있음',u.filter(v=>v.days).length+'대'],['배차일 비율',(u.length?Math.round(100*u.reduce((n,v)=>n+v.days,0)/r.dayCount/u.length):0)+'%'],['완료 차량 관리비',costLabel(u.reduce((n,v)=>n+v.cost,0))]];
    }else if(profit){
      columns=['운송번호','화주','소속','청구 운임','지급 운임','회사 부담 추가비','운임 차익'];amounts=[3,4,5,6];
      rows=r.shipments.map(s=>({id:s.id,cells:[s.number,s.shipper,s.carrier,s.sell,s.buy,s.cost,s.margin]}));
      stats=[['합의 청구 운임',costLabel(t.sell)],['합의 지급 운임',costLabel(t.buy)],['회사 부담 추가비',costLabel(t.cost)],['운임 차익',costLabel(t.margin)]];
    }else{
      columns=['화주','운송 건수','완료 건수','합의 청구 운임','합의 지급 운임','양쪽 운임 확정'];amounts=[3,4];
      rows=r.groups.map(g=>({id:g.name,cells:[g.name,g.count,g.delivered,g.sell,g.buy,g.known]}));
      stats=[['조회 운송',r.shipments.length+'건'],['운송 완료',t.delivered+'건'],['합의 청구 운임',costLabel(t.sell)],['합의 지급 운임',costLabel(t.buy)]];
    }
  }
  async function download(){
    fail('');try{const lines=[columns,...rows.map(r=>r.cells.map(v=>v??'미정'))];
      await saveBlob(new Blob(['\uFEFF'+lines.map(row=>row.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),freightPages.get(page)+'_'+filters.start+'_'+filters.end+'.csv');
    }catch(e){fail(e.message);}
  }
  const sourceShips=new Map(data.shipments.map(s=>[s.id,s]));
  const report=!util&&!profit;
  const shipLink=s=><button type="button" className="fr-link" onClick={()=>open('shipments',s.id)}>{s.number}</button>;
  const facts=(main,detail)=><>{main}<small>{detail}</small></>;
  return <div className="fr-page ops-report">
    {!r.error&&<><FreightStats items={stats}/><div className="ops-tools"><p>선택한 기간과 소속을 기준으로 집계합니다.</p><FreightButton icon="download" onClick={download}>CSV 다운로드</FreightButton></div></>}
    <div className="ops-filter-box"><div className="fr-filters">
    {[['start','상차 시작일'],['end','상차 종료일']].map(([k,l])=><FreightField label={l} key={k}><input type="date" value={filters[k]} onChange={update(k)}/></FreightField>)}
    <FreightField label="운영 지점"><select value={filters.branch} onChange={update('branch')}><FreightOptions rows={data.branches} blank="전체 지점"/></select></FreightField>
    <FreightField label="소속"><select value={filters.carrier} onChange={update('carrier')}><option value="*">전체 소속</option><option value="">자사</option><FreightOptions rows={data.carriers}/></select></FreightField>
    </div><div className="ops-filter-actions"><span>{!r.error&&'조회 운송 '+r.shipments.length+'건'}</span><button type="button" onClick={()=>set(defaults)}>조회 조건 초기화</button></div></div>
    {r.error?<p role="alert">{r.error}</p>:<>
      {report&&<div className="ops-report-grid">
        <ChartPanel title="화주별 운송 실적"><ReportBars values={r.groups.map(g=>({label:g.name,value:g.count}))} unit="건"/></ChartPanel>
        <ChartPanel title="진행 상태"><ReportBars values={Object.entries(shipStates).filter(([key])=>key!=='cancelled').map(([key,label])=>({label,value:r.shipments.filter(s=>s.status===key).length}))} unit="건"/></ChartPanel>
      </div>}
      {util&&<ChartPanel title="차량별 배차일 비율" subtitle={r.dayCount+'일 조회'}><ReportBars values={r.utilization.map(v=>({label:v.plate,value:v.ratio}))} unit="%" height={220}/></ChartPanel>}
      {report&&<section className="ops-table-panel" aria-label="운송별 실적"><FreightTable columns={['운송 / 화주','차량 / 기사','경로 / 일정','상태']} rows={r.shipments.map(s=>{
        const original=sourceShips.get(s.id);return {id:s.id,onOpen:()=>open('shipments',s.id),cells:[facts(shipLink(s),s.shipper),facts(vehicleName(data,original.vehicleId),nameOf(data,'drivers',original.driverId)),
          facts(routeName(data,firstOrder(data,original)),timeLabel(original.start)),<Status value={s.status} labels={shipStates}/>]};
      })}/></section>}
      <section className="ops-table-panel" aria-label={util?'차량별 운영 내역':profit?'운송별 운임 차익':'화주별 합계'}>
        {report&&<header className="ops-table-head"><h2>화주별 합계</h2></header>}
        <FreightTable columns={columns} rows={rows.map(row=>({...row,onOpen:profit?()=>open('shipments',row.id):undefined,
          cells:row.cells.map((v,i)=>profit&&i===0?shipLink({id:row.id,number:v}):amounts.includes(i)?costLabel(v):v)}))}/></section>
      <p className="ops-note">{util?'배차일은 차량별로 운송 일정이 잡힌 날짜를 한 번씩 집계합니다.':'상차 예정일 기준으로 승인된 추가 비용을 포함합니다. 양쪽 운임이 확정된 '+r.totals.known+'건의 차익을 집계했습니다.'}</p>
      {profit&&<section className="fr-dashboard-card"><header><h2>별도 차량 관리비</h2><FreightButton onClick={()=>onPage('cargo-maintenance')}>정비·보험 내역</FreightButton></header>
        <div className="fr-live-detail">조회 기간 완료 정비·보험 비용 <strong>{costLabel(r.utilization.reduce((n,v)=>n+v.cost,0))}</strong></div></section>}
      </>}
    {failure&&<p role="alert">{failure}</p>}
  </div>;
}

export default function FreightReports(props){
  return <FreightRecordActions {...props}>{({open})=><ReportsView {...props} open={open}/>}</FreightRecordActions>;
}
