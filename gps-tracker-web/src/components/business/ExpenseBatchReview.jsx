import React, {useEffect,useRef,useState} from 'react';
import {api} from '../../api';
import {expenseMoney} from '../../lib/fleetExpenses';
import {Modal,FormField,Textarea} from '../ui';
import {BusinessButton} from './BusinessWorkspace';

export default function ExpenseBatchReview({rows,decision,onClose,onDone,combined=false,onInterrupted}) {
  const [reason,setReason]=useState(''), [busy,setBusy]=useState(false);
  const sending=useRef(false),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const label=decision==='approved'?'승인':'반려';
  async function submit(){
    if(sending.current||!rows.length||(decision==='rejected'&&!reason.trim()))return;
    sending.current=true;setBusy(true);
    const failed=[];
    for(const item of rows){
      if(!mounted.current){onInterrupted?.();return;}
      const row=combined?item.raw:item;
      const note=reason.trim(),updated_at=row.updated_at;
      try{
        if(combined&&(!row.can_review||row.status!=='pending'||!updated_at))throw Error('처리 권한과 현재 상태를 다시 확인해 주세요.');
        if(combined&&item.type==='reservation')await api.reviewFleetReservation(row.id,{decision:decision==='approved'?'approve':'reject',note,updated_at});
        else await api.reviewExpense(row.id,{status:decision,note,updated_at});
      }
      catch(error){failed.push(`${combined?item.kind+' ':''}#${row.id} ${error.message||'처리 실패'}`);}
    }
    if(mounted.current)onDone(`${rows.length-failed.length}건 ${label} · 실패 ${failed.length}건`,failed);
    else onInterrupted?.();
  }
  return <Modal open title={`선택 ${combined?'요청':'지출'} ${label}`} onClose={busy?undefined:onClose} footer={<div className="expense-review-confirm-actions">
    <BusinessButton disabled={busy} onClick={onClose}>돌아가기</BusinessButton>
    <BusinessButton primary disabled={busy||!rows.length||(decision==='rejected'&&!reason.trim())} onClick={submit}>{busy?'처리 중…':`${rows.length}건 ${label}`}</BusinessButton>
  </div>}>
    <div className="expense-review-confirm">
      <strong>{combined?`선택한 요청 ${rows.length}건`:`${rows.length}건 · ${expenseMoney(rows.reduce((sum,r)=>sum+r.amount_krw,0))}원`}</strong>
      <ul className="expense-batch-records">{combined?rows.map(r=><li key={r.key}><span>{r.kind} #{r.raw.id} · {r.title}</span><strong>{r.period}</strong></li>):rows.map(r=><li key={r.id}><span>#{r.id} · {r.staff_name||'미지정'} · {r.category_name}</span><strong>{expenseMoney(r.amount_krw)}원</strong></li>)}</ul>
      <FormField label={decision==='approved'?'사유 (선택)':'반려 사유 (필수)'}><Textarea aria-label="일괄 처리 사유" disabled={busy} rows={3} maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/></FormField>
    </div>
  </Modal>;
}
