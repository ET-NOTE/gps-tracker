import React,{useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {Button,Modal} from '../ui';
import {api} from '../../api';
import {Field,FormModal,Metrics,Options,Search,Table,Toolbar} from './RentalOfficeKit';
import {costKinds,dailyFigures,entryKinds,kstDay,kstInput,matchOfficeCustomer,methods,readTime,recordLimit,vehicleUsage,won} from '../../lib/rentalOffice';
import ExportButtons from './ExportButtons';
import {officeBookKey,officeCatalogKey} from './rentalOfficeKeys';
import RentalOfficeCharts from './RentalOfficeCharts';
import {useRentalProfiles} from './RentalFleetProfiles';

const sum=(rows,fn)=>rows.reduce((n,row)=>n+fn(row),0);
const vehicle=d=>d.license_plate||d.display_name||('차량 '+d.id);
const label=c=>'#'+c.id+' · '+c.renter_name;
function LedgerEditor({book,initial,close}) {
  const qc=useQueryClient(),kind0=initial.kind||'payment';
  const c0=initial.contract||book.contracts.find(c=>recordLimit(c,kind0)>0)||book.contracts[0];
  const [id,setId]=useState(c0?.id),[kind,setKind]=useState(kind0),[method,setMethod]=useState('card');
  const [amount,setAmount]=useState(recordLimit(c0,kind0)),[at,setAt]=useState(()=>kstInput()),[memo,setMemo]=useState('');
  const [key]=useState(()=>crypto.randomUUID());
  const c=book.contracts.find(c=>c.id===Number(id)),max=recordLimit(c,kind);
  async function save(){
    await api.rentalOffice('POST','/ledger',{contract_id:c.id,kind,method,amount_krw:Number(amount),recorded_at:new Date(at+':00+09:00').toISOString(),memo,request_key:key});
    await Promise.all([qc.invalidateQueries({queryKey:officeBookKey()}),qc.invalidateQueries({queryKey:officeCatalogKey(true)})]);
  }
  return <FormModal title="결제 기록" onClose={close} save={save} canSave={!!c&&max>0&&Number(amount)>0&&Number(amount)<=max}>
    <Field label="예약·계약" wide><select value={id??''} required onChange={e=>{const next=book.contracts.find(r=>r.id===Number(e.target.value));setId(next?.id);setAmount(recordLimit(next,kind));}}>
      {!c0&&<option value="">선택 가능한 계약 없음</option>}{book.contracts.map(r=><option key={r.id} value={r.id}>{label(r)}</option>)}</select></Field>
    <Field label="기록 구분"><select value={kind} onChange={e=>{setKind(e.target.value);setAmount(recordLimit(c,e.target.value));}}><Options items={entryKinds}/></select></Field>
    <Field label="거래 수단"><select value={method} onChange={e=>setMethod(e.target.value)}><Options items={methods}/></select></Field>
    <Field label="금액 (원)"><input type="number" required min="1" max={Math.min(max,1000000000)} step="1" value={amount} onChange={e=>setAmount(e.target.value)}/><small>기록 가능 금액 {won(max)}</small></Field>
    <Field label="거래 일시 (한국시간)"><input type="datetime-local" required value={at} onChange={e=>setAt(e.target.value)}/></Field>
    <Field label={kind==='refund'?'환불 사유':'메모'} wide><textarea rows="3" required={kind==='refund'} value={memo} onChange={e=>setMemo(e.target.value)} maxLength={500}/></Field>
    <p className="ro-note ro-wide">실제 거래가 끝난 금액을 장부에 기록합니다.</p>
  </FormModal>;
}
function CostEditor({devices,row,close}) {
  const qc=useQueryClient(),[key]=useState(()=>crypto.randomUUID());
  const [form,setForm]=useState(()=>({device_id:devices[0]?.id??'',occurred_on:kstDay(),category:'wash',amount_krw:'',
    vendor:'',memo:'',...row}));
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  async function save(){
    await api.rentalOffice(row?'PATCH':'POST','/costs'+(row?'/'+row.id:''),{...form,
      device_id:Number(form.device_id),amount_krw:Number(form.amount_krw),request_key:key});
    await qc.invalidateQueries({queryKey:officeBookKey()});
  }
  return <FormModal title={'차량 운영비 '+(row?'수정':'등록')} save={save} onClose={close} canSave={!!form.device_id&&Number(form.amount_krw)>0}>
    <Field label="차량"><select value={form.device_id||''} required onChange={e=>set('device_id',e.target.value)}>
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
function Figures({book:all,devices:allVehicles,period,dates,pending,usage}){
  const [branch,setBranch]=useState(''),[model,setModel]=useState('');
  const profiles=useRentalProfiles();
  const profileById=new Map((profiles.data||[]).map(p=>[p.device_id,p]));
  const vehicleById=new Map(allVehicles.map(d=>[d.id,d]));
  const modelOf=c=>c.requested_model||profileById.get(c.device_id)?.class_name||vehicleById.get(c.device_id)?.car_model||'차종 미지정';
  const branchOf=c=>c.pickup_location||profileById.get(c.device_id)?.branch||'';
  const matches=c=>(!branch||branch===branchOf(c))&&(!model||model===modelOf(c));
  const contractRows=all.contracts.filter(matches), ids=new Set(contractRows.map(c=>c.id));
  const devices=allVehicles.filter(d=>matches({device_id:d.id}));
  const book={contracts:contractRows,costs:all.costs.filter(matches),entries:all.entries.filter(e=>ids.has(e.contract_id))};
  const source=[...all.contracts,...allVehicles.map(d=>({device_id:d.id}))];
  const branches=[...new Set(source.map(branchOf).filter(Boolean))].sort(),models=[...new Set(source.map(modelOf))].sort();
  const start=Date.parse(period.from+'T00:00:00+09:00'),end=Date.parse(period.to+'T00:00:00+09:00')+86400000;
  const periodContracts=contractRows.filter(c=>c.status!=='cancelled'&&Date.parse(c.starts_at)<end&&Date.parse(c.ends_at)>start);
  let metrics,cols,rows,reportRows;
  if (usage){
    rows=vehicleUsage(book,devices,period);
    metrics=[['조회 차량',rows.length+'대'],['대여 시간',sum(rows,r=>r.hours).toLocaleString('ko-KR',{maximumFractionDigits:1})+'시간'],['차량 운영비',won(sum(rows,r=>r.cost))]];
    cols=[['차량',r=>r.name],['대여 시간',r=>r.hours.toLocaleString('ko-KR',{maximumFractionDigits:1})+'시간'],['가동률',r=>r.utilization.toFixed(1)+'%'],['이용료 순수납',r=>won(r.revenue)],['운영비',r=>won(r.cost)]];
    reportRows=rows.map(r=>[r.name,r.hours.toFixed(1),r.utilization.toFixed(1)+'%',r.revenue,r.cost]);
  } else {
    rows=dailyFigures(book);
    const pay=sum(rows,r=>r.payment),refund=sum(rows,r=>r.refund),cost=sum(rows,r=>r.cost);
    metrics=[['대여 계약',periodContracts.length+'건'],['이용료 순수납',won(pay-refund)],['환불',won(refund)],['운영비',won(cost)]];
    cols=[['날짜',r=>r.id],['이용료 수납',r=>won(r.payment)],['이용료 환불',r=>won(r.refund)],['운영비',r=>won(r.cost)],['수납 차액',r=>won(r.payment-r.refund-r.cost)]];
    reportRows=rows.map(r=>[r.id,r.payment,r.refund,r.cost,r.payment-r.refund-r.cost]);
  }
  const title=usage?'차량 가동·운영비':'대여·매출 통계';
  return <><div className="ro-filters">{dates}<Field label="소속 지점"><select value={branch} onChange={e=>setBranch(e.target.value)}><option value="">전체 지점</option>{branches.map(b=><option key={b}>{b}</option>)}</select></Field>
    <Field label="차종"><select value={model} onChange={e=>setModel(e.target.value)}><option value="">전체 차종</option>{models.map(m=><option key={m}>{m}</option>)}</select></Field></div>
    {profiles.error&&<p role="alert" className="ro-error">차량의 소속 지점과 차종을 불러오지 못했습니다. <button type="button" onClick={()=>profiles.refetch()}>다시 조회</button></p>}
    <Metrics items={metrics}/>{!usage&&<RentalOfficeCharts figures={rows} contracts={periodContracts} period={period} modelOf={modelOf}/>}
    <section className="ro-panel"><Toolbar count={rows.length} unit={usage?'대':'일'}><ExportButtons csvOnly disabled={pending} report={{title,filename:title+'_'+period.from+'_'+period.to,columns:cols.map(([label],key)=>({key,label})),rows:reportRows}}/></Toolbar>
    <Table columns={cols} rows={rows} empty="조회 기간에 집계할 내역이 없습니다."/></section></>;
}
export default function RentalOfficeBook({kind,book,catalog,devices,period,dates,pending}) {
  const [query,setQuery]=useState(''),[filter,setFilter]=useState('all'),[device,setDevice]=useState('all'),[account,setAccount]=useState('all'),[branch,setBranch]=useState('');
  const [editing,setEditing]=useState(undefined),[detail,setDetail]=useState(null);
  const matches=(...values)=>values.some(v=>String(v??'').toLowerCase().includes(query.trim().toLowerCase()));
  if (kind==='reports'||kind==='utilization') return <Figures book={book} devices={devices} period={period} dates={dates} pending={pending} usage={kind==='utilization'}/>;
  const isCost=kind==='costs',isPayments=kind==='payments';
  const balance=c=>c.billed_krw-c.paid_krw;
  const contracts=book.contracts.filter(c=>matches(c.id,c.renter_name,c.renter_phone,c.vehicle_name)&&
    (!branch||c.pickup_location===branch)&&
    (account==='all'||String(matchOfficeCustomer(c,catalog)?.account_id??'')===account) &&
    (filter==='all'||(filter==='pending'?balance(c)>0:filter==='excess'?balance(c)<0:balance(c)===0)));
  const entries=book.entries.filter(e=>(isPayments||e.kind!=='payment')&&matches(e.contract_id,e.renter_name,e.memo)&&
    (isPayments || filter==='all'||e.kind===filter));
  const costs=book.costs.filter(c=>(filter==='all'||c.category===filter)&&(device==='all'||String(c.device_id)===device)&&matches(c.vehicle_name,c.vendor,c.memo));
  const cols=isCost?[['지출일',k=>k.occurred_on],['차량',k=><strong>{k.vehicle_name}</strong>],['구분',k=>costKinds[k.category]],['거래처',k=>k.vendor||'—'],['금액',k=>won(k.amount_krw)],['메모',k=>k.memo||'—'],['관리',k=><Button size="sm" variant="ghost" onClick={()=>setEditing(k)}>수정</Button>]]
    :isPayments?[['예약·계약',c=><strong>{label(c)}</strong>],['차량',c=>c.vehicle_name||'차량 미배정'],['약정·정산액',c=>won(c.billed_krw)],['순수납',c=>won(c.paid_krw)],
      ['미수금',c=>won(Math.max(0,balance(c)))],['보증금 잔액',c=>won(c.held_krw)],['관리',c=><Button size="sm" variant="ghost" onClick={()=>setDetail(c)}>상세</Button>]]:entryCols;
  const rows=isCost?costs:isPayments?contracts:entries;
  const csvTitle=isCost?'차량 운영비':isPayments?'청구·수납':'환불·보증금';
  const csvLabels=isCost?['지출일','차량','비용 구분','거래처','금액(원)','메모']:isPayments?
    ['계약번호','고객','차량','대여 시작 (한국시간)','반납 예정 (한국시간)','약정·정산액(원)','순수납(원)','미수금(원)','보유 보증금(원)']:
    ['거래 일시 (한국시간)','계약번호','고객','기록 구분','결제 수단','금액(원)','메모'];
  const csvRows=isCost?costs.map(c=>[c.occurred_on,c.vehicle_name,costKinds[c.category],c.vendor,c.amount_krw,c.memo]):isPayments?
    contracts.map(c=>[c.id,c.renter_name,c.vehicle_name,readTime(c.starts_at),readTime(c.ends_at),c.billed_krw,c.paid_krw,Math.max(0,balance(c)),c.held_krw]):
    entries.map(e=>[readTime(e.recorded_at),e.contract_id,e.renter_name,entryKinds[e.kind],methods[e.method],e.amount_krw,e.memo]);
  const liveDetail=detail&&book.contracts.find(c=>c.id===detail.id);
  return <>
    <div className="ro-filters ro-finance-filters">{dates}<Search value={query} setValue={setQuery} label={isCost?'차량·거래처·메모 검색':'계약번호·고객 검색'}/>
      <Field label={isPayments?'수납 상태':'구분'}><select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">전체</option>
        <Options items={isPayments?{pending:'미수금 있음',paid:'정산 완료',excess:'초과 수납'}:isCost?costKinds:{refund:entryKinds.refund,deposit_in:entryKinds.deposit_in,deposit_out:entryKinds.deposit_out}}/></select></Field>
      {isCost&&<Field label="차량"><select value={device} onChange={e=>setDevice(e.target.value)}><option value="all">전체 차량</option>{devices.map(d=><option key={d.id} value={d.id}>{vehicle(d)}</option>)}</select></Field>}
      {isPayments&&<Field label="거래처"><select value={account} onChange={e=>setAccount(e.target.value)}><option value="all">전체 거래처</option><option value="">미연결</option>{catalog.accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>}
      {isPayments&&<Field label="대여 지점"><select value={branch} onChange={e=>setBranch(e.target.value)}><option value="">전체 지점</option>{[...new Set(book.contracts.map(c=>c.pickup_location).filter(Boolean))].sort().map(b=><option key={b}>{b}</option>)}</select></Field>}
    </div>
    <Metrics items={isCost?[['운영비 합계',won(sum(costs,c=>c.amount_krw))],['지출 건수',costs.length+'건']]:
      isPayments?[['약정·정산액',won(sum(contracts,c=>c.billed_krw))],['순수납',won(sum(contracts,c=>c.paid_krw))],['미수금',won(sum(contracts,c=>Math.max(0,balance(c))))],['보증금 잔액',won(sum(contracts,c=>c.held_krw))]]:
      [['이용료 환불',won(sum(entries.filter(e=>e.kind==='refund'),e=>e.amount_krw))],['보증금 수납',won(sum(entries.filter(e=>e.kind==='deposit_in'),e=>e.amount_krw))],['보증금 반환',won(sum(entries.filter(e=>e.kind==='deposit_out'),e=>e.amount_krw))]]}/>
    <section className="ro-panel"><Toolbar count={rows.length}>
      <ExportButtons csvOnly disabled={pending} report={{title:csvTitle,filename:csvTitle+'_'+period.from+'_'+period.to,columns:csvLabels.map((label,key)=>({key,label})),rows:csvRows}}/>
      <Button disabled={pending||(isCost?!devices.length:!book.contracts.length)} onClick={()=>setEditing(isCost?null:{kind:isPayments?'payment':'refund'})}>{isCost?'운영비 등록':'결제 기록'}</Button></Toolbar>
      <Table columns={cols} rows={rows} empty={isCost?'조회 기간에 등록된 운영비가 없습니다.':isPayments?'조회 기간에 해당하는 계약이 없습니다.':'조회 기간에 환불·보증금 기록이 없습니다.'}/></section>
    {liveDetail&&<Modal open size="xl" title={label(liveDetail)} subtitle="결제 상세" onClose={()=>setDetail(null)}>
      <div className="rental-office"><Metrics items={[['약정·정산액',won(liveDetail.billed_krw)],['순수납',won(liveDetail.paid_krw)],['보증금 잔액',won(liveDetail.held_krw)]]}/>
        <h3>조회 기간의 거래</h3><Table columns={entryCols} rows={book.entries.filter(e=>e.contract_id===liveDetail.id)} empty="조회 기간에 기록된 거래가 없습니다."/>
        <div className="ro-actions"><Button onClick={()=>{setDetail(null);setEditing({contract:liveDetail});}}>결제 기록</Button></div></div></Modal>}
    {editing!==undefined&&(isCost?<CostEditor devices={devices} row={editing} close={()=>setEditing(undefined)}/>:<LedgerEditor initial={editing} book={book} close={()=>setEditing(undefined)}/>)}
  </>;
}
