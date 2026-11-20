import { epoch, getRow, moneyValue, newId, record, stamp } from './freightWorkflow.js';

export const paymentNames = {receipt:'화주 수납',receipt_refund:'화주 환불',payout:'운송비 지급',payout_refund:'지급금 환수'};
export const chargeStates = {pending:'확인 대기', approved:'승인', rejected:'반려'};
export const paymentMethods = ['계좌이체','카드','현금'];

export function shipmentFinance(data, shipment) {
  const approved = data.charges.filter(x => x.shipmentId === shipment.id && x.status === 'approved');
  const sum = key => approved.reduce((total,x) => total + Number(x[key] || 0),0);
  function total(key) {
    if (shipment.status === 'cancelled') return sum(key);
    const value = shipment[key];
    return value == null || value === '' ? null : Number(value) + sum(key);
  }
  const receipts = data.payments.filter(x => x.shipmentId === shipment.id);
  const net = side => receipts.reduce((total,x) => total + (x.side === side ? x.amount : x.side === side+'_refund' ? -x.amount : 0),0);
  const sell = total('sellAmount'), buy = total('buyAmount'), cost = sum('companyCost');
  const received = net('receipt'), paid = net('payout');
  return {sell,buy,cost,received,paid,receivable:sell == null ? null : Math.max(0,sell-received),
    payable:buy == null ? null : Math.max(0,buy-paid), margin:sell == null || buy == null ? null : sell-buy-cost,
    approved,receipts};
}
export function paymentLimit(fin,side) {
  return ({receipt:fin.receivable,payout:fin.payable,receipt_refund:fin.received,payout_refund:fin.paid})[side];
}
export function confirmFinance(data, s, billing, note) {
  const fin = shipmentFinance(data,s);
  if ((billing ? fin.sell : fin.buy) == null) throw Error('합의 운임을 먼저 확인해 주세요.');
  if (billing && !['delivered','cancelled'].includes(s.status)) throw Error('하차 완료 후 청구를 확인할 수 있습니다.');
  if (billing && s.status !== 'cancelled' && data.policies.requireProofForBilling && s.proof?.status !== 'approved') throw Error('인수증을 먼저 확인해 주세요.');
  if (billing ? s.invoiceStatus==='issued' : s.payableStatus==='confirmed') throw Error('이미 확인한 운송 건입니다.');
  if (billing) { s.invoiceStatus='issued'; s.invoiceAt=stamp(); }
  else { s.payableStatus='confirmed'; s.payableAt=stamp(); }
  record(data,s,(billing ? '청구' : '지급 대상')+' 확인'+(note?' · '+note:''));
}
export function setAgreement(data,s,values) {
  const fin=shipmentFinance(data,s);
  if (!values.reason.trim()) throw Error('확인·변경 사유를 입력해 주세요.');
  const sell=moneyValue(values.sellAmount), buy=moneyValue(values.buyAmount);
  if ((s.invoiceStatus==='issued'||fin.received!==0) && sell!==(s.sellAmount??null)) throw Error('이미 청구 또는 수납된 기본 운임입니다.');
  if ((s.payableStatus==='confirmed'||fin.paid!==0) && buy!==(s.buyAmount??null)) throw Error('이미 정산 또는 지급된 운송비입니다.');
  s.sellAmount=sell; s.buyAmount=buy;
  record(data,s,'합의 운임 확인 · '+values.reason.trim());
}
export function addPayment(data,s,values) {
  const {side,method,at}=values, note=values.note.trim();
  if (!Object.hasOwn(paymentNames,side) || !paymentMethods.includes(method) || !Number.isFinite(epoch(at))) throw Error('거래 구분, 일시와 방식을 확인해 주세요.');
  const amount=moneyValue(values.amount), max=paymentLimit(shipmentFinance(data,s),side);
  if (!amount || max==null || amount>max) throw Error('기록 가능한 잔액 범위에서 금액을 입력해 주세요.');
  if (side.endsWith('_refund') && !note) throw Error('환불·환수 사유를 입력해 주세요.');
  data.payments.unshift({id:newId(),shipmentId:s.id,side,method,at,note,amount});
  record(data,s,paymentNames[side]+' · '+amount.toLocaleString('ko-KR')+'원');
}
export function saveCharge(data,old,values) {
  const s=getRow(data,'shipments',values.shipmentId);
  if (!s || !data.codes.chargeTypes.includes(values.kind) || !Number.isFinite(epoch(values.at))) throw Error('운송 건, 비용 항목과 일시를 확인해 주세요.');
  if (old?.status==='approved') throw Error('이미 승인된 비용입니다.');
  const amounts={};
  for (const key of ['sellAmount','buyAmount','companyCost']) {
    amounts[key]=moneyValue(values[key]);
    if (amounts[key]==null) throw Error('모든 비용을 입력해 주세요.');
  }
  if (!Object.values(amounts).some(n=>n>0) || !values.note.trim()) throw Error('발생 사유와 한 항목 이상의 비용을 입력해 주세요.');
  const charge=old || {id:newId()};
  Object.assign(charge, values,amounts,{note:values.note.trim(),status:'pending',reviewNote:'',reviewedAt:''});
  if (!old) data.charges.unshift(charge);
  record(data,s,'추가 비용 확인 요청 · '+charge.kind);
}
export function reviewCharge(data,charge,status,note) {
  if (!charge || charge.status !== 'pending' || !['approved','rejected'].includes(status)) throw Error('확인 대기 상태에서만 처리할 수 있습니다.');
  if (status==='rejected' && !note.trim()) throw Error('반려 사유를 입력해 주세요.');
  Object.assign(charge,{status,reviewNote:note.trim(),reviewedAt:stamp()});
  const shipment=getRow(data,'shipments',charge.shipmentId);
  if (status==='approved' && charge.sellAmount>0) shipment.invoiceStatus='draft';
  if (status==='approved' && charge.buyAmount>0) shipment.payableStatus='draft';
  record(data,shipment,'추가 비용 '+chargeStates[status]+' · '+charge.kind+(note?' · '+note.trim():''));
}
