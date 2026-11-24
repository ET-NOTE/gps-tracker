import { useMemo, useState } from 'react';
import {Modal} from '../ui';
import FreightChargeDialogs,{tones as chargeTones} from './FreightChargeDialogs';
import { FreightDrawer } from './FreightKit';
import { FreightBadge, FreightButton, FreightFacts, FreightField, FreightFilters, FreightForm, FreightStats, FreightTable, Status } from './FreightKit';
import { choices, choicesFrom, downloadRows, FormField, OfficeFilter } from './FreightOfficeFields';
import { costLabel, getRow, inputTime, nameOf, shipStates, stamp, timeLabel, vehicleName } from '../../lib/freightWorkflow';
import { addPayment, chargeStates, confirmFinance, paymentLimit, paymentMethods, paymentNames, setAgreement, shipmentFinance } from '../../lib/freightFinance';
import useCorporatePhone from '../../useCorporatePhone';
import { hideOutsideMockup } from '../../lib/mockupHidden';

export function PeriodFilter({period,setPeriod,label}) {
  const inputs=[['from','조회 시작일'],['to','조회 종료일']].map(([key,name])=><input key={key} aria-label={name} type="date" value={period[key]} min={key==='to'?period.from:undefined} max={key==='from'?period.to:undefined} onChange={e=>setPeriod({...period,[key]:e.target.value})}/>);
  if(label)return <fieldset className="rental-stage-period"><legend>{label}</legend><div>{inputs[0]}<span>–</span>{inputs[1]}</div></fieldset>;
  return <>{inputs.map(input=><FreightField key={input.key} label={input.props['aria-label']}>{input}</FreightField>)}</>;
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
export function financeRow(data,s,billing,fin) {
  const orders=(s.orderIds||[]).map(id=>getRow(data,'orders',id)).filter(Boolean);
  const parties=billing?Array.from(new Set(orders.map(o=>o.shipperId))):[s.carrierId||'own'];
  const party=billing?parties.map(id=>nameOf(data,'shippers',id)).join(', '):(s.carrierId?nameOf(data,'carriers',s.carrierId):'자사 운송');
  const total=billing?fin.sell:fin.buy, net=billing?fin.received:fin.paid;
  return {id:s.id,s,fin,party,parties,total,net,excess:total==null?null:Math.max(0,net-total),balance:billing?fin.receivable:fin.payable,
    confirmed:billing?s.invoiceStatus==='issued':s.payableStatus==='confirmed'};
}
function matchesStatus(r,state) {
  switch(state){
    case 'unknown':return r.total==null;
    case 'draft':return !r.confirmed;
    case 'confirmed': return r.confirmed;
    case 'outstanding':return r.total!=null&&r.total>r.net;
    case 'settled':return r.total!=null&&r.total===r.net;
    case 'excess':return r.excess>0;
    default:return true;
  }
}
function TransactionForm({r,billing,initialSide,onClose,onSubmit,candidates,onSelect}) {
  const sideBase=billing?'receipt':'payout', [side,setSide]=useState(initialSide||sideBase);
  const limit=paymentLimit(r.fin,side);
  const excess=r.excess;
  return <FreightForm size={720} title={billing?'수납·환불 기록':'지급·환수 기록'} subtitle={r.s.number} onClose={onClose} onSubmit={onSubmit} submitLabel="거래 기록">
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
export default function FreightLedger({kind,data,save,onOpenShipment}) {
  const mockup=!useCorporatePhone()&&hideOutsideMockup;
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
  const eligible=rows.filter(item=>item.balance>0||item.net>0);
  const unknown=rows.filter(r=>r.total==null).length;
  return <section className="fr-section fr-ledger">
    <FreightStats items={[[billing?'조회 청구 대상액':'조회 지급 대상액',sum('total'),unknown?'운임 미정 '+unknown+'건 별도':'합의 운임과 승인 비용 기준','wallet'],[netLabel,sum('net')],[balanceLabel,sum('balance')],[billing?'환불 확인':'환수 확인',sum('excess')]]}/>
    <FreightFilters resetLabel={mockup?'초기화':undefined} query={query} onQuery={setQuery} placeholder={mockup?'운송번호, 거래처, 차량 검색':'운송번호·거래처·차량 검색'} onReset={()=>{setPeriod(currentPeriod());setState('');setBranch('');setParty('');setQuery('');}}><PeriodFilter label="운송 예정일" period={period} setPeriod={setPeriod}/>
      <OfficeFilter label="지점" options={choicesFrom(data.branches)} value={branch} onChange={setBranch}/>
      <OfficeFilter label={partyLabel} options={billing?choicesFrom(data.shippers):{own:'자사 운송',...choicesFrom(data.carriers)}} value={party} onChange={setParty}/>
      <OfficeFilter label="정산 상태" options={states} value={state} onChange={setState}/>
    </FreightFilters>
    <div className="fr-toolbar"><span className="fr-toolbar-caption">{mockup?'운임 합계는 미정 금액을 제외합니다. 실제 송금·발행은 실행되지 않습니다.':'조회 '+rows.length+'건 · 운임 합계는 미정 금액을 제외합니다. 수납·지급 내역을 기록합니다.'}</span><div className="fr-actions">
      <FreightButton icon="download" disabled={!rows.length} onClick={()=>downloadRows(billing?'화주 청구수납':'운송비 정산지급',headings,rows.map(values))}>CSV 다운로드</FreightButton>
      <FreightButton primary icon="plus" disabled={!eligible.length} onClick={()=>setView({id:eligible[0].id,action:'payment',fromList:true})}>{billing?'수납 기록':'지급 기록'}</FreightButton></div></div>
    <FreightTable deskEmpty='조회된 운송 정산이 없습니다.' columns={['운송 / '+partyLabel,'운송 예정 / 지점',...headings.slice(3)]} rows={rows.map(r=>{
      const [label,tone]=describe(r,billing);
      return {id:r.id,onOpen:()=>setView({id:r.id,action:'detail'}),cells:[
        <><button className="fr-link" onClick={()=>setView({id:r.id,action:'detail'})}>{r.s.number}</button><small>{r.party}</small></>,
        <>{timeLabel(r.s.start)}<small>{nameOf(data,'branches',r.s.branchId)}</small></>,
        <Status value={r.s.status} labels={shipStates}/>,costLabel(r.total),costLabel(r.net),costLabel(r.balance),<FreightBadge tone={tone}>{label}</FreightBadge>]};
    })} empty="조회 조건에 해당하는 운송 건이 없습니다."/>
    {r&&<FreightLedgerDialogs {...{billing,data,save,onOpenShipment,view,setView,eligible,r}}/>}
  </section>;
}

function FinanceSide({r,billing,requiresProof,onConfirm,onPayment}) {
  const {s,fin}=r;
  const [label,tone]=describe(r,billing);
  const side=billing?'receipt':'payout';
  const allowedStage=!billing||s.status==='delivered'||s.status==='cancelled';
  const awaitingProof=billing&&requiresProof&&s.status!=='cancelled'&&s.proof?.status!=='approved';
  const canConfirm=!r.confirmed&&r.total!=null&&allowedStage&&!awaitingProof;
  return <section className="fr-record-block fr-money-card">
    <h3>{billing?'화주 청구·수납':'운송비 정산·지급'}</h3>
    <FreightFacts items={[[billing?'화주':'지급 대상',r.party],
      [billing?'기본 합의 운임':'기본 합의 운송비',costLabel(billing?s.sellAmount:s.buyAmount)],
      [billing?'현재 청구액':'현재 지급 대상액',costLabel(r.total)],[billing?'순수납액':'순지급액',costLabel(r.net)],
      [billing?'미수금':'미지급금',costLabel(r.balance)],[billing?'초과수납액':'환수 확인 금액',costLabel(r.excess)],
      [billing?'청구 확인':'지급 대상 확인',r.confirmed?'확인 완료':'확인 전'],
      ...(r.confirmed?[['확인 일시',timeLabel(billing?s.invoiceAt:s.payableAt)]]:[]),
      [billing?'수납 상태':'지급 상태',<FreightBadge tone={tone}>{label}</FreightBadge>]]}/>
    <div className="fr-actions fr-finance-actions">
      <FreightButton icon="check" disabled={!canConfirm} onClick={onConfirm}>{billing?'청구 확인':'지급 대상 확인'}</FreightButton>
      <FreightButton primary={billing} disabled={!(paymentLimit(fin,side)>0)} onClick={()=>onPayment(side)}>{billing?'수납 기록':'지급 기록'}</FreightButton>
      <FreightButton disabled={!(paymentLimit(fin,side+'_refund')>0)} onClick={()=>onPayment(side+'_refund')}>{billing?'환불 기록':'환수 기록'}</FreightButton>
    </div>
    {billing&&!r.confirmed&&!canConfirm&&<p className="fr-record-note">{r.total==null?'합의 운임을 입력해 주세요.':!allowedStage?'하차 완료 후 청구를 확인할 수 있습니다.':'인수증 확인 후 청구할 수 있습니다.'}</p>}
  </section>;
}

export function ShipmentLedger({data,shipment,save,onOpenShipment,onClose}) {
  const [view,setView]=useState({id:shipment.id,action:'detail'});
  const r=financeRow(data,shipment,true,shipmentFinance(data,shipment));
  return <FreightLedgerDialogs billing {...{data,save,onOpenShipment,view,r}} setView={next=>next?setView(next):onClose()}/>;
}

export function FreightLedgerDialogs({billing,data,save,onOpenShipment,view,setView,eligible,r}) {
  const [chargeView,setChargeView]=useState(null),[paymentId,setPaymentId]=useState(null);
  const {s,fin}=r;
  const activeBilling=view.billing??billing;
  const sideRows=[financeRow(data,s,true,fin),financeRow(data,s,false,fin)];
  const activeRow=sideRows[activeBilling?0:1];
  const charges=data.charges.filter(x=>x.shipmentId===s.id);
  const payments=[...fin.receipts].sort((a,b)=>b.at.localeCompare(a.at));
  const payment=payments.find(x=>x.id===paymentId);
  const toDetail=()=>setView({id:r.id,action:'detail'}),close=()=>setView(null);
  function open(action,isBilling,side){setView({id:r.id,action,billing:isBilling,side});}
  async function submit(form) {
    const next=structuredClone(data), shipment=getRow(next,'shipments',r.id),values=Object.fromEntries(form);
    if (view.action==='agreement')setAgreement(next,shipment,values);
    if (view.action==='confirm')confirmFinance(next,shipment,activeBilling,(values.note||'').trim());
    if (view.action==='payment')addPayment(next,shipment,values);
    await save(next);toDetail();
  }
  const defaultSide=(billing?['receipt','receipt_refund','payout','payout_refund']:['payout','payout_refund','receipt','receipt_refund']).find(side=>paymentLimit(fin,side)>0);
  return <>
    {(!view.fromList||view.action==='detail')&&<FreightDrawer title="운임·정산 상세" subtitle={s.number} onClose={close} footer={<div className="fr-actions fr-finance-actions">
      <FreightButton icon="pencil" onClick={()=>open('agreement',billing)}>합의 운임</FreightButton>
      <FreightButton icon="plus" disabled={!data.codes.chargeTypes.length} onClick={()=>setChargeView({action:'form'})}>추가 비용</FreightButton>
      <FreightButton icon="wallet" primary disabled={!defaultSide} onClick={()=>open('payment',defaultSide.startsWith('receipt'),defaultSide)}>거래 기록</FreightButton></div>}>
      <div className="fr-record-heading fr-finance-actions"><Status value={s.status} labels={shipStates}/>
        <FreightButton icon="file" onClick={()=>onOpenShipment(s.id)}>운송 상세</FreightButton></div>
      {sideRows.map((sideRow,i)=><FinanceSide key={i} r={sideRow} billing={i===0} requiresProof={data.policies.requireProofForBilling}
        onConfirm={()=>open('confirm',i===0)} onPayment={side=>open('payment',i===0,side)}/>)}
      <section className="fr-record-block"><h3>운임 차익</h3><FreightFacts items={[[ '회사 부담 추가비용',costLabel(fin.cost)],['운임 차익',costLabel(fin.margin)]]}/></section>
      <section className="fr-record-block"><h3>추가 비용 · {charges.length}건</h3>{charges.length?charges.map(x=><button key={x.id} type="button" className="fr-record-link" onClick={()=>setChargeView({id:x.id,action:'detail'})}>
        <span>{x.kind}<small>화주 {costLabel(x.sellAmount)} · 운송비 {costLabel(x.buyAmount)}</small></span><FreightBadge tone={chargeTones[x.status]}>{chargeStates[x.status]}</FreightBadge></button>):<p className="fr-record-note">등록된 추가 비용이 없습니다.</p>}</section>
      <section className="fr-record-block"><h3>거래 기록 · {payments.length}건</h3>{payments.length?payments.map(p=><button key={p.id} type="button" className="fr-record-link" onClick={()=>setPaymentId(p.id)}>
        <span>{paymentNames[p.side]} · {costLabel(p.amount)}<small>{timeLabel(p.at)} · {p.method}</small></span></button>):<p className="fr-record-note">등록된 거래 기록이 없습니다.</p>}</section>
    </FreightDrawer>}
    {chargeView&&<FreightChargeDialogs data={data} save={save} shipmentId={s.id} view={chargeView} setView={setChargeView} onOpenFinance={()=>setChargeView(null)}/>}
    {payment&&<Modal open title="거래 기록 상세" subtitle={s.number} size={530} onClose={()=>setPaymentId(null)} footer={<div className="service-form-actions"><FreightButton primary onClick={()=>setPaymentId(null)}>닫기</FreightButton></div>}>
      <FreightFacts items={[[ '구분',paymentNames[payment.side]],['금액',costLabel(payment.amount)],['거래 수단',payment.method],['거래 일시',timeLabel(payment.at)],['메모',payment.note||'—']]}/>
    </Modal>}
    {r&&view.action==='payment'&&<TransactionForm key={r.id} r={activeRow} billing={activeBilling} initialSide={view.side} onClose={view.fromList?close:toDetail} onSubmit={submit}
      candidates={view.fromList?eligible:undefined} onSelect={id=>setView({id,action:'payment',fromList:true})}/>}
    {r&&view.action==='agreement'&&<FreightForm size={530} title="합의 운임 확인" subtitle={r.s.number} onClose={toDetail} onSubmit={submit}>
      <FormField field={{key:'sellAmount',label:'화주 합의 운임 (원)',type:'number',min:0,max:1e9,readOnly:r.s.invoiceStatus==='issued'||r.fin.received!==0}} initial={r.s}/>
      <FormField field={{key:'buyAmount',label:'운송사·자사 운송비 (원)',type:'number',min:0,max:1e9,readOnly:r.s.payableStatus==='confirmed'||r.fin.paid!==0}} initial={r.s}/>
      <FormField field={{key:'reason',label:'확인·변경 사유',type:'textarea',required:true,maxLength:500}}/>
    </FreightForm>}
    {r&&view.action==='confirm'&&<FreightForm size={530} title={activeBilling?'청구 확인 기록':'지급 대상 확인 기록'} subtitle={r.s.number} onClose={toDetail} onSubmit={submit} submitLabel="확인 기록">
      <p className="fr-note">{activeRow.party} · {activeBilling?'청구액':'지급 대상액'} {costLabel(activeRow.total)}</p><FormField field={{key:'note',label:'확인 메모',type:'textarea',maxLength:500}}/>
    </FreightForm>}
  </>;
}
