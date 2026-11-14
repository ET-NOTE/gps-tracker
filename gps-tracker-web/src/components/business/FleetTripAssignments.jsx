import React, {useEffect,useState} from 'react';
import {api} from '../../api';
import {Modal,FormField,Input,Select} from '../ui';
import {BusinessButton,BusinessError,BusinessEmpty} from './BusinessWorkspace';
import {useFleetAccess,staffCanDrive} from './FleetAccess';
import {businessDate} from '../../lib/business';
import {kstDateTime,purposeLabel} from '../../lib/businessExport';
import {assignmentSource,tripAssignmentRef} from '../../lib/tripAssignments';
import './FleetTripAssignments.css';

const purposes=[['commute','출퇴근'],['business','업무'],['other','기타']];
const summary=a=>`${a?.driver_name || a?.driver_name_snapshot || '운전자 미지정'} · ${purposeLabel[a?.purpose] || '용무 미지정'}${a?.purpose_note ? ` (${a.purpose_note})` : ''}`;
function PurposeOptions(){return <>{purposes.map(([v,n])=><option key={v} value={v}>{n}</option>)}</>;}
export function TripAssignmentModal({mode,trips,vehicle,from,to,staff,onClose,onSaved}){
  const access=useFleetAccess();
  const [fields,setFields]=useState({change_driver:false,driver_staff_id:access.manage_reports?'':access.staff_id,change_purpose:false,purpose:'business',purpose_note:'',overwrite:false});
  const [preview,setPreview]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const change=(key,value)=>{setFields(s=>({...s,[key]:value}));setPreview(null);setError('');};
  const body={...fields,driver_staff_id:fields.driver_staff_id?Number(fields.driver_staff_id):null,purpose_note:fields.purpose_note.trim()||null,from,to,mode,trips:trips.map(tripAssignmentRef)};
  async function run(apply){setBusy(true);setError('');try{
    const result=await api.assignFleetTrips(vehicle.id,{...body,...(apply?{preview_token:preview.preview_token}:{})});
    if(apply)onSaved(result);else setPreview(result);
  }catch(e){setPreview(null);setError(e.message);}finally{setBusy(false);}}
  return <Modal open title={mode==='suggest'?'예약·규칙으로 지정':'운전자·용무 일괄 지정'} size="xl" onClose={busy?undefined:onClose} closeOnBackdrop={false} footer={<><BusinessButton disabled={busy} onClick={onClose}>취소</BusinessButton>{preview ? <BusinessButton primary disabled={busy||!preview.ready} onClick={()=>run(true)}>{busy?'적용 중…':`${preview.ready}건 적용`}</BusinessButton> : <BusinessButton primary disabled={busy||(mode==='manual'&&!fields.change_driver&&!fields.change_purpose)} onClick={()=>run(false)}>{busy?'확인 중…':'변경 내용 미리보기'}</BusinessButton>}</>}>
    <div className="fleet-assignment">
      <p className="business-note">선택한 {trips.length}건 · {mode==='suggest'?'예약 → 반복 규칙 → 기본 규칙 순서로 빈 항목을 채웁니다. 시간이 겹치거나 배정이 모호한 기록은 제외합니다.':'변경할 항목을 선택하세요. 기존 값은 기본적으로 유지합니다.'}</p>
      {mode==='manual'&&<fieldset disabled={busy} className="fleet-assignment-fields">
        <label className="fleet-check"><input type="checkbox" checked={fields.change_driver} onChange={e=>change('change_driver',e.target.checked)}/>운전자 지정</label>
        <Select aria-label="일괄 운전자" disabled={!fields.change_driver} value={fields.driver_staff_id} onChange={e=>change('driver_staff_id',e.target.value)}>{access.manage_reports&&<option value="">미지정으로 변경</option>}{staff.filter(s=>staffCanDrive(s,vehicle)).map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        <label className="fleet-check"><input type="checkbox" checked={fields.change_purpose} onChange={e=>change('change_purpose',e.target.checked)}/>용무 지정</label>
        <Select aria-label="일괄 용무" disabled={!fields.change_purpose} value={fields.purpose} onChange={e=>change('purpose',e.target.value)}><PurposeOptions/><option value="unspecified">미지정으로 변경</option></Select>
        {fields.change_purpose&&fields.purpose==='other'&&<Input aria-label="기타 용무 설명" placeholder="기타 용무" maxLength={500} value={fields.purpose_note} onChange={e=>change('purpose_note',e.target.value)}/>}
        <label className="fleet-check"><input type="checkbox" checked={fields.overwrite} onChange={e=>change('overwrite',e.target.checked)}/>선택한 항목의 기존 값도 변경</label>
      </fieldset>}
      {error&&<BusinessError>{error}</BusinessError>}
      {preview&&<><p role="status">변경 {preview.ready}건 · 제외 {preview.skipped}건</p><div className="fleet-assignment-preview">{preview.rows.map((r,i)=><article key={i}><header><strong>{kstDateTime(r.started_at)}</strong><span>{r.status==='ready'?assignmentSource(r.source):'제외'}</span></header>{r.status==='ready'?<><div className="business-note">변경 전: {summary(r.before)}</div><div>변경 후: <strong>{summary(r.after)}</strong></div></>:<p className="business-note">{r.reason}</p>}</article>)}</div><p className="business-note">미리보기 이후 자료가 변경되면 다시 확인해야 합니다. 주유비와 메모는 유지됩니다.</p></>}
    </div>
  </Modal>;
}

const blankRule=()=>({name:'',kind:'default',weekdays:[1,2,3,4,5],start_min:540,end_min:1080,valid_from:businessDate(),valid_to:'',driver_staff_id:'',purpose:'',purpose_note:'',active:true});
const time=n=>n===1440?'24:00':`${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
const minutes=s=>s.split(':').reduce((h,m)=>Number(h)*60+Number(m));
export function TripRulesModal({vehicle,staff,onClose}){
  const access=useFleetAccess(), [rows,setRows]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[edit,setEdit]=useState(null);
  async function load(){setError('');try{setRows(await api.listTripRules(vehicle.id));}catch(e){setError(e.message);}}
  useEffect(()=>{load();},[vehicle.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const change=(k,v)=>setEdit(s=>({...s,[k]:v}));
  async function save(e){e.preventDefault();setBusy(true);setError('');try{
    const body={...edit,driver_staff_id:edit.driver_staff_id?Number(edit.driver_staff_id):null,purpose:edit.purpose||null,purpose_note:edit.purpose==='other'?edit.purpose_note?.trim()||null:null,valid_to:edit.valid_to||null,start_min:edit.kind==='default'?0:edit.start_min,end_min:edit.kind==='default'?1440:edit.end_min};
    if(edit.id)await api.updateTripRule(vehicle.id,edit.id,body);else await api.createTripRule(vehicle.id,body);
    setEdit(null);await load();
  }catch(e){setError(e.message);}finally{setBusy(false);}}
  return <Modal open title="기본 운전자·반복 규칙" size="lg" onClose={busy?undefined:onClose} closeOnBackdrop={false}>
    <div className="fleet-assignment"><p className="business-note">규칙을 저장한 뒤 운행을 선택하고 ‘예약·규칙 적용’에서 확인하세요. 저장만으로 과거 기록이 변경되지는 않습니다.</p>
      {error&&<BusinessError onRetry={!edit?load:undefined}>{error}</BusinessError>}
      {!edit&&<>{access.manage_team&&<BusinessButton primary onClick={()=>setEdit(blankRule())}>규칙 추가</BusinessButton>}{rows===null?<p>불러오는 중…</p>:rows.length===0?<BusinessEmpty title="등록한 규칙이 없습니다."/>:<div className="fleet-assignment-preview">{rows.map(r=><article key={r.id}><header><strong>{r.name}</strong><span>{r.active?'사용 중':'사용 중지'}</span></header><p>{r.driver_name||'운전자 유지'} · {purposeLabel[r.purpose]||'용무 유지'}</p><p className="business-note">{r.kind==='default'?'기본 규칙':`${r.weekdays.map(d=>'일월화수목금토'[d]).join('·')} ${time(r.start_min)}–${time(r.end_min)} (한국 시간)`} · {r.valid_from} ~ {r.valid_to||'종료일 없음'}</p>{access.manage_team&&<BusinessButton onClick={()=>setEdit({...r,driver_staff_id:r.driver_staff_id||'',purpose:r.purpose||'',valid_to:r.valid_to||'',purpose_note:r.purpose_note||''})}>수정</BusinessButton>}</article>)}</div>}</>}
      {edit&&<form onSubmit={save}><fieldset disabled={busy} className="fleet-assignment-fields">
        <FormField label="규칙 이름"><Input required maxLength={80} value={edit.name} onChange={e=>change('name',e.target.value)}/></FormField>
        <FormField label="종류"><Select value={edit.kind} onChange={e=>change('kind',e.target.value)}><option value="default">기본 규칙</option><option value="weekly">요일·시간 반복</option></Select></FormField>
        {edit.kind==='weekly'&&<><div className="fleet-weekdays">{[0,1,2,3,4,5,6].map(d=><label key={d}><input type="checkbox" checked={edit.weekdays.includes(d)} onChange={e=>change('weekdays',e.target.checked?[...edit.weekdays,d].sort():edit.weekdays.filter(x=>x!==d))}/>{'일월화수목금토'[d]}</label>)}</div><div className="business-datetime-fields"><FormField label="시작 시간 (KST)"><Input required type="time" value={time(edit.start_min)} onChange={e=>change('start_min',minutes(e.target.value))}/></FormField><FormField label="종료 시간 (KST)"><Input required type="time" value={edit.end_min===1440?'00:00':time(edit.end_min)} onChange={e=>change('end_min',e.target.value==='00:00'?1440:minutes(e.target.value))}/></FormField></div><p className="business-note">종료 00:00은 당일 자정입니다. 자정을 넘는 운행에는 기본 규칙이나 직접 지정을 사용하세요.</p></>}
        <div className="business-datetime-fields"><FormField label="적용 시작일"><Input required type="date" value={edit.valid_from} onChange={e=>change('valid_from',e.target.value)}/></FormField><FormField label="종료일 (선택)"><Input type="date" min={edit.valid_from} value={edit.valid_to} onChange={e=>change('valid_to',e.target.value)}/></FormField></div>
        <FormField label="운전자"><Select value={edit.driver_staff_id} onChange={e=>change('driver_staff_id',e.target.value)}><option value="">지정하지 않음</option>{staff.filter(s=>staffCanDrive(s,vehicle)||s.id===Number(edit.driver_staff_id)).map(s=><option key={s.id} value={s.id}>{s.name}{!s.active?' (비활성)':''}</option>)}</Select></FormField>
        <FormField label="용무"><Select value={edit.purpose} onChange={e=>change('purpose',e.target.value)}><option value="">지정하지 않음</option><PurposeOptions/></Select></FormField>
        {edit.purpose==='other'&&<FormField label="기타 용무"><Input maxLength={500} value={edit.purpose_note} onChange={e=>change('purpose_note',e.target.value)}/></FormField>}
        <label className="fleet-check"><input type="checkbox" checked={edit.active} onChange={e=>change('active',e.target.checked)}/>규칙 사용</label>
        <div className="fleet-assignment-actions"><BusinessButton type="button" onClick={()=>{setEdit(null);setError('');}}>목록으로</BusinessButton><BusinessButton type="submit" primary disabled={!edit.name.trim()||(!edit.driver_staff_id&&!edit.purpose)}>{busy?'저장 중…':'규칙 저장'}</BusinessButton></div>
      </fieldset></form>}
    </div>
  </Modal>;
}

export function TripAssignmentHistory({vehicle,onClose}){
  const [rows,setRows]=useState(null),[error,setError]=useState('');
  useEffect(()=>{let live=true;api.tripAssignmentHistory(vehicle.id).then(v=>{if(live)setRows(v);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[vehicle.id]);
  return <Modal open title="운행 지정 변경 이력" size="lg" onClose={onClose}><div className="fleet-assignment">
    <p className="business-note">최근 변경 100건 · 변경 전후 값이 보존됩니다.</p>{error&&<BusinessError>{error}</BusinessError>}
    {rows===null&&!error?<p>불러오는 중…</p>:rows?.length===0?<BusinessEmpty title="아직 변경 이력이 없습니다."/>:<div className="fleet-assignment-preview">{rows?.map(r=><article key={r.id}><header><strong>{kstDateTime(r.created_at)}</strong><span>{r.actor_name||'계정 삭제됨'}</span></header>{r.action==='rule'?<><p>규칙 {r.before_value?'수정':'추가'} · {r.after_value?.name}</p><p className="business-note">{r.before_value?.active?'사용 중':r.before_value?'사용 중지':'없음'} → {r.after_value?.active?'사용 중':'사용 중지'}</p></>:<><p>운행 {kstDateTime(r.after_value?.trip_started_at)}</p><p className="business-note">변경 전: {summary(r.before_value)}</p><p>변경 후: {summary(r.after_value)}</p><small>{assignmentSource(r.after_value?.assignment_source?.source)}</small></>}</article>)}</div>}
  </div></Modal>;
}
