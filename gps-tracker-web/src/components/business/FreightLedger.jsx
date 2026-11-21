import { useMemo, useState } from 'react';
import { FreightDrawer } from './FreightKit';
import { FreightBadge, FreightButton, FreightFacts, FreightField, FreightFilters, FreightForm, FreightStats, FreightTable } from './FreightKit';
import { choices, choicesFrom, downloadRows, FormField, OfficeFilter } from './FreightOfficeFields';
import { costLabel, getRow, inputTime, nameOf, shipStates, stamp, timeLabel, vehicleName } from '../../lib/freightWorkflow';
import { addPayment, confirmFinance, paymentLimit, paymentMethods, paymentNames, setAgreement, shipmentFinance } from '../../lib/freightFinance';

export function PeriodFilter({period,setPeriod}) {
  return <>{[['from','조회 시작일'],['to','조회 종료일']].map(([key,label])=><FreightField key={key} label={label}>
    <input type="date" value={period[key]} min={key==='to'?period.from:undefined} max={key==='from'?period.to:undefined} onChange={e=>setPeriod({...period,[key]:e.target.value})}/>
  </FreightField>)}</>;
}
export const currentPeriod=()=>({from:stamp().slice(0,7)+'-01',to:stamp().slice(0,10)});
export function inPeriod(date,period) {
  const day=inputTime(date).slice(0,10);
  return (!period.from||day>=period.from)&&(!period.to||day<=period.to);
}
function describe(r,billing) {
  const {total,net,confirmed}=r;
  if (total==null)return ['운임 미정','amber'];
  if (net>total)return [billing?'환불 확인':'환수 확인','amber'];
  if (net===total)return [total===0?'잔액 없음':billing?'수납 완료':'지급 완료','green'];
  if (net>0)return [billing?'일부 수납':'일부 지급','amber'];
  if (confirmed)return [billing?'수납 대기':'지급 대기','blue'];
  return [billing?'청구 준비':'정산 준비','neutral'];
}
function financeRow(data,s,billing,fin) {
  const orders=(s.orderIds||[]).map(id=>getRow(data,'orders',id)).filter(Boolean);
  const parties=billing?Array.from(new Set(orders.map(o=>o.shipperId))):[s.carrierId||'own'];
  const party=billing?parties.map(id=>nameOf(data,'shippers',id)).join(', '):(s.carrierId?nameOf(data,'carriers',s.carrierId):'자사 운송');
  return {id:s.id,s,fin,party,parties,total:billing?fin.sell:fin.buy,net:billing?fin.received:fin.paid,balance:billing?fin.receivable:fin.payable,
    confirmed:billing?s.invoiceStatus==='issued':s.payableStatus==='confirmed'};
}
function matchesStatus(r,state) {
  switch(state){
    case 'unknown':return r.total==null;
    case 'draft':return !r.confirmed;
    case 'confirmed': return r.confirmed;
    case 'outstanding':return r.total!=null&&r.total>r.net;
    case 'settled':return r.total!=null&&r.total===r.net;
    case 'excess':return r.total!=null&&r.net>r.total;
    default:return true;
  }
}
function TransactionForm({r,billing,onClose,onSubmit,candidates,onSelect}) {
  const sideBase=billing?'receipt':'payout', [side,setSide]=useState(sideBase);
  const limit=paymentLimit(r.fin,side);
  const excess=r.total==null?0:Math.max(0,r.net-r.total);
  return <FreightForm title={billing?'수납·환불 기록':'지급·환수 기록'} subtitle={r.s.number} onClose={onClose} onSubmit={onSubmit} submitLabel="거래 기록">
    {candidates&&<FreightField label="운송 건" wide><select value={r.id} onChange={e=>onSelect(e.target.value)}>{candidates.map(item=><option key={item.id} value={item.id}>{item.s.number} · {item.party}</option>)}</select></FreightField>}
    <FreightField label="거래 구분"><select name="side" value={side} onChange={e=>setSide(e.target.value)}>
      {[sideBase,sideBase+'_refund'].map(v=><option value={v} key={v}>{paymentNames[v]}</option>)}</select></FreightField>
    <FormField field={{key:'method',label:'거래 방식',options:choices(paymentMethods),required:true}}/>
    <FormField key={side} field={{key:'amount',label:'거래 금액 (원)',type:'number',min:1,max:Math.min(limit??0,1e9),required:true,defaultValue:side.endsWith('refund')&&excess?excess:limit}}/>
    <FormField field={{key:'at',label:'거래 일시',type:'datetime-local',required:true,defaultValue:stamp()}}/>
    <FormField field={{key:'note',label:side.endsWith('refund')?'환불·환수 사유':'메모',type:'textarea',required:side.endsWith('refund'),maxLength:500}}/>
    <p className="fr-note">기록 가능 금액 {costLabel(limit)}</p>
  </FreightForm>;
}
export default function FreightLedger({kind,data,save,onPage}) {
  const billing=kind==='billing', partyLabel=billing?'화주':'지급 대상',totalLabel=billing?'청구액':'지급 대상액',netLabel=billing?'순수납액':'순지급액',balanceLabel=billing?'미수금':'미지급금';
  const [query,setQuery]=useState(''),[period,setPeriod]=useState(currentPeriod),[branch,setBranch]=useState(''),[party,setParty]=useState(''),[state,setState]=useState(''),[view,setView]=useState(null);
  const all=useMemo(()=>data.shipments.map(s=>financeRow(data,s,billing,shipmentFinance(data,s))),[data,billing]);
  const rows=all.filter(r=>inPeriod(r.s.start,period)&&(!branch||r.s.branchId===branch)&&(!party||r.parties.includes(party))&&matchesStatus(r,state)&&
    [r.s.number,r.party,vehicleName(data,r.s.vehicleId)].join(' ').toLowerCase().includes(query.trim().toLowerCase())).sort((a,b)=>String(b.s.start).localeCompare(String(a.s.start)));
  const sum=field=>costLabel(rows.reduce((a,r)=>a+(r[field]??0),0));
  const states={unknown:'운임 미정',draft:'확인 전',confirmed:'확인 완료',outstanding:billing?'미수 있음':'미지급 있음',settled:'잔액 없음',excess:billing?'환불 확인':'환수 확인'};
  const headings=['운송번호',partyLabel,'운송 예정 · 지점','운송 상태',totalLabel,netLabel,balanceLabel,'정산 상태'];
  function values(r) {return [r.s.number,r.party,timeLabel(r.s.start)+' · '+nameOf(data,'branches',r.s.branchId),shipStates[r.s.status],costLabel(r.total),costLabel(r.net),costLabel(r.balance),describe(r,billing)[0]];}
  const r=all.find(x=>x.id===view?.id);
  const toDetail=()=>setView({id:r.id,action:'detail'}),open=action=>setView({id:r.id,action}),close=()=>setView(null);
  async function submit(form) {
    const next=structuredClone(data), s=getRow(next,'shipments',r.id),values=Object.fromEntries(form);
    if (view.action==='agreement')setAgreement(next,s,values);
    if (view.action==='confirm')confirmFinance(next,s,billing,(values.note||'').trim());
    if (view.action==='payment')addPayment(next,s,values);
    await save(next);toDetail();
  }
  const receipts=r?.fin.receipts.filter(x=>x.side.startsWith(billing?'receipt':'payout')).sort((a,b)=>b.at.localeCompare(a.at));
  const awaitingProof=r&&billing&&r.s.status!=='cancelled'&&data.policies.requireProofForBilling&&r.s.proof?.status!=='approved';
  const canConfirm=r&&!r.confirmed&&r.total!=null&&(!billing||['cancelled','delivered'].includes(r.s.status))&&!awaitingProof;
  const eligible=rows.filter(item=>item.balance>0||item.net>0);
  return <section className="fr-section">
    <FreightStats items={[[totalLabel,sum('total')],[netLabel,sum('net')],[balanceLabel,sum('balance')],['운임 미정',rows.filter(r=>r.total==null).length+'건']]}/>
    <FreightFilters query={query} onQuery={setQuery} placeholder="운송번호·거래처·차량 검색"><PeriodFilter period={period} setPeriod={setPeriod}/>
      <OfficeFilter label="지점" options={choicesFrom(data.branches)} value={branch} onChange={setBranch}/>
      <OfficeFilter label={partyLabel} options={billing?choicesFrom(data.shippers):{own:'자사 운송',...choicesFrom(data.carriers)}} value={party} onChange={setParty}/>
      <OfficeFilter label="정산 상태" options={states} value={state} onChange={setState}/>
    </FreightFilters>
    <div className="fr-toolbar"><strong>운송 {rows.length}건</strong><div className="fr-actions">
      <FreightButton onClick={()=>{setPeriod(currentPeriod());setState('');setBranch('');setParty('');setQuery('');}}>조건 초기화</FreightButton>
      <FreightButton disabled={!rows.length} onClick={()=>downloadRows(billing?'화주 청구수납':'운송비 정산지급',headings,rows.map(values))}>CSV 다운로드</FreightButton>
      <FreightButton primary disabled={!eligible.length} onClick={()=>setView({id:eligible[0].id,action:'payment',fromList:true})}>{billing?'수납 기록':'지급 기록'}</FreightButton></div></div>
    <FreightTable columns={headings} rows={rows.map(r=>{const cells=values(r),[label,tone]=describe(r,billing);
      cells[0]=<button className="fr-link" onClick={()=>setView({id:r.id,action:'detail'})}>{r.s.number}</button>;
      cells[cells.length-1]=<FreightBadge tone={tone}>{label}</FreightBadge>; return {id:r.id,onOpen:()=>setView({id:r.id,action:'detail'}),cells};
    })} empty="조회 조건에 해당하는 운송 건이 없습니다."/>
    {r&&view.action==='detail'&&<FreightDrawer title="운송 정산 상세" subtitle={r.s.number+' · '+r.party} onClose={close} footer={<div className="fr-actions">
      <FreightButton onClick={close}>닫기</FreightButton><FreightButton onClick={()=>open('agreement')}>합의 운임</FreightButton>
      {!r.confirmed&&<FreightButton disabled={!canConfirm} onClick={()=>open('confirm')}>{billing?'청구 확인':'지급 대상 확인'}</FreightButton>}
      <FreightButton primary disabled={!(r.balance>0||r.net>0)} onClick={()=>open('payment')}>{billing?'수납·환불 기록':'지급·환수 기록'}</FreightButton></div>}>
      <section className="fr-section"><FreightFacts items={[[partyLabel,r.party],['운송 상태',shipStates[r.s.status]],['기본 합의액',costLabel(billing?r.s.sellAmount:r.s.buyAmount)],
        [totalLabel,costLabel(r.total)],[netLabel,costLabel(r.net)],[balanceLabel,costLabel(r.balance)],['초과 거래액',costLabel(r.total==null?null:Math.max(0,r.net-r.total))],
        ['회사 부담 추가 비용',costLabel(r.fin.cost)],['운송 손익',costLabel(r.fin.margin)],['확인 일시',timeLabel(billing?r.s.invoiceAt:r.s.payableAt)]]}/>
        {billing&&!r.confirmed&&!canConfirm&&<p className="fr-note">{r.total==null?'합의 운임을 입력해 주세요.':!['delivered','cancelled'].includes(r.s.status)?'하차 완료 후 청구를 확인할 수 있습니다.':'인수증 확인 후 청구할 수 있습니다.'}</p>}
        <section><h3>승인된 추가 비용</h3><FreightTable columns={['항목','반영액','발생 일시']} rows={r.fin.approved.map(x=>({id:x.id,cells:[x.kind,costLabel(billing?x.sellAmount:x.buyAmount),timeLabel(x.at)]}))} empty="승인된 추가 비용이 없습니다."/></section>
        <section><h3>거래 기록</h3><FreightTable columns={['거래 구분','금액','일시','방식','메모']} rows={receipts.map(p=>({id:p.id,cells:[paymentNames[p.side],costLabel(p.amount),timeLabel(p.at),p.method,p.note||'—']}))} empty="기록된 거래가 없습니다."/></section>
        <div className="fr-actions"><FreightButton onClick={()=>onPage('cargo-charges')}>추가 비용 관리</FreightButton></div>
      </section>
    </FreightDrawer>}
    {r&&view.action==='payment'&&<TransactionForm key={r.id} r={r} billing={billing} onClose={view.fromList?close:toDetail} onSubmit={submit}
      candidates={view.fromList?eligible:undefined} onSelect={id=>setView({id,action:'payment',fromList:true})}/>}
    {r&&view.action==='agreement'&&<FreightForm title="합의 운임 확인" subtitle={r.s.number} onClose={toDetail} onSubmit={submit}>
      <FormField field={{key:'sellAmount',label:'화주 합의 운임 (원)',type:'number',min:0,max:1e9,readOnly:r.s.invoiceStatus==='issued'||r.fin.received!==0}} initial={r.s}/>
      <FormField field={{key:'buyAmount',label:'운송사·자사 운송비 (원)',type:'number',min:0,max:1e9,readOnly:r.s.payableStatus==='confirmed'||r.fin.paid!==0}} initial={r.s}/>
      <FormField field={{key:'reason',label:'확인·변경 사유',type:'textarea',required:true,maxLength:500}}/>
    </FreightForm>}
    {r&&view.action==='confirm'&&<FreightForm title={billing?'청구 확인 기록':'지급 대상 확인 기록'} subtitle={r.s.number} onClose={toDetail} onSubmit={submit} submitLabel="확인 기록">
      <p className="fr-note">{r.party} · {totalLabel} {costLabel(r.total)}</p><FormField field={{key:'note',label:'확인 메모',type:'textarea',maxLength:500}}/>
    </FreightForm>}
  </section>;
}
