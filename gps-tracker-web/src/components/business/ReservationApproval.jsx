import React,{useEffect,useState} from 'react';
import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';
import {api} from '../../api';
import {kstDateTime} from '../../lib/businessExport';
import {BusinessButton,BusinessError} from './BusinessWorkspace';
import {FormField,Modal,Textarea} from '../ui';

const statusLabel={pending:'승인 대기',planned:'이용 예정',rejected:'반려',in_progress:'이용 중',completed:'완료',cancelled:'취소'};
// `decision`/`onDecision` let the desktop drawer footer own the approve and reject buttons;
// `compact` then hides the in-body title and buttons.
export default function ReservationApproval({row,reviewable,onFinished,decision:outside,onDecision,compact=false}){
  const [inside,setInside]=useState(null),[note,setNote]=useState(''),[open,setOpen]=useState(false);
  const controlled=onDecision!==undefined,decision=controlled?outside:inside,setDecision=controlled?onDecision:setInside;
  const qc=useQueryClient();
  const history=useQuery({queryKey:['fleet-reservation-history',row.id],queryFn:()=>api.fleetReservationHistory(row.id),enabled:open});
  const review=useMutation({mutationFn:body=>api.reviewFleetReservation(row.id,body),onSuccess:async()=>{
    setDecision(null);
    await Promise.all([qc.invalidateQueries({queryKey:['business','corporate','vehicle-reservations']}),qc.invalidateQueries({queryKey:['fleet-reservation-history',row.id]})]);
    onFinished();
  }});
  function select(value){review.reset();setDecision(value);setNote('');}
  useEffect(()=>{if(controlled&&outside){review.reset();setNote('');}},[controlled,outside]);
  const action=decision==='approve'?'승인':'반려';
  return <div className="fleet-reservation-review">
    {!compact&&<strong>예약 승인 · {statusLabel[row.status]||row.status}</strong>}
    {!compact&&row.can_review&&reviewable&&row.status==='pending'&&<div className="expense-actions"><BusinessButton primary onClick={()=>select('approve')}>예약 승인</BusinessButton><BusinessButton onClick={()=>select('reject')}>예약 반려</BusinessButton></div>}
    <BusinessButton aria-expanded={open} onClick={()=>setOpen(!open)}>예약 처리 이력</BusinessButton>
    {open&&(history.error?<BusinessError onRetry={history.refetch}>이력을 불러오지 못했습니다.</BusinessError>:!history.data?<p role="status">불러오는 중…</p>:<ol className="expense-history">
      {history.data.map(h=><li key={h.id}><strong>{h.action==='reservation_review'&&h.status==='planned'?'승인':statusLabel[h.status]||h.status}</strong><span>{kstDateTime(h.created_at)} · {h.actor_id?`계정 #${h.actor_id}`:'탈퇴 계정'}</span>{h.note&&<p>{h.note}</p>}</li>)}
      {!history.data.length&&<li>처리 이력이 없습니다.</li>}
    </ol>)}
    {decision&&<Modal open title={`예약 ${action}`} onClose={review.isPending?undefined:()=>setDecision(null)} footer={<div className="expense-review-confirm-actions"><BusinessButton disabled={review.isPending} onClick={()=>setDecision(null)}>돌아가기</BusinessButton>
      <BusinessButton primary disabled={review.isPending||(decision==='reject'&&!note.trim())} onClick={()=>review.mutate({decision,note:note.trim(),updated_at:row.updated_at})}>{action} 처리</BusinessButton></div>}>
      <p>{row.vehicle_name||row.license_plate} · {kstDateTime(row.starts_at)} ~ {kstDateTime(row.ends_at)}</p>
      <FormField label={decision==='approve'?'사유 (선택)':'반려 사유 (필수)'}><Textarea aria-label="예약 처리 사유" value={note} maxLength={500} onChange={e=>setNote(e.target.value)}/></FormField>
      {review.error&&<p role="alert">{review.error.message}</p>}
    </Modal>}
  </div>;
}
