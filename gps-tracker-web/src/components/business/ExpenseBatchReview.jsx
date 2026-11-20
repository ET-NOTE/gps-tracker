import React, {useEffect,useRef,useState} from 'react';
import {api} from '../../api';
import {expenseMoney} from '../../lib/fleetExpenses';
import {Modal,FormField,Textarea} from '../ui';
import {BusinessButton} from './BusinessWorkspace';

export default function ExpenseBatchReview({rows,decision,onClose,onDone}) {
  const [reason,setReason]=useState(''), [busy,setBusy]=useState(false);
  const sending=useRef(false),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const label=decision==='approved'?'승인':'반려';
  async function submit(){
    if(sending.current||!rows.length||(decision==='rejected'&&!reason.trim()))return;
    sending.current=true;setBusy(true);
    const failed=[];
    for(const row of rows){
      if(!mounted.current)return;
      try{await api.reviewExpense(row.id,{status:decision,note:reason.trim(),updated_at:row.updated_at});}
      catch(error){failed.push(`#${row.id} ${error.message||'처리 실패'}`);}
    }
    if(mounted.current)onDone(`${rows.length-failed.length}건 ${label} · 실패 ${failed.length}건`,failed);
  }
  return <Modal open title={`선택 지출 ${label}`} onClose={busy?undefined:onClose} footer={<div className="expense-review-confirm-actions">
    <BusinessButton disabled={busy} onClick={onClose}>돌아가기</BusinessButton>
    <BusinessButton primary disabled={busy||!rows.length||(decision==='rejected'&&!reason.trim())} onClick={submit}>{busy?'처리 중…':`${rows.length}건 ${label}`}</BusinessButton>
  </div>}>
    <div className="expense-review-confirm">
      <strong>{rows.length}건 · {expenseMoney(rows.reduce((sum,r)=>sum+r.amount_krw,0))}원</strong>
      <ul className="expense-batch-records">{rows.map(r=><li key={r.id}><span>#{r.id} · {r.staff_name||'미지정'} · {r.category_name}</span><strong>{expenseMoney(r.amount_krw)}원</strong></li>)}</ul>
      <FormField label={decision==='approved'?'사유 (선택)':'반려 사유 (필수)'}><Textarea aria-label="일괄 처리 사유" disabled={busy} rows={3} maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/></FormField>
    </div>
  </Modal>;
}
