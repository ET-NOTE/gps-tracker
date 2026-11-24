import React,{useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {api} from '../../api';
import {useFleetAccess} from './FleetAccess';
import {BusinessButton,BusinessError,BusinessSection} from './BusinessWorkspace';
import {BookingHoursFields,bookingHoursKey,hoursChanged,hoursDraft,hoursFromDraft,hoursInvalid} from './FleetBookingHours';
import './fleet-settings-controls.css';

export const reservationPolicyKey=['fleet-reservation-policy'];
export const operatingPolicyKey=['fleet-operating-policy'];
export const DEFAULT_OFFLINE_MINUTES=10;
const operatingFields=['expense_approval_required','trip_purpose_required','personal_use_allowed','review_after_trip','offline_minutes'];

export function useOperatingPolicy(){
  return useQuery({queryKey:operatingPolicyKey,queryFn:api.fleetOperatingPolicy});
}

function Toggle({label,hint,checked,onChange,disabled}){
  return <label className="fleet-policy-toggle">
    <span><strong>{label}</strong><small>{hint}</small></span>
    <input className="fleet-setting-switch" role="switch" type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={e=>onChange(e.target.checked)}/>
  </label>;
}

function offlineError(text){
  const n=Number(text);
  return /^\d+$/.test(String(text).trim()) && n>=1 && n<=240 ? '' : '수신 지연 판단 시간은 1분에서 240분 사이로 입력해 주세요.';
}

/**
 * Operating policy page: one bar saves only the parts that changed, each to its own API.
 * `desk` is the desktop design: only 예약 허용일 keeps its subtitle and the approval note is hidden.
 */
export default function FleetOperatingPolicy({desk=false}={}){
  const access=useFleetAccess(),qc=useQueryClient(),owner=access.role==='owner';
  const reservation=useQuery({queryKey:reservationPolicyKey,queryFn:api.fleetReservationPolicy});
  const operating=useOperatingPolicy();
  const hours=useQuery({queryKey:bookingHoursKey,queryFn:api.fleetBookingHours});
  const [edits,setEdits]=useState({});
  const [saving,setSaving]=useState(false);
  const [message,setMessage]=useState({text:'',error:false});
  const failed=[[reservation,'예약 정책'],[operating,'운영 정책'],[hours,'예약 허용일']].find(([q])=>q.error&&!q.data);
  if(failed) return <BusinessError onRetry={failed[0].refetch}>{failed[1]}을 불러오지 못했습니다.</BusinessError>;
  if(!reservation.data||!operating.data||!hours.data) return <p role="status">운영 정책을 불러오는 중…</p>;

  const op=operating.data;
  const base={reservation_approval:reservation.data.approval_required,
    ...Object.fromEntries(operatingFields.map(k=>[k,k==='offline_minutes'?String(op[k]):op[k]])),
    hours:hoursDraft(hours.data)};
  const value={...base,...edits};
  const set=patch=>{setMessage({text:'',error:false});setEdits(e=>({...e,...patch}));};
  const reservationDirty=value.reservation_approval!==base.reservation_approval;
  const operatingDirty=operatingFields.some(k=>value[k]!==base[k]);
  const hoursDirty=hoursChanged(hours.data,value.hours);
  const dirty=reservationDirty||operatingDirty||hoursDirty;
  const invalid=(operatingDirty&&offlineError(value.offline_minutes))||(hoursDirty&&hoursInvalid(value.hours));
  const locked=!owner||saving;

  async function save(){
    if(!dirty||invalid||saving)return;
    setSaving(true);setMessage({text:'',error:false});
    const done=[];
    try{
      if(reservationDirty){
        const data=await api.setFleetReservationPolicy({approval_required:value.reservation_approval,previous:base.reservation_approval});
        qc.setQueryData(reservationPolicyKey,data);done.push('reservation_approval');
      }
      if(operatingDirty){
        const data=await api.setFleetOperatingPolicy({...Object.fromEntries(operatingFields.map(k=>[k,k==='offline_minutes'?Number(value[k]):value[k]])),revision:op.revision});
        qc.setQueryData(operatingPolicyKey,data);done.push(...operatingFields);
      }
      if(hoursDirty){
        const data=await api.setFleetBookingHours({...hoursFromDraft(value.hours),revision:hours.data.revision});
        qc.setQueryData(bookingHoursKey,data);done.push('hours');
      }
      setEdits({});
      setMessage({text:'변경사항을 저장했습니다. 이후 등록하는 업무부터 적용됩니다.',error:false});
    }catch(error){
      // Keep the parts that were not saved; the saved parts now come from the server.
      setEdits(e=>Object.fromEntries(Object.entries(e).filter(([k])=>!done.includes(k))));
      setMessage({text:(error.message||'운영 정책을 저장하지 못했습니다.')+(done.length?' 일부 항목은 저장되었습니다.':''),error:true});
      await Promise.all([reservation.refetch(),operating.refetch(),hours.refetch()]);
    }finally{setSaving(false);}
  }

  return <div className="fleet-operating-policy">
    <div className="fleet-policy-bar"><p>저장한 정책은 이후 등록하는 업무에 적용됩니다.</p>
      {owner?<div className="fleet-policy-bar-actions">
        <BusinessButton disabled={!dirty||saving} onClick={()=>{setEdits({});setMessage({text:'',error:false});}}>되돌리기</BusinessButton>
        <BusinessButton primary disabled={!dirty||Boolean(invalid)||saving} onClick={save}>{saving?'저장 중…':'변경사항 저장'}</BusinessButton>
      </div>:<small>회사 소유자만 변경할 수 있습니다.</small>}
    </div>
    {(message.text||(dirty&&invalid))&&<p className="fleet-policy-feedback" role={message.error||invalid?'alert':'status'}>{message.text||invalid}</p>}
    <BusinessSection title="승인 방식" description={desk?undefined:"업무 요청을 확정하는 방식을 정합니다."}><div className="fleet-policy-controls">
      <label className="fleet-policy-field">차량 예약
        <select aria-label="차량 예약 승인 방식" value={value.reservation_approval?'approval':'instant'} disabled={locked}
          onChange={e=>set({reservation_approval:e.target.value==='approval'})}>
          <option value="approval">관리자 승인</option><option value="instant">즉시 확정</option>
        </select></label>
      <label className="fleet-policy-field">지출 신청
        <select aria-label="지출 신청 승인 방식" value={value.expense_approval_required?'approval':'instant'} disabled={locked}
          onChange={e=>set({expense_approval_required:e.target.value==='approval'})}>
          <option value="approval">관리자 승인</option><option value="instant">즉시 승인</option>
        </select></label>
      {!desk&&<p className="fleet-policy-hint">기존 예약과 지출은 신청 당시 정책을 따릅니다.</p>}
    </div></BusinessSection>
    <BusinessSection title="운행 기록 기준" description={desk?undefined:"운행일지 작성과 확정 기준을 정합니다."}><div className="fleet-policy-controls fleet-policy-toggles">
      <Toggle label="운행 목적 필수" hint="예약과 운행일지에 목적을 지정합니다." checked={value.trip_purpose_required} disabled={locked} onChange={v=>set({trip_purpose_required:v})}/>
      <Toggle label="개인 용도 이용 허용" hint="개인 용도의 예약을 허용합니다." checked={value.personal_use_allowed} disabled={locked} onChange={v=>set({personal_use_allowed:v})}/>
      <Toggle label="운행 종료 후 확인" hint="완료된 운행 내용을 검토하고 확정합니다." checked={value.review_after_trip} disabled={locked} onChange={v=>set({review_after_trip:v})}/>
    </div></BusinessSection>
    <BusinessSection className="fleet-policy-wide" title="예약 허용일" description="차량을 예약할 수 있는 요일과 시간을 설정합니다.">
      <BookingHoursFields desk={desk} hours={hours.data} draft={value.hours} disabled={locked} onChange={draft=>set({hours:draft})}/>
    </BusinessSection>
    <BusinessSection className="fleet-policy-wide" title="단말 수신 기준" description={desk?undefined:"단말 상태를 판단하는 기준을 정합니다."}><div className="fleet-policy-controls">
      <label className="fleet-policy-field fleet-policy-minutes">수신 지연 판단 시간 · 분
        <input type="number" inputMode="numeric" min={1} max={240} step={1} aria-label="수신 지연 판단 시간(분)" value={value.offline_minutes} disabled={locked}
          onChange={e=>set({offline_minutes:e.target.value})}/></label>
      <p className="fleet-policy-hint">마지막 수신 후 이 시간이 지나면 확인이 필요한 단말로 표시합니다.</p>
    </div></BusinessSection>
  </div>;
}
