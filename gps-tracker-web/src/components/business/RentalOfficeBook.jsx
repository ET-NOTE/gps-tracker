import React,{useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {Button,Modal} from '../ui';
import {api} from '../../api';
import {Field,FormModal,Metrics,Options,Search,Table,Toolbar} from './RentalOfficeKit';
import {costKinds,entryKinds,kstDay,kstInput,matchOfficeCustomer,methods,outstandingReturns,readTime,recordLimit,suggestedRecordAmount,won} from '../../lib/rentalOffice';
import ExportButtons from './ExportButtons';
import {officeBookKey,officeCatalogKey} from './rentalOfficeKeys';
import Figures from './RentalOfficeFigures';
import {matchesVehicle} from '../../lib/rentalInventory';

const sum=(rows,fn)=>rows.reduce((n,row)=>n+fn(row),0);
const vehicle=d=>d.license_plate||d.display_name||('차량 '+d.id);
const label=c=>'#'+c.id+' · '+c.renter_name;
function availableEntryKind(contract,kind) {
  if (contract?.settlement_finalized && (kind==='payment'||kind==='refund')) return contract.held_krw>0?'deposit_out':'deposit_in';
  return kind;
}
export function LedgerEditor({book,initial,close}) {
  const qc=useQueryClient(),requestedKind=initial.kind||'payment';
  const c0=initial.contract||book.contracts.find(c=>recordLimit(c,requestedKind)>0)||book.contracts[0];
  const kind0=availableEntryKind(c0,requestedKind);
  const [id,setId]=useState(c0?.id),[kind,setKind]=useState(kind0),[method,setMethod]=useState('card');
  const [amount,setAmount]=useState(suggestedRecordAmount(c0,kind0)),[at,setAt]=useState(()=>kstInput()),[memo,setMemo]=useState('');
  const [key]=useState(()=>crypto.randomUUID());
  const c=book.contracts.find(c=>c.id===Number(id)),max=recordLimit(c,kind);
  async function save(){
    await api.rentalOffice('POST','/ledger',{contract_id:c.id,kind,method,amount_krw:Number(amount),recorded_at:new Date(at+':00+09:00').toISOString(),memo,request_key:key});
    await Promise.all([qc.invalidateQueries({queryKey:officeBookKey()}),qc.invalidateQueries({queryKey:officeCatalogKey(true)})]);
  }
  return <FormModal title="결제 기록" onClose={close} save={save} canSave={!!c&&max>0&&Number(amount)>0&&Number(amount)<=max}>
    <Field label="예약·계약" wide><select value={id??''} required onChange={e=>{const next=book.contracts.find(r=>r.id===Number(e.target.value));const nextKind=availableEntryKind(next,kind);setId(next?.id);setKind(nextKind);setAmount(suggestedRecordAmount(next,nextKind));}}>
      {!c0&&<option value="">선택 가능한 계약 없음</option>}{book.contracts.map(r=><option key={r.id} value={r.id}>{label(r)}</option>)}</select></Field>
    <Field label="기록 구분"><select value={kind} onChange={e=>{setKind(e.target.value);setAmount(suggestedRecordAmount(c,e.target.value));}}>{Object.entries(entryKinds).map(([value,name])=><option key={value} value={value} disabled={availableEntryKind(c,value)!==value}>{name}</option>)}</select></Field>
    <Field label="거래 수단"><select value={method} onChange={e=>setMethod(e.target.value)}><Options items={methods}/></select></Field>
    <Field label="금액 (원)"><input type="number" required min="1" max={Math.min(max,1000000000)} step="1" value={amount} onChange={e=>setAmount(e.target.value)}/><small>기록 가능 금액 {won(max)}</small></Field>
    <Field label="거래 일시 (한국시간)"><input type="datetime-local" required value={at} onChange={e=>setAt(e.target.value)}/></Field>
    <Field label={kind==='refund'?'환불 사유':'메모'} wide><textarea rows="3" required={kind==='refund'} value={memo} onChange={e=>setMemo(e.target.value)} maxLength={500}/></Field>
    <p className="ro-note ro-wide">실제 거래가 끝난 금액을 장부에 기록합니다.</p>
  </FormModal>;
}
function CostEditor({devices,row,close}) {
  const qc=useQueryClient(),[key]=useState(()=>crypto.randomUUID());
  const [form,setForm]=useState(()=>({vehicle_id:row ? devices.find(v=>matchesVehicle(row,v))?.id ?? '' : devices[0]?.id??'',occurred_on:kstDay(),category:'wash',amount_krw:'',
    vendor:'',memo:'',...row}));
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  async function save(){
    await api.rentalOffice(row?'PATCH':'POST','/costs'+(row?'/'+row.id:''),{...form,
      vehicle_id:Number(form.vehicle_id),device_id:devices.find(v=>String(v.id)===String(form.vehicle_id))?.device_id ?? null,amount_krw:Number(form.amount_krw),request_key:key});
    await qc.invalidateQueries({queryKey:officeBookKey()});
  }
  return <FormModal title={'차량 운영비 '+(row?'수정':'등록')} save={save} onClose={close} canSave={!!form.vehicle_id&&Number(form.amount_krw)>0}>
    <Field label="차량"><select value={form.vehicle_id||''} required onChange={e=>set('vehicle_id',e.target.value)}>
      <option value="">차량 선택</option>{devices.map(d=><option key={d.id} value={d.id}>{vehicle(d)}</option>)}</select></Field>
    <Field label="지출일"><input type="date" required value={form.occurred_on} onChange={e=>set('occurred_on',e.target.value)}/></Field>
    <Field label="비용 구분"><select value={form.category} onChange={e=>set('category',e.target.value)}><Options items={costKinds}/></select></Field>
    <Field label="금액 (원)"><input type="number" required min="1" max="1000000000" step="1" value={form.amount_krw} onChange={e=>set('amount_krw',e.target.value)}/></Field>
    <Field label="거래처" wide><input value={form.vendor} onChange={e=>set('vendor',e.target.value)} maxLength={80}/></Field>
    <Field label="메모" wide><textarea rows="3" value={form.memo} onChange={e=>set('memo',e.target.value)} maxLength={500}/></Field>
  </FormModal>;
}
const entryCols=[['거래 일시',e=>readTime(e.recorded_at)],['예약·계약',e=>'#'+e.contract_id+' · '+e.renter_name],['구분',e=>entryKinds[e.kind]],
  ['수단',e=>methods[e.method]],['금액',e=><strong>{won(e.amount_krw)}</strong>],['메모',e=>e.memo||'—']];
export default function RentalOfficeBook({kind,book,catalog,devices,period,dates,pending,onResetPeriod}) {
  const [query,setQuery]=useState(''),[filter,setFilter]=useState('all'),[device,setDevice]=useState('all'),[account,setAccount]=useState('all'),[branch,setBranch]=useState('');
  const [editing,setEditing]=useState(undefined),[detail,setDetail]=useState(null),[costDetail,setCostDetail]=useState(null);
  const [method,setMethod]=useState('all');
  const matches=(...values)=>values.some(v=>String(v??'').toLowerCase().includes(query.trim().toLowerCase()));
  if (kind==='reports'||kind==='utilization') return <Figures book={book} devices={devices} period={period} dates={dates} onResetPeriod={onResetPeriod} pending={pending} usage={kind==='utilization'}/>;
  const isCost=kind==='costs',isPayments=kind==='payments',isRefunds=kind==='refunds';
  const balance=c=>c.billed_krw-c.paid_krw;
  const contracts=book.contracts.filter(c=>matches(c.id,c.renter_name,c.renter_phone,c.vehicle_name)&&
    (!branch||c.pickup_location===branch)&&
    (account==='all'||String(matchOfficeCustomer(c,catalog)?.account_id??'')===account) &&
    (filter==='all'||(filter==='pending'?balance(c)>0:filter==='excess'?balance(c)<0:balance(c)<=0)));
  const entries=book.entries.filter(e=>(isPayments||e.kind!=='payment')&&matches(e.contract_id,e.renter_name,e.memo)&&
    (isPayments || filter==='all'||e.kind===filter) && (!isRefunds || method==='all'||e.method===method));
  const returns=isRefunds?outstandingReturns(book.contracts.filter(c=>matches(c.id,c.renter_name))):[];
  const costs=book.costs.filter(c=>(filter==='all'||c.category===filter)&&(device==='all'||matchesVehicle(c,devices.find(v=>String(v.id)===device)))&&
    (!branch||devices.some(v=>v.branch===branch&&matchesVehicle(c,v)))&&matches(c.vehicle_name,c.vendor,c.memo));
  const cols=isCost?[['지출일',k=>k.occurred_on],['차량',k=><button type="button" className="ro-contract-link" onClick={()=>setCostDetail(k)}><strong>{k.vehicle_name||'차량 상세'}</strong></button>],
    ['항목',k=>costKinds[k.category]],['거래처 / 사용처',k=>k.vendor||'—'],['금액',k=>won(k.amount_krw)]]
    :isPayments?[['계약 / 고객',c=><button type="button" className="ro-contract-link" onClick={()=>setDetail(c)}><strong>#{c.id}</strong><span>{c.renter_name} · {c.vehicle_name||'차량 미배정'}</span></button>],
      ['대여 기간',c=><>{kstDay(c.starts_at)}<span className="ro-secondary">~ {kstDay(c.ends_at)}</span></>],['청구액',c=>won(c.billed_krw)],['순수납액',c=>won(c.paid_krw)],
      ['미수금',c=>won(Math.max(0,balance(c)))],['보유 보증금',c=>won(c.held_krw)],['수납 상태',c=><span className={'ro-status'+(balance(c)>0?' amber':'')}>{balance(c)<0?'초과 수납':balance(c)>0?(c.paid_krw?'부분 수납':'수납 전'):'미수금 없음'}</span>]]:entryCols;
  const rows=isCost?costs:isPayments?contracts:entries;
  const csvTitle=isCost?'차량 운영비':isPayments?'청구·수납':'환불·보증금';
  const csvLabels=isCost?['지출일','차량','비용 구분','거래처','금액(원)','메모']:isPayments?
    ['계약번호','고객','차량','대여 시작 (한국시간)','반납 예정 (한국시간)','약정·정산액(원)','순수납(원)','미수금(원)','보유 보증금(원)']:
    ['거래 일시 (한국시간)','계약번호','고객','기록 구분','결제 수단','금액(원)','메모'];
  const csvRows=isCost?costs.map(c=>[c.occurred_on,c.vehicle_name,costKinds[c.category],c.vendor,c.amount_krw,c.memo]):isPayments?
    contracts.map(c=>[c.id,c.renter_name,c.vehicle_name,readTime(c.starts_at),readTime(c.ends_at),c.billed_krw,c.paid_krw,Math.max(0,balance(c)),c.held_krw]):
    entries.map(e=>[readTime(e.recorded_at),e.contract_id,e.renter_name,entryKinds[e.kind],methods[e.method],e.amount_krw,e.memo]);
  const liveDetail=detail&&book.contracts.find(c=>c.id===detail.id);
  const actions=<>
    <ExportButtons csvOnly disabled={pending} report={{title:csvTitle,filename:csvTitle+'_'+period.from+'_'+period.to,columns:csvLabels.map((label,key)=>({key,label})),rows:csvRows}}/>
    <Button disabled={pending||(isCost?!devices.length:!book.contracts.length)} onClick={()=>setEditing(isCost?null:{kind:isPayments?'payment':'refund'})}>{isCost?'운영비 등록':isRefunds?'환불·반환 기록':'결제 기록'}</Button>
  </>;
  return <>
    <div className="ro-filters ro-finance-filters">{dates}
      {isCost&&<Field label="차량"><select value={device} onChange={e=>setDevice(e.target.value)}><option value="all">전체 차량</option>{devices.map(d=><option key={d.id} value={d.id}>{vehicle(d)}</option>)}</select></Field>}
      {isCost&&<Field label="차량 지점"><select value={branch} onChange={e=>setBranch(e.target.value)}><option value="">전체 지점</option>{[...new Set(devices.map(v=>v.branch).filter(Boolean))].sort().map(b=><option key={b}>{b}</option>)}</select></Field>}
      <Field label={isPayments?'수납 상태':isCost?'지출 항목':'기록 구분'}><select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">전체</option>
        <Options items={isPayments?{pending:'미수금 있음',paid:'미수금 없음',excess:'초과 수납'}:isCost?costKinds:{refund:entryKinds.refund,deposit_in:entryKinds.deposit_in,deposit_out:entryKinds.deposit_out}}/></select></Field>
      {isRefunds&&<Field label="거래 수단"><select value={method} onChange={e=>setMethod(e.target.value)}><option value="all">전체 수단</option><Options items={methods}/></select></Field>}
      {isPayments&&<Field label="거래처"><select value={account} onChange={e=>setAccount(e.target.value)}><option value="all">전체 거래처</option><option value="">미연결</option>{catalog.accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>}
      {isPayments&&<Field label="대여 지점"><select value={branch} onChange={e=>setBranch(e.target.value)}><option value="">전체 지점</option>{[...new Set(book.contracts.map(c=>c.pickup_location).filter(Boolean))].sort().map(b=><option key={b}>{b}</option>)}</select></Field>}
      <Search value={query} setValue={setQuery} label={isCost?'차량·거래처·메모 검색':isRefunds?'계약번호·고객·메모 검색':'계약번호·고객·차량 검색'}/>
      <Button variant="ghost" onClick={()=>{setQuery('');setFilter('all');setDevice('all');setAccount('all');setBranch('');setMethod('all');onResetPeriod();}}>초기화</Button>
    </div>
    <Metrics items={isCost?[['조회 운영비',won(sum(costs,c=>c.amount_krw))],['지출 기록',costs.length+'건'],['관련 차량',new Set(costs.map(c=>c.vehicle_id!=null?'vehicle:'+c.vehicle_id:c.device_id!=null?'device:'+c.device_id:c.vehicle_name).filter(Boolean)).size+'대']]:
      isPayments?[['약정·정산액',won(sum(contracts,c=>c.billed_krw))],['순수납',won(sum(contracts,c=>c.paid_krw))],['미수금',won(sum(contracts,c=>Math.max(0,balance(c))))],['보증금 잔액',won(sum(contracts,c=>c.held_krw))]]:
      [['기간 이용료 환불',won(sum(entries.filter(e=>e.kind==='refund'),e=>e.amount_krw))],['기간 보증금 수납',won(sum(entries.filter(e=>e.kind==='deposit_in'),e=>e.amount_krw))],['기간 보증금 반환',won(sum(entries.filter(e=>e.kind==='deposit_out'),e=>e.amount_krw))],['처리 대기',returns.length+'건']]}/>
    {isRefunds&&<>
      <div className="ro-refund-actions"><span>보증금은 이용료 수납액과 별도로 집계합니다.</span><div>{actions}</div></div>
      <section className="ro-panel"><header className="ro-section-heading"><div><h2>현재 환불·반환 대기</h2><p>조회 기간에 포함된 계약의 현재 잔액입니다.</p></div><span>{returns.length}건</span></header>
        <Table rows={returns} columns={[
          ['계약 / 고객',r=><button type="button" className="ro-contract-link" onClick={()=>setDetail(r.contract)}><strong>#{r.id}</strong><span>{r.contract.renter_name}</span></button>],
          ['계약 상태',r=>r.contract.cancel_outcome==='no_show'?'미방문':r.contract.settlement_finalized?'정산 완료':({draft:'예약 접수',active:'대여 중',overdue:'반납 지연',returned:'반납 완료',cancelled:'취소'})[r.contract.status]||'—'],
          ['이용료 초과수납',r=>won(r.excess)],['반환 대상 보증금',r=>won(r.deposit)]
        ]} empty="환불·반환 대기 항목이 없습니다."/>
      </section></>}
    <section className="ro-panel">{isRefunds?<header className="ro-section-heading"><h2>거래 기록</h2><span>{rows.length}건</span></header>:<Toolbar count={rows.length}>{actions}</Toolbar>}
      <Table columns={cols} rows={rows} empty={isCost?'조회 기간에 등록된 운영비가 없습니다.':isPayments?'조회 기간에 해당하는 계약이 없습니다.':'조회 기간에 환불·보증금 기록이 없습니다.'}/></section>
    {costDetail&&<Modal open title="운영비 상세" onClose={()=>setCostDetail(null)}><div className="rental-office"><dl className="ro-cost-details">
      {[['차량',costDetail.vehicle_name],['지출일',costDetail.occurred_on],['항목',costKinds[costDetail.category]],['금액',won(costDetail.amount_krw)],['거래처 / 사용처',costDetail.vendor],['메모',costDetail.memo]].map(([name,value])=><div key={name}><dt>{name}</dt><dd>{value||'—'}</dd></div>)}</dl>
      <div className="ro-actions"><Button onClick={()=>{setEditing(costDetail);setCostDetail(null);}}>운영비 수정</Button></div></div></Modal>}
    {liveDetail&&<Modal open size="xl" title={label(liveDetail)} subtitle="결제 상세" onClose={()=>setDetail(null)}>
      <div className="rental-office"><Metrics items={[['약정·정산액',won(liveDetail.billed_krw)],['순수납',won(liveDetail.paid_krw)],['보증금 잔액',won(liveDetail.held_krw)]]}/>
        <h3>조회 기간의 거래</h3><Table columns={entryCols} rows={book.entries.filter(e=>e.contract_id===liveDetail.id)} empty="조회 기간에 기록된 거래가 없습니다."/>
        <div className="ro-actions"><Button onClick={()=>{setDetail(null);setEditing({contract:liveDetail,kind:isRefunds?(liveDetail.paid_krw>liveDetail.billed_krw?'refund':'deposit_out'):'payment'});}}>결제 기록</Button></div></div></Modal>}
    {editing!==undefined&&(isCost?<CostEditor devices={devices} row={editing} close={()=>setEditing(undefined)}/>:<LedgerEditor initial={editing} book={book} close={()=>setEditing(undefined)}/>)}
  </>;
}
