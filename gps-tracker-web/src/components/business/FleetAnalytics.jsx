import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { businessDate } from '../../lib/business';
import { expenseStatus } from '../../lib/fleetExpenses';
import { downloadReport } from '../../lib/downloadReport';
import { subjectReport, subjectScopeNote } from '../../lib/subjectReport';
import { analyticGroups, analyticsPeriodError, costAnalyticsRows, tripAnalyticsRows, groupAnalytics, trendSeries } from '../../lib/fleetAnalytics';
import { fleetAssetLabel } from '../../lib/fleetAssets';
import { BusinessButton, BusinessEmpty, BusinessError, BusinessMetrics, BusinessSection } from './BusinessWorkspace';
import './fleet-analytics.css';

const number = (n, digits = 0) => n.toLocaleString('ko-KR',{maximumFractionDigits:digits});
const distance = km => km > 0 && km < .01 ? '<0.01' : number(km, 2);
function duration(minutes) {
  if (minutes > 0 && minutes < 1) return '1분 미만';
  const whole = Math.round(minutes);
  return whole < 60 ? whole+'분' : Math.floor(whole/60)+'시간 '+whole%60+'분';
}

async function loadTrips(devices, params, signal) {
  const batches = new Array(devices.length), failed = [];
  let next = 0, stopped = false;
  async function worker() {
    while (next < devices.length && !stopped && !signal?.aborted) {
      const index = next++, device = devices[index];
      try {
        const trips = await api.listFleetVehicleTrips(device.id, params, {signal});
        const rows = tripAnalyticsRows(trips, device);
        batches[index] = {rows, excluded:trips.length - rows.length, scoped:Boolean(trips.subjectScope)};
      } catch (error) {
        if (signal?.aborted || [401,403,404].includes(error.status) || params.download) {
          stopped = true;
          throw error;
        }
        failed.push({id:device.id, error});
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(4, devices.length)}, worker));
  if (signal?.aborted) throw new DOMException('조회가 취소되었습니다.','AbortError');
  if (devices.length && failed.length === devices.length) throw failed[0].error;
  const received = batches.filter(Boolean);
  return {
    rows:received.flatMap(batch=>batch.rows),
    excluded:received.reduce((sum,batch)=>sum+batch.excluded,0),
    scoped:received.some(batch=>batch.scoped), failed:failed.length,
  };
}

function Trend({series, unit, format}) {
  const max = Math.max(1,...series.map(point=>point.value));
  const positions = series.map((point,i)=>({x:series.length===1?50:2+96*i/(series.length-1),y:95-86*point.value/max}));
  return <div className="fleet-analytics-trend">
    <div className="fleet-analytics-trend-scale">{format(max)} {unit}</div>
    <div className="fleet-analytics-plot">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`${series[0].date}부터 ${series.at(-1).date}까지 추이. 아래에서 기간별 수치를 확인할 수 있습니다.`}>
        <polygon points={`${positions[0].x},100 ${positions.map(p=>p.x+','+p.y).join(' ')} ${positions.at(-1).x},100`} fill="currentColor" opacity=".09"/>
        <polyline points={positions.map(p=>p.x+','+p.y).join(' ')} vectorEffect="non-scaling-stroke" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round"/>
      </svg>
      {positions.length===1&&<i className="fleet-analytics-single" style={{left:'50%',top:positions[0].y+'%'}}/>}
    </div>
    <div className="fleet-analytics-axis"><span>{series[0].date}</span>{series.length>1&&<span>{series.at(-1).date}</span>}</div>
    <details><summary>기간별 수치</summary><dl>{series.map(point=><div key={point.date}><dt>{point.date}</dt><dd>{format(point.value)} {unit}</dd></div>)}</dl></details>
  </div>;
}

function Filter({label, children, ...props}) {
  return <label>{label}<select aria-label={label} {...props}>{children}</select></label>;
}

export default function FleetAnalytics({section='trips', devices=[], onReport, initialPeriod}) {
  const trips = section==='trips', today = businessDate();
  const [from,setFrom] = useState(initialPeriod?.from||today.slice(0,7)+'-01'), [to,setTo] = useState(initialPeriod?.to||today);
  const [vehicle,setVehicle] = useState(''), [status,setStatus] = useState('approved');
  const [dimension,setDimension] = useState(''), [group,setGroup] = useState(trips?'vehicle':'category');
  const [metric,setMetric] = useState('amount'), [exporting,setExporting] = useState(false), [exportMessage,setExportMessage] = useState('');
  const live = useRef(true), exportRequest = useRef(null);
  useEffect(()=>{live.current=true; return ()=>{live.current=false;exportRequest.current?.abort();};},[]);
  const selected = vehicle ? devices.filter(d=>String(d.id)===vehicle) : devices;
  const filters = {from,to,...(vehicle?{vehicle_id:vehicle}:{}),...(status?{status}:{})};
  const periodError = analyticsPeriodError(from,to);
  async function fetchRows(signal, download) {
    if (trips) return loadTrips(selected,{from,to,...(download?{download}: {})},signal);
    const result = await api.listExpenses(filters);
    return {rows:costAnalyticsRows(result.items), failed:0};
  }
  const result = useQuery({
    queryKey:['fleet-analytics',section,from,to,vehicle,trips?selected.map(d=>[d.id,d.license_plate,d.vehicle_name,d.department]):status],
    queryFn:({signal})=>fetchRows(signal),enabled:!periodError,
  });
  const allRows = result.data?.rows || [];
  const filterBy = trips?'driver':'category';
  const options = groupAnalytics(allRows,filterBy).sort((a,b)=>a.label.localeCompare(b.label,'ko'));
  const filterRows = source=>source.filter(row=>row.date>=from && row.date<=to && (!dimension || row[filterBy]===dimension));
  const rows = filterRows(allRows);
  const sum = rows.reduce((total,row)=>total+row.amount,0);
  const vehicles = new Set(rows.map(r=>r.vehicle).filter(id=>id!=='general')).size;
  const groupName = analyticGroups[section][group], groups = groupAnalytics(rows,group);
  const unit = trips?'km':'원', amount = trips?distance:number;
  const columns = [
    {key:'label',label:groupName},{key:'count',label:trips?'운행 건수':'지출 건수'},
    {key:'amount',label:trips?'주행거리 (km)':'지출액 (원)'},
    ...(trips?[{key:'time',label:'운행시간'}]:[]),{key:'average',label:trips?'평균 거리 (km)':'평균 지출 (원)'},{key:'share',label:'비중 (%)'},
  ];
  async function exportCsv() {
    if (exportRequest.current) return;
    const controller = new AbortController();
    exportRequest.current = controller;
    setExporting(true);setExportMessage('');
    try {
      const fresh = await fetchRows(controller.signal,'csv');
      if (!live.current) return;
      const freshRows = filterRows(fresh.rows), total = freshRows.reduce((s,r)=>s+r.amount,0);
      const title = trips?'운행 통계':'지출 통계';
      const csvRows = groupAnalytics(freshRows,group).map(g=>({
        label:g.label,count:g.count,amount:Number(g.amount.toFixed(3)),time:duration(g.minutes),
        average:Number((g.amount/g.count).toFixed(trips?3:0)),share:total?Number((100*g.amount/total).toFixed(1)):'',
      }));
      const range = [from+' ~ '+to, trips?'확정 운행':expenseStatus[status]||'전체 지출 상태', groupName+'별'];
      if (dimension) range.push(options.find(o=>o.id===dimension)?.label || dimension);
      const report = subjectReport({title,filename:`${title}_${from}_${to}`,csvPreamble:[range],columns,rows:csvRows},fresh.scoped);
      const saved = await downloadReport(report,'csv');
      if (live.current) setExportMessage(saved?.status==='cancelled'?'다운로드를 취소했습니다.':'CSV 파일을 만들었습니다.');
    } catch(error) { if (live.current) setExportMessage(error.message||'CSV 파일을 만들지 못했습니다.'); }
    finally { exportRequest.current=null; if (live.current) setExporting(false); }
  }
  const ready = !periodError && !result.isPending && !result.error;
  const categories = groupAnalytics(rows,'category').sort((a,b)=>trips?b.count-a.count:b.amount-a.amount);
  const series = !periodError && rows.length ? trendSeries(rows,from,to,trips&&metric==='count') : [];
  const metrics = trips ? [
    {label:'확정 운행',value:number(rows.length),unit:'건',icon:'route'},
    {label:'총 주행거리',value:rows.length?distance(sum):null,unit:'km'},{label:'총 운행시간',value:rows.length?duration(rows.reduce((s,r)=>s+r.minutes,0)):null,icon:'clock'},
    {label:'운행 차량',value:number(vehicles),unit:'대',icon:'list'},
  ] : [
    {label:(expenseStatus[status]||'조회')+' 지출 합계',value:number(sum),unit:'원',icon:'coin'},
    {label:'지출 건수',value:number(rows.length),unit:'건',icon:'list'},{label:'대상 차량',value:number(vehicles),unit:'대'},
    {label:'건당 평균',value:rows.length?number(sum/rows.length):null,unit:'원'},
  ];
  return <div className="fleet-analytics">
    <div className="fleet-analytics-toolbar"><div className="fleet-analytics-tabs" role="group" aria-label="집계 기준">
      {Object.entries(analyticGroups[section]).map(([id,label])=><button type="button" key={id} aria-pressed={group===id} onClick={()=>setGroup(id)}>{label}별</button>)}
    </div><BusinessButton icon="download" disabled={!ready||Boolean(result.data?.failed)||exporting||!rows.length} onClick={exportCsv}>{exporting?'생성 중…':'리포트 CSV'}</BusinessButton></div>
    {exportMessage&&<p role="status" className="fleet-analytics-note">{exportMessage}</p>}
    <section className="fleet-analytics-filters" aria-label="통계 조회 조건">
      <label>시작일<input type="date" value={from} onChange={e=>{setFrom(e.target.value);setDimension('');}}/></label>
      <label>종료일<input type="date" value={to} onChange={e=>{setTo(e.target.value);setDimension('');}}/></label>
      <Filter label="차량" value={vehicle} onChange={e=>{setVehicle(e.target.value);setDimension('');}}>
        <option value="">전체 차량{!trips?'·일반 지출':''}</option>
        {devices.map(d=><option key={d.id} value={String(d.id)}>{d.asset?fleetAssetLabel(d.asset):d.vehicle_name||d.license_plate||`차량 ${d.id}`}</option>)}
      </Filter>
      {!trips&&<Filter label="지출 상태" value={status} onChange={e=>{setStatus(e.target.value);setDimension('');}}>
        <option value="">전체 상태</option>{Object.entries(expenseStatus).map(([id,label])=><option key={id} value={id}>{label}</option>)}
      </Filter>}
      <Filter label={trips?'운전자':'지출 항목'} value={dimension} disabled={!ready} onChange={e=>setDimension(e.target.value)}>
        <option value="">전체 {trips?'운전자':'항목'}</option>{options.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}
      </Filter>
    </section>
    {periodError?<BusinessError>{periodError}</BusinessError>:result.error?<BusinessError onRetry={result.refetch}>{result.error.message||'통계를 불러오지 못했습니다.'}</BusinessError>:result.isPending?<p role="status" className="fleet-analytics-note">통계를 불러오는 중…</p>:<>
      {(result.data.failed>0)&&<BusinessError onRetry={result.refetch}>차량 {selected.length}대 중 {result.data.failed}대를 조회하지 못했습니다. 아래는 조회된 차량의 부분 합계입니다.</BusinessError>}
      {result.data.scoped&&<p className="fleet-analytics-note">{subjectScopeNote}</p>}
      {result.data.excluded>0&&<p className="fleet-analytics-note">조회한 차량의 미확정 운행 {number(result.data.excluded)}건은 합계에서 제외했습니다.</p>}
      <BusinessMetrics items={metrics}/>
      <div className="fleet-analytics-charts"><BusinessSection title={trips?'운행 추이':'지출 추이'} action={trips&&<div className="fleet-analytics-tabs" role="group" aria-label="추이 단위">{[['amount','주행거리'],['count','운행 건수']].map(([id,label])=><button key={id} type="button" aria-pressed={metric===id} onClick={()=>setMetric(id)}>{label}</button>)}</div>}>
        {series.length?<Trend series={series} unit={trips&&metric==='count'?'건':unit} format={trips&&metric==='amount'?distance:number}/>:<BusinessEmpty compact title="조회 기간에 집계할 기록이 없습니다."/>}
      </BusinessSection><BusinessSection title={trips?'운행목적별 건수':'항목별 지출'}>
        {categories.length?<ul className="fleet-analytics-bars">{categories.map(c=>{
          const value=trips?c.count:c.amount, maximum=trips?categories[0].count:categories[0].amount;
          return <li key={c.id}><div><span>{c.label}</span><strong>{number(value)} {trips?'건':'원'}</strong></div><i><b style={{width:(maximum?value/maximum*100:0)+'%'}}/></i></li>;
        })}</ul>:<BusinessEmpty compact title="집계할 항목이 없습니다."/>}
      </BusinessSection></div>
      <BusinessSection title={`${groupName}별 ${trips?'운행':'지출'} 현황`}>
        {groups.length?<div className="fleet-analytics-table" role="region" aria-label="통계 집계표" tabIndex={0}><table><thead><tr>{columns.map(c=><th key={c.key} scope="col">{c.label}</th>)}</tr></thead>
        <tbody>{groups.map(g=><tr key={g.id}><th scope="row">{trips&&group==='vehicle'&&onReport?<button type="button" onClick={()=>onReport(devices.find(d=>String(d.id)===g.id),{from,to})}>{g.label}</button>:g.label}</th>
          <td>{number(g.count)}</td><td>{amount(g.amount)}</td>{trips&&<td>{duration(g.minutes)}</td>}<td>{amount(g.amount/g.count)}</td><td>{sum?number(100*g.amount/sum,1):'—'}</td></tr>)}</tbody></table></div>:<BusinessEmpty compact title="표시할 집계 결과가 없습니다."/>}
      </BusinessSection>
    </>}
  </div>;
}
