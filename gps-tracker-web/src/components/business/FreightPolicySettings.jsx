import { useRef, useState } from 'react';
import { FreightField, FreightButton } from './FreightKit';
import { record } from '../../lib/freightWorkflow';

const policyGroups = [
  {title:'배차 기준', fields:[
    ['ownAutoConfirm','자사 차량 배차 시 바로 확정'],
    ['requireDriverCheck','배차 전 기사 면허 확인'],
    ['bufferMinutes','운송 사이 준비 시간',0,1440],
    ['acceptTimeoutMinutes','수락 대기 기준',1,1440],
  ]},
  {title:'완료·관제 기준', fields:[
    ['requireProofForBilling','청구 전 인수증 확인'],
    ['offlineMinutes','단말 수신 지연 기준',1,240],
  ]},
];
const noticeGroups=[{title:'알림 표시',fields:[
  ['dispatchNotice','배차 수락 대기'],['delayNotice','운송 지연·사고'],['proofNotice','인수증 확인'],['connectionNotice','단말 수신 지연'],
]}];
const connections=[
  ['차량 단말기','연결된 단말의 위치와 수신 시각을 조회합니다.','cargo-devices','단말기 관리'],
  ['기사 앱','직원 초대와 업무 접근 범위를 관리합니다.','users','사용자 목록'],
  ['전자 세금계산서','청구·수납 기록을 조회하고 CSV로 내려받을 수 있습니다. 세금계산서 발행은 별도로 진행합니다.','cargo-billing','청구·수납'],
  ['외부 화물망','운송 주문 목록에서 CSV 파일로 주문을 일괄 등록할 수 있습니다.','cargo-orders','운송 주문'],
];

export default function FreightPolicySettings({policy,data,save,onPage}) {
  const area=policy?'policies':'integrations', groups=policy?policyGroups:noticeGroups;
  const [busy,setBusy]=useState(false), [message,setMessage]=useState(''),[error,setError]=useState(false);
  const lock=useRef(false);
  async function submit(event) {
    event.preventDefault();
    if(lock.current)return;
    const form=new FormData(event.currentTarget), next=structuredClone(data);
    for(const {fields} of groups)for(const [key,,min] of fields)next[area][key]=min==null?form.has(key):Number(form.get(key));
    lock.current=true;setBusy(true);setError(false);setMessage('');
    try {
      record(next,null,policy?'배차·운송 정책 변경':'알림 설정 변경');
      await save(next);setMessage('저장했습니다.');
    }catch(err){setError(true);setMessage(err.message||'설정을 저장하지 못했습니다.');}
    finally{lock.current=false;setBusy(false);}
  }
  return <div className="fr-page">
    <form className="fr-section" onSubmit={submit}>
      <div className="fr-toolbar"><div className="fr-actions">
        {!policy&&<FreightButton onClick={()=>onPage('cargo-dashboard')}>운영현황 보기</FreightButton>}
        <button className="fr-btn is-primary" type="submit" disabled={busy}>{busy?'저장 중…':policy?'정책 저장':'알림 설정 저장'}</button>
      </div></div>
      <div className="fr-setting-grid">{groups.map(group=><section className="fr-dashboard-card" key={group.title}>
        <header><h2>{group.title}</h2></header><div className="fr-settings">{group.fields.map(([key,label,min,max])=>min==null?
          <label key={key} className="fr-setting-row"><span>{label}</span><input type="checkbox" name={key} defaultChecked={data[area][key]}/></label>:
          <FreightField key={key} label={label+' (분)'}><input name={key} type="number" required min={min} max={max} defaultValue={data[area][key]}/></FreightField>)}</div>
      </section>)}</div>
      {message&&<p role={error?'alert':'status'} className={error?'fr-error':'fr-note'}>{message}</p>}
    </form>
    {!policy&&<div className="fr-setting-grid">{connections.map(([title,text,page,label])=><section className="fr-dashboard-card" key={title}>
      <header><h2>{title}</h2></header><div className="fr-settings"><p className="fr-note">{text}</p><FreightButton onClick={()=>onPage(page)}>{label}</FreightButton></div>
    </section>)}</div>}
  </div>;
}
