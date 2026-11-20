import {useEffect,useState} from 'react';
import {api} from '../api';
import Button from './ui/Button';
import FormField,{Input,Select} from './ui/FormField';
export function reportSettingStatus(stationary,desired) {
  if(stationary?.sleep_report_remote!==true || stationary?.timer_wake_enabled!==true) return {kind:'upgrade',text:'원격 설정을 지원하는 운영 펌웨어로 갱신해야 적용됩니다.'};
  if(stationary.sleep_report_saved!==true) return {kind:'pending',text:'단말기 저장 확인 대기 · 다음 통신에서 다시 적용합니다.'};
  if(stationary.timer_wake_s!==desired) return {kind:'pending',text:'적용 대기 · 단말기의 다음 통신에서 전달합니다.'};
  return {kind:'applied',text:'단말기 적용 확인'};
}
function period(s) { return s%3600===0 ? `${s/3600}시간` : `${s/60}분`; }
export default function SleepReportSettings({device,meta,onUpdated}) {
  const initial=device.sleep_report_interval_s || 86400;
  const [saved,setSaved]=useState(initial),[draft,setDraft]=useState({minutes:String(initial/60),dirty:false});
  const {minutes,dirty}=draft;
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(null);
  useEffect(()=>{const next=device.sleep_report_interval_s || 86400;setSaved(next);setDraft(prev=>prev.dirty?prev:{minutes:String(next/60),dirty:false});},[device.sleep_report_interval_s]);
  if(device.device_kind==='phone') return null;
  const n=Number(minutes),valid=/^\d+$/.test(minutes)&&Number.isSafeInteger(n)&&n>=1&&n<=1440;
  const state=reportSettingStatus(meta?.stationary ?? device.last_stationary,saved);
  async function save(e){
    e.preventDefault();if(busy||!valid)return;
    setBusy(true);setMessage(null);
    try{
      const updated=await api.setDeviceSleepReportInterval(device.id,n*60);
      setSaved(updated.sleep_report_interval_s);setDraft({minutes:String(updated.sleep_report_interval_s/60),dirty:false});onUpdated?.(updated);
      setMessage({ok:true,text:'서버에 저장했습니다. 단말기 적용 상태는 다음 수신에서 확인합니다.'});
    }catch{setMessage({ok:false,text:'저장하지 못했습니다. 입력값을 확인하고 다시 시도해 주세요.'});}
    finally{setBusy(false);}
  }
  return <form onSubmit={save} style={{display:'grid',gap:12,minWidth:0}}>
    <p style={{margin:0,fontSize:13,lineHeight:1.7,color:'var(--text-2)'}}>절전 중 정기 보고 간격입니다. 움직임이 감지되면 설정한 시간을 기다리지 않고 깨어납니다.</p>
    <fieldset disabled={busy} style={{border:0,padding:0,margin:0,display:'grid',gap:10,minWidth:0}}>
      <FormField label="정기 보고 간격" hint="1분~24시간 · 기본 24시간">
        <Select value={[10,30,60,180,360,720,1440].includes(n)?String(n):'custom'} onChange={e=>{setDraft({minutes:e.target.value==='custom'?'':e.target.value,dirty:true});}}>
          {[10,30,60,180,360,720,1440].map(m=><option key={m} value={m}>{period(m*60)}{m===1440?' (기본)':''}</option>)}<option value="custom">직접 입력</option>
        </Select>
      </FormField>
      <FormField label="직접 설정 (분)" error={dirty&&!valid?'1~1440 사이의 정수를 입력해 주세요.':null}>
        <Input type="number" min="1" max="1440" step="1" value={minutes} onChange={e=>{setDraft({minutes:e.target.value,dirty:true});}} />
      </FormField>
      <Button type="submit" busy={busy} disabled={!valid||!dirty}>보고 주기 저장</Button>
    </fieldset>
    <div role="status" style={{padding:12,borderRadius:10,background:'var(--surface-2)',fontSize:12,lineHeight:1.7}}>
      <strong>서버 설정: {period(saved)}</strong><br/>{state.text}
      {state.kind==='applied'&&<span> · {period(saved)}</span>}
    </div>
    {message&&<p role={message.ok?'status':'alert'} style={{margin:0,fontSize:12,color:message.ok?'var(--text-2)':'var(--danger)'}}>{message.text}</p>}
    <p style={{margin:0,fontSize:12,lineHeight:1.7,color:'var(--text-3)'}}>단말기가 절전 중이면 즉시 바뀌지 않습니다. 다음 통신에서 받은 값을 저장한 뒤, 그다음 절전부터 사용합니다. 휴대폰 알림 ON/OFF는 내정보의 알림 설정에서 별도로 조절합니다.</p>
  </form>;
}
