import React, {useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {api} from '../../api';
import {outsideBookingHours} from '../../lib/fleetBookingHours';
import {useFleetAccess} from './FleetAccess';
import {BusinessButton, BusinessError, BusinessSection} from './BusinessWorkspace';
import './fleet-booking-hours.css';

const days = ['월','화','수','목','금','토','일'];
const presets = [['평일',31],['주말',96],['전체 요일',127]];
const key = ['fleet-booking-hours'];

function clock(minute) {
  return [Math.floor(minute/60),minute%60].map(v=>String(v).padStart(2,'0')).join(':');
}
function minutes(time) {
  if (!time) return NaN;
  const [h,m]=time.split(':').map(Number);
  return h*60+m;
}
function summary(hours) {
  const dayText=presets.find(([,mask])=>mask===hours.week_mask)?.[0] ||
    days.filter((_,i)=>hours.week_mask & (1<<i)).join('·');
  const time=hours.open_minute===0 && hours.close_minute===1440 ? '하루 종일' :
    clock(hours.open_minute)+'–'+clock(hours.close_minute);
  return dayText+' · '+time;
}


function Editor({hours, refresh}) {
  const qc=useQueryClient();
  const [mask,setMask]=useState(hours.week_mask);
  const [allDay,setAllDay]=useState(hours.open_minute===0 && hours.close_minute===1440);
  const [start,setStart]=useState(clock(allDay?540:hours.open_minute));
  const [end,setEnd]=useState(clock(allDay?1080:hours.close_minute===1440?0:hours.close_minute));
  const [message,setMessage]=useState('');
  const open=allDay?0:minutes(start), close=allDay||end==='00:00'?1440:minutes(end);
  const invalid=mask===0?'예약 가능한 요일을 하나 이상 선택해 주세요.':
    !(open<close)?'종료 시간을 시작 시간 이후로 설정해 주세요.':'';
  const changed=hours.week_mask!==mask || hours.open_minute!==open || hours.close_minute!==close;
  const save=useMutation({mutationFn:api.setFleetBookingHours,onSuccess:data=>{
    qc.setQueryData(key,data);
  }});
  return <form className="fleet-hours-form" onSubmit={async e=>{
    e.preventDefault();
    if(!changed||invalid||save.isPending)return;
    setMessage('');
    try { await save.mutateAsync({week_mask:mask,open_minute:open,close_minute:close,revision:hours.revision}); }
    catch(error) {setMessage(error.message);}
  }}>
    <fieldset disabled={save.isPending}><legend>예약 가능 요일</legend>
      <div className="fleet-hours-presets">{presets.map(([text,v])=><button key={v} type="button" aria-pressed={mask===v} onClick={()=>setMask(v)}>{text}</button>)}</div>
      <div className="fleet-hours-days">{days.map((day,i)=><label key={day}><input type="checkbox" checked={Boolean(mask & (1<<i))} onChange={()=>setMask(value=>value^(1<<i))}/>{day}요일</label>)}</div>
    </fieldset>
    <fieldset disabled={save.isPending}><legend>예약 가능 시간 · 한국시간</legend>
      <label><input type="checkbox" checked={allDay} onChange={e=>setAllDay(e.target.checked)}/>하루 종일</label>
      {!allDay && <div className="fleet-hours-time"><label>시작 시간<input type="time" required value={start} onChange={e=>setStart(e.target.value)}/></label>
        <label>종료 시간<input type="time" required value={end} onChange={e=>setEnd(e.target.value)}/></label></div>}
    </fieldset>
    {invalid && <p role="alert">{invalid}</p>}
    {message && <div role="alert">{message} <button type="button" onClick={()=>refresh()}>다시 조회</button></div>}
    <div className="fleet-hours-save"><BusinessButton type="submit" primary disabled={!changed||Boolean(invalid)||save.isPending}>{save.isPending?'저장 중…':'예약 허용일 저장'}</BusinessButton></div>
  </form>;
}

export default function FleetBookingHours({hintOnly=false,start,end,checkInterval=true}) {
  const access=useFleetAccess();
  const query=useQuery({queryKey:key, queryFn:api.fleetBookingHours});
  const hours=query.data;
  if(hintOnly) {
    if (!hours || (hours.week_mask===127 && hours.open_minute===0 && hours.close_minute===1440)) return null;
    const outside=checkInterval && outsideBookingHours(hours,Date.parse(start+'+09:00'),Date.parse(end+'+09:00'));
    return <p className={outside?'business-note fleet-hours-warning':'business-note'} role="status">
      {outside?'선택한 시간이 예약 허용 범위를 벗어납니다. ':''}예약 가능 일정 · {summary(hours)}
    </p>;
  }
  return <BusinessSection title="예약 허용일">
    {query.error ? <BusinessError onRetry={query.refetch}>예약 허용일을 불러오지 못했습니다.</BusinessError> :
      hours ? <div className="fleet-hours"><p role="status">현재 적용 중 · <strong>{summary(hours)}</strong></p>
        {access.role==='owner' && <Editor key={hours.revision} hours={hours} refresh={query.refetch}/>}</div>
      : <p role="status">불러오는 중…</p>}
  </BusinessSection>;
}
