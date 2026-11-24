import React from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../../api';
import {outsideBookingHours} from '../../lib/fleetBookingHours';
import {BusinessError, BusinessSection} from './BusinessWorkspace';
import './fleet-booking-hours.css';

const days = ['월','화','수','목','금','토','일'];
const presets = [['평일',31],['주말',96],['전체 요일',127]];
export const bookingHoursKey = ['fleet-booking-hours'];

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

/** Editable form state for stored booking hours. */
export function hoursDraft(hours) {
  const allDay=hours.open_minute===0 && hours.close_minute===1440;
  return {mask:hours.week_mask, allDay,
    start:clock(allDay?540:hours.open_minute),
    end:clock(allDay?1080:hours.close_minute===1440?0:hours.close_minute)};
}
export function hoursFromDraft(draft) {
  return {week_mask:draft.mask,
    open_minute:draft.allDay?0:minutes(draft.start),
    close_minute:draft.allDay||draft.end==='00:00'?1440:minutes(draft.end)};
}
export function hoursInvalid(draft) {
  const {week_mask,open_minute,close_minute}=hoursFromDraft(draft);
  return week_mask===0?'예약 가능한 요일을 하나 이상 선택해 주세요.':
    !(open_minute<close_minute)?'종료 시간을 시작 시간 이후로 설정해 주세요.':'';
}
export function hoursChanged(hours, draft) {
  const next=hoursFromDraft(draft);
  return hours.week_mask!==next.week_mask || hours.open_minute!==next.open_minute || hours.close_minute!==next.close_minute;
}

/**
 * Controlled weekday and time fields; saving belongs to the operating policy page.
 * `desk` (desktop design) drops the current-setting line and uses the design's time labels.
 */
export function BookingHoursFields({hours, draft, onChange, disabled, desk=false}) {
  const set=patch=>onChange({...draft,...patch});
  const invalid=hoursInvalid(draft);
  return <div className="fleet-hours">{!desk&&<p role="status">현재 적용 중 · <strong>{summary(hours)}</strong></p>}
    <div className="fleet-hours-form">
      <fieldset disabled={disabled}><legend>예약 가능 요일</legend>
        <div className="fleet-hours-presets">{presets.map(([text,v])=><button key={v} type="button" aria-pressed={draft.mask===v} onClick={()=>set({mask:v})}>{text}</button>)}</div>
        <div className="fleet-hours-days">{days.map((day,i)=><label key={day}><input type="checkbox" aria-label={day+'요일'} checked={Boolean(draft.mask & (1<<i))} onChange={()=>set({mask:draft.mask^(1<<i)})}/><span>{day}<span className="fleet-weekday-suffix">요일</span></span></label>)}</div>
      </fieldset>
      <fieldset disabled={disabled}><legend>예약 가능 시간 · 한국시간</legend>
        <label><input type="checkbox" checked={draft.allDay} onChange={e=>set({allDay:e.target.checked})}/>하루 종일</label>
        {!draft.allDay && <div className="fleet-hours-time"><label>{desk?'예약 시작 가능 시간':'시작 시간'}<input type="time" required value={draft.start} onChange={e=>set({start:e.target.value})}/></label>
          <label>{desk?'예약 종료 시간':'종료 시간'}<input type="time" required value={draft.end} onChange={e=>set({end:e.target.value})}/></label></div>}
      </fieldset>
      {invalid && <p role="alert">{invalid}</p>}
    </div>
  </div>;
}

export default function FleetBookingHours({hintOnly=false,start,end,checkInterval=true}) {
  const query=useQuery({queryKey:bookingHoursKey, queryFn:api.fleetBookingHours});
  const hours=query.data;
  if(hintOnly) {
    if (!hours || (hours.week_mask===127 && hours.open_minute===0 && hours.close_minute===1440)) return null;
    const outside=checkInterval && outsideBookingHours(hours,Date.parse(start+'+09:00'),Date.parse(end+'+09:00'));
    return <p className={outside?'business-note fleet-hours-warning':'business-note'} role="status">
      {outside?'선택한 시간이 예약 허용 범위를 벗어납니다. ':''}예약 가능 일정 · {summary(hours)}
    </p>;
  }
  return <BusinessSection title="예약 허용일" description="차량을 예약할 수 있는 요일과 시간을 설정합니다.">
    {query.error ? <BusinessError onRetry={query.refetch}>예약 허용일을 불러오지 못했습니다.</BusinessError> :
      hours ? <div className="fleet-hours"><p role="status">현재 적용 중 · <strong>{summary(hours)}</strong></p></div>
      : <p role="status">불러오는 중…</p>}
  </BusinessSection>;
}
