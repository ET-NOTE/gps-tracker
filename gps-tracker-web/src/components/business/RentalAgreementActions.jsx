import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { authScope } from '../../authSession';
import { kstDateTime } from '../../lib/businessExport';
import { agreedPrice, priceTotal } from '../../lib/rentalInventory';
import { won } from '../../lib/rentalOffice';
import { Button, FormField, Input, Modal, Textarea } from '../ui';
import { BusinessError } from './BusinessWorkspace';
import { fromKst, kstInput } from './RentalBookingForm';

export const fundsKey=id=>[authScope(),'rental-return-balance',id];
const useFunds=id=>useQuery({queryKey:fundsKey(id),queryFn:()=>api.rentalBalance(id),staleTime:0});

export function AgreementDetail({contract}) {
  const price=agreedPrice(contract),funds=useFunds(contract.id);
  return <section><h3>합의 요금</h3><dl>{[['기본 대여료',price.base_krw],['옵션',price.option_krw],['할인',-price.discount_krw],
    ['연장 추가 요금',price.extension_krw],['반납 추가 요금',price.return_extra_krw],['합계',priceTotal(price)]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{won(value)}</dd></div>)}</dl>
    {funds.error && <BusinessError onRetry={funds.refetch}>연장 내역을 불러오지 못했습니다.</BusinessError>}
    {funds.data?.extensions?.length>0 && <details><summary>연장 내역 {funds.data.extensions.length}건</summary>
      <ul className="rental-milestones">{funds.data.extensions.map(e=><li key={e.created_at}>
        <span>{kstDateTime(e.ends_before)} → {kstDateTime(e.ends_after)} · {won(e.additional_krw)}{e.reason && ' · '+e.reason}</span>
        <time dateTime={e.created_at}>{kstDateTime(e.created_at)}</time></li>)}</ul></details>}
  </section>;
}

export function RentalExtension({contract,onClose,onSaved}) {
  const [end,setEnd]=useState(()=>kstInput(Date.parse(contract.ends_at)+86400000));
  const [amount,setAmount]=useState('0'),[reason,setReason]=useState(''),[checked,setChecked]=useState(false);
  const [key]=useState(()=>crypto.randomUUID()),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const valid=!!end && Date.parse(end+':00+09:00')>Date.parse(contract.ends_at) && /^(0|[1-9]\d*)$/.test(amount) && Number(amount)<=1_000_000_000;
  function change(set,value){set(value);setChecked(false);setError('');}
  async function save(){
    if(busy || !valid || !checked)return;
    setBusy(true);setError('');
    try{const saved=await api.extendRental(contract.id,{ends_at:fromKst(end),expected_ends_at:contract.ends_at,additional_krw:Number(amount),reason:reason.trim() || null,request_key:key});await onSaved(saved);}
    catch(e){setError(e.message);}finally{setBusy(false);}
  }
  return <Modal open title="대여 기간 연장" subtitle={'예약 R-'+contract.id} onClose={busy?undefined:onClose}
    footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>닫기</Button><Button busy={busy} disabled={!valid || !checked} onClick={save}>연장 확정</Button></>}>
    <div className="rental-form-sections"><p>현재 반납 예정 <strong>{kstDateTime(contract.ends_at)}</strong></p>
      <FormField label="변경할 반납 예정 (한국 시간)"><Input type="datetime-local" value={end} onChange={e=>change(setEnd,e.target.value)}/></FormField>
      <FormField label="합의한 연장 추가 요금 (원)"><Input type="number" min="0" step="1" max="1000000000" value={amount} onChange={e=>change(setAmount,e.target.value)}/></FormField>
      <FormField label="연장 메모"><Textarea maxLength={500} value={reason} onChange={e=>change(setReason,e.target.value)}/></FormField>
      <p aria-live="polite">연장 후 합계 <strong>{won(priceTotal(agreedPrice(contract))+(Number(amount)||0))}</strong></p>
      <label className="rental-check"><input type="checkbox" checked={checked} disabled={!valid} onChange={e=>setChecked(e.target.checked)}/>연장 기간과 추가 요금을 확인했습니다.</label>
      {error && <p role="alert" className="business-error">{error}</p>}</div>
  </Modal>;
}

export function FinalizeRental({contract,onClose,onSaved}) {
  const funds=useFunds(contract.id),[key]=useState(()=>crypto.randomUUID());
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[checked,setChecked]=useState(false);
  const balance=funds.data && funds.data.billed_krw-funds.data.paid_krw;
  async function save(){
    if(busy || balance!==0 || !checked)return;
    setBusy(true);setError('');
    try{const saved=await api.settleRental(contract.id,{request_key:key});await onSaved(saved);}
    catch(e){setError(e.message);funds.refetch();}finally{setBusy(false);}
  }
  return <Modal open title="대여료 정산 완료" subtitle={'예약 R-'+contract.id} onClose={busy?undefined:onClose}
    footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>닫기</Button><Button busy={busy} disabled={balance!==0 || !checked || funds.isFetching} onClick={save}>정산 확정</Button></>}>
    <div className="rental-form-sections">{funds.error?<BusinessError onRetry={funds.refetch}>정산 잔액을 불러오지 못했습니다.</BusinessError>
      :!funds.data?<p role="status">잔액을 조회하는 중…</p>:<>
        <dl className="rental-money-list">{[['최종 대여료',funds.data.billed_krw],['순수납',funds.data.paid_krw],['보관 중인 보증금',funds.data.held_krw]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{won(value)}</dd></div>)}</dl>
        {balance===0?<><p>확정하면 이용료 수납·환불 장부가 마감됩니다. 보증금 반환은 이후에도 기록할 수 있습니다.</p>
          <label className="rental-check"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/>최종 대여료와 순수납 금액을 확인했습니다.</label></>
          :<p role="status">{balance>0?'미수금 '+won(balance)+'을 수납':'초과 수납액 '+won(-balance)+'을 환불'}한 뒤 정산을 확정해 주세요.</p>}
      </>}{error && <p role="alert" className="business-error">{error}</p>}</div>
  </Modal>;
}
