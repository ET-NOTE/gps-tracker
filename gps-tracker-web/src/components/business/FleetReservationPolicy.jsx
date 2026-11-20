import React,{useState} from 'react';
import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';
import {api} from '../../api';
import {useFleetAccess} from './FleetAccess';
import {BusinessButton,BusinessError,BusinessSection} from './BusinessWorkspace';

export default function FleetReservationPolicy(){
  const access=useFleetAccess(),qc=useQueryClient();
  const q=useQuery({queryKey:['fleet-reservation-policy'],queryFn:()=>api.fleetReservationPolicy()});
  const [message,setMessage]=useState('');
  const save=useMutation({mutationFn:api.setFleetReservationPolicy,onSuccess:data=>{
    qc.setQueryData(['fleet-reservation-policy'],data);
    setMessage(data.approval_required?'새 예약에 승인을 적용했습니다.':'새 예약을 즉시 확정하도록 변경했습니다.');
  },onError:async error=>{setMessage(error.message);await q.refetch();}});
  return <BusinessSection title="예약 승인 정책"><div className="fleet-policy-controls">
    {q.error?<BusinessError onRetry={q.refetch}>예약 정책을 불러오지 못했습니다.</BusinessError>:!q.data?<p role="status">불러오는 중…</p>:<>
      <p>승인을 사용하면 새 예약은 관리자 확인 후 확정됩니다. 기존 예약은 신청 당시 정책을 따릅니다.</p>
      <strong>{q.data.approval_required?'승인 후 확정':'즉시 확정'}</strong>
      {access.role==='owner'&&<BusinessButton disabled={save.isPending} onClick={()=>save.mutate({approval_required:!q.data.approval_required,previous:q.data.approval_required})}>{q.data.approval_required?'즉시 확정으로 변경':'승인 사용'}</BusinessButton>}
    </>}
    {message&&<p role="status">{message}</p>}
  </div></BusinessSection>;
}
