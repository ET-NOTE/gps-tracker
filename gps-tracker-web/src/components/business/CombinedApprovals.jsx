import React,{useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {api} from '../../api';
import {useStaff} from '../../state';
import {businessDate} from '../../lib/business';
import {approvalLabels,approvalRecords,approvalReport,filterApprovals} from '../../lib/fleetApprovals';
import {scopedStaff} from '../../lib/fleetPeopleReport';
import {useFleetAccess} from './FleetAccess';
import {BusinessButton,BusinessEmpty,BusinessError} from './BusinessWorkspace';
import ExportButtons from './ExportButtons';
import FleetRecordMetrics from './FleetRecordMetrics';
import Icon from '../Icon';
import ExpenseBatchReview from './ExpenseBatchReview';
import './combined-approvals.css';

function initialFilters(){
  const today=businessDate();
  return {from:today.slice(0,7)+'-01',to:today,status:'pending',person:'',department:'',query:''};
}
function options(rows,key,field,placeholder){
  const values=new Map(rows.map(row=>[row[key],row[field]||(row[key]==='unknown'?'확인할 수 없음':placeholder)]));
  return [...values].sort((a,b)=>a[1].localeCompare(b[1],'ko')).map(([value,label])=><option key={value} value={value}>{label}</option>);
}

export default function CombinedApprovals({onOpen,canExpenses,canReservations}){
  const [filters,setFilters]=useState(initialFilters),[selection,setSelection]=useState(new Map());
  const [batch,setBatch]=useState(null),[result,setResult]=useState(null);
  const qc=useQueryClient(),access=useFleetAccess(),staff=useStaff();
  const {from,to,status,person,department,query}=filters;
  const start=Date.parse(from+'T00:00:00+09:00'),end=Date.parse(to+'T00:00:00+09:00')+86400000;
  const valid=Number.isFinite(start)&&Number.isFinite(end)&&end>start&&end-start<=366*86400000;
  const expenseFilter={from,to,...(status?{status}:{})};
  const bookingFilter=valid?{from:new Date(start).toISOString(),to:new Date(end).toISOString()}:{};
  const expenses=useQuery({queryKey:['fleet-expenses',expenseFilter],queryFn:()=>api.listExpenses(expenseFilter),enabled:valid&&canExpenses});
  const bookings=useQuery({queryKey:['business','corporate','vehicle-reservations',bookingFilter],queryFn:()=>api.listFleetReservations(bookingFilter),enabled:valid&&canReservations});
  const ready=valid&&(!canExpenses||expenses.isSuccess&&!expenses.isFetching)&&(!canReservations||bookings.isSuccess&&!bookings.isFetching);
  const staffRows=staff.error?[]:scopedStaff(staff.data||[],access);
  const records=ready?approvalRecords(canReservations?bookings.data:[],canExpenses?expenses.data.items:[],staffRows):[];
  const rows=filterApprovals(records,filters),pending=rows.filter(row=>row.status==='pending'&&row.raw.updated_at);
  const waiting=rows.filter(row=>row.status==='pending');
  const waitingExpenses=waiting.filter(row=>row.type==='expense');
  const picked=pending.filter(row=>selection.get(row.key)===row.raw.updated_at);
  const error=(canExpenses&&expenses.error)||(canReservations&&bookings.error);
  const context=JSON.stringify([access.owner_id,access.role,canExpenses,canReservations,filters]),current=useRef(context);
  current.current=context;

  function change(next){setFilters(next);setSelection(new Map());setResult(null);}
  function field(key,value){
    const dimensions=key==='from'||key==='to'?{person:'',department:''}:{};
    change({...filters,...dimensions,[key]:value});
  }
  function pick(row,on){setSelection(previous=>{const next=new Map(previous);if(on)next.set(row.key,row.raw.updated_at);else next.delete(row.key);return next;});}
  function refresh(){
    return Promise.all([['fleet-expenses'],['expense-detail'],['business','corporate','vehicle-reservations'],['fleet-reservation-history']].map(queryKey=>qc.invalidateQueries({queryKey})));
  }
  function finish(message,failed){setBatch(null);setSelection(new Map());setResult({message,failed});refresh();}
  async function freshReport(){
    const [book,spend]=await Promise.all([canReservations?bookings.refetch({throwOnError:true}):null,canExpenses?expenses.refetch({throwOnError:true}):null]);
    const hasDrivers=book?.data.some(row=>row.can_review&&row.approval_required&&row.driver_staff_id!=null);
    const roster=hasDrivers&&!staff.error?await api.listStaff():[];
    const latest=await api.fleetAccess();
    if(JSON.stringify(latest)!==JSON.stringify(access)){
      qc.setQueryData(['fleet-access'],latest);
      throw Error('조회 권한이 변경되었습니다. 목록을 확인한 뒤 다시 다운로드해 주세요.');
    }
    if(context!==current.current)throw Error('조회 조건이 변경되었습니다. 다시 다운로드해 주세요.');
    return approvalReport(filterApprovals(approvalRecords(book?.data||[],spend?.data.items||[],scopedStaff(roster,latest)),filters),filters);
  }
  return <section className="fleet-combined-approvals" aria-label="전체 승인 요청">
    <div className="fleet-approval-metrics"><FleetRecordMetrics label="조회 조건별 승인 요청 요약" items={[
      {name:'조회된 요청',value:ready?rows.length:null,unit:'건',icon:'check'},
      ...(canReservations?[{name:'예약 승인 대기',value:ready?waiting.length-waitingExpenses.length:null,unit:'건'}]:[]),
      ...(canExpenses?[
        {name:'지출 승인 대기',value:ready?waitingExpenses.length:null,unit:'건'},
        {name:'대기 지출 금액',value:ready?waitingExpenses.reduce((sum,row)=>sum+Number(row.raw.amount_krw),0):null,unit:'원'},
      ]:[]),
    ]}/></div>
    <div className="fleet-approval-actions"><ExportButtons csvOnly disabled={!ready||!rows.length} report={approvalReport(rows,filters)} prepareExport={freshReport}/></div>
    <div className="fleet-approval-filters">
      <fieldset><legend>요청 기간</legend><div><input type="date" aria-label="조회 시작일" value={from} max={to||undefined} onChange={e=>field('from',e.target.value)}/><span>~</span><input type="date" aria-label="조회 종료일" value={to} min={from||undefined} onChange={e=>field('to',e.target.value)}/></div></fieldset>
      <label>승인 상태<select value={status} onChange={e=>change({...filters,status:e.target.value,person:'',department:''})}>{Object.entries(approvalLabels).map(([k,v])=><option key={k} value={k}>{v}</option>)}<option value="">전체 상태</option></select></label>
      <label>담당자<select value={person} onChange={e=>field('person',e.target.value)}><option value="">전체 담당자</option>{options(records,'personKey','person','미지정')}</select></label>
      <label>담당자 부서<select value={department} onChange={e=>field('department',e.target.value)}><option value="">전체 부서</option>{options(records,'departmentKey','department','부서 미지정')}</select></label>
      <label>검색<span className="fleet-approval-search"><Icon name="search" size={15}/><input type="search" aria-label="차량, 담당자, 내용 검색" placeholder="차량, 담당자, 내용 검색" value={query} onChange={e=>field('query',e.target.value)}/></span></label>
      <button type="button" className="fleet-filter-reset-link" onClick={()=>change(initialFilters())}><Icon name="refresh" size={13}/>조건 초기화</button>
    </div>
    <p className="fleet-approval-guide">담당자와 부서는 예약의 운전자, 지출의 요청자를 기준으로 조회합니다.</p>
    <div className="fleet-approval-list-head"><strong><span>승인 요청 {ready?rows.length:'—'}건</span><small>{picked.length}건 선택</small></strong><div><BusinessButton disabled={!picked.length} onClick={()=>setBatch({decision:'rejected',rows:picked})}>선택 반려</BusinessButton><BusinessButton primary icon="check" disabled={!picked.length} onClick={()=>setBatch({decision:'approved',rows:picked})}>선택 승인</BusinessButton></div></div>
    {result&&<div role="status"><strong>{result.message}</strong>{result.failed.length>0&&<ul>{result.failed.map(item=><li key={item}>{item}</li>)}</ul>}</div>}
    {!valid?<p role="status">조회 기간을 1년 이내로 선택해 주세요.</p>:error?<BusinessError onRetry={refresh}>{error.message||'승인 요청을 불러오지 못했습니다.'}</BusinessError>:!ready?<p role="status">승인 요청 조회 중…</p>:<>
      <div className={rows.length?"fleet-approval-table":"fleet-approval-table is-empty"} role="region" aria-label="승인 요청 목록" tabIndex={0}><table><thead><tr><th scope="col"><input type="checkbox" aria-label="승인 대기 요청 전체 선택" disabled={!pending.length} checked={!!pending.length&&picked.length===pending.length} ref={node=>{if(node)node.indeterminate=picked.length>0&&picked.length<pending.length;}} onChange={e=>setSelection(new Map(e.target.checked?pending.map(row=>[row.key,row.raw.updated_at]):[]))}/></th>{['요청 구분','요청 내용','차량 / 요청자','요청일','금액 / 일정','상태','처리'].map(label=><th scope="col" key={label}>{label}</th>)}</tr></thead>
      <tbody>{rows.map(row=><tr key={row.key}><td data-label="선택">{row.status==='pending'&&row.raw.updated_at&&<input type="checkbox" aria-label={row.kind+' #'+row.raw.id+' 선택'} checked={selection.get(row.key)===row.raw.updated_at} onChange={e=>pick(row,e.target.checked)}/>}</td><td data-label="요청 구분"><span className={'fleet-approval-kind is-'+row.type}>{row.kind}</span></td><td data-label="요청 내용"><button type="button" className="fleet-approval-detail" onClick={()=>onOpen(row.type,row.raw)}>{row.title}</button></td><td data-label="차량 / 요청자">{row.vehicle||'—'}<small>{row.person||'미지정'}</small></td><td data-label="요청일">{row.date||'—'}</td><td data-label="금액 / 일정">{row.period}</td><td data-label="상태"><span className={'business-badge '+({approved:'good',pending:'warning',rejected:'urgent'}[row.status]||'')}>{approvalLabels[row.status]}</span></td><td data-label="처리">{row.status==='pending'&&row.raw.updated_at?<BusinessButton icon="check" onClick={()=>setBatch({decision:'approved',rows:[row]})}>승인</BusinessButton>:'—'}</td></tr>)}</tbody></table></div>
      {!rows.length&&<BusinessEmpty compact title="조회 조건에 맞는 승인 요청이 없습니다."/>}</>}
    {batch&&<ExpenseBatchReview combined rows={batch.rows} decision={batch.decision} onClose={()=>setBatch(null)} onDone={finish} onInterrupted={refresh}/>}
  </section>;
}
