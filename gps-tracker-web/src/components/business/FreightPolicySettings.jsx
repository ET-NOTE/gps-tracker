import { useRef, useState } from 'react';
import { FreightField, FreightButton } from './FreightKit';
import { record } from '../../lib/freightWorkflow';
import useCorporatePhone from '../../useCorporatePhone';
import { hideOutsideMockup } from '../../lib/mockupHidden';

const policyGroups = [
  {title:'배차 기준', description:'저장 후 새 배차와 이후 업무 확인에 적용됩니다.', fields:[
    ['bufferMinutes','운송 사이 준비 시간',0,1440],
    ['acceptTimeoutMinutes','협력사 수락 대기 기준',1,1440],
    ['ownAutoConfirm','자사 차량은 담당자 배정 시 바로 확정'],
    ['requireDriverCheck','배차 전에 운전자 확인 상태 검사'],
  ]},
  {title:'완료·관제 기준', description:'운송 상태와 위치 수신 상태는 각각 관리합니다.', note:'단말기의 정차나 위치 도착만으로 상·하차 완료를 처리하지 않습니다. 작업 완료는 별도 기록으로 확인합니다.', fields:[
    ['offlineMinutes','단말 수신 지연 기준',1,240],
    ['requireProofForBilling','청구 확인 전에 인수증 검토 완료 필요'],
  ]},
];
const noticeGroups=[{title:'알림 표시',description:'상단 알림 패널에 표시할 업무 항목을 선택합니다.',note:'현재 표시 채널: 앱 알림 · 문자와 이메일은 발송하지 않습니다.',fields:[
  ['dispatchNotice','배차 요청·수락 대기'],['delayNotice','운송 지연·긴급 이슈'],['proofNotice','인수증 미제출·확인 대기'],['connectionNotice','단말 수신 확인 필요'],
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
  // Desktop design: the policy save button sits below the panels and checkboxes lead their labels.
  const mockup=!useCorporatePhone()&&hideOutsideMockup&&policy;
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
  const toolbar=<div className="fr-toolbar"><div className="fr-actions">
        {!policy&&<FreightButton onClick={()=>onPage('cargo-dashboard')}>운영현황 보기</FreightButton>}
        <button className="fr-btn is-primary" type="submit" disabled={busy}>{busy?'저장 중…':policy?'정책 저장':'알림 설정 저장'}</button>
      </div></div>;
  return <div className="fr-page">
    <form className="fr-section" data-mockup={mockup||undefined} onSubmit={submit}>
      {!mockup&&toolbar}
      <div className="fr-setting-grid">{groups.map(group=><section className="fr-dashboard-card" key={group.title}>
        <header><div><h2>{group.title}</h2>{group.description&&<p className="fr-setting-description">{group.description}</p>}</div></header><div className="fr-settings">{group.fields.map(([key,label,min,max])=>min==null?
          <label key={key} className={'fr-setting-row'+(mockup?' is-leading':'')}>{mockup&&<input type="checkbox" name={key} defaultChecked={data[area][key]}/>}<span>{label}</span>{!mockup&&<input type="checkbox" name={key} defaultChecked={data[area][key]}/>}</label>:
          <FreightField key={key} label={label+' (분)'}><input name={key} type="number" required min={min} max={max} defaultValue={data[area][key]}/></FreightField>)}{group.note&&<p className="fr-note">{group.note}</p>}</div>
      </section>)}</div>
      {message&&<p role={error?'alert':'status'} className={error?'fr-error':'fr-note'}>{message}</p>}
      {mockup&&toolbar}
    </form>
    {!policy&&<div className="fr-setting-grid">{connections.map(([title,text,page,label])=><section className="fr-dashboard-card" key={title}>
      <header><h2>{title}</h2></header><div className="fr-settings"><p className="fr-note">{text}</p><FreightButton onClick={()=>onPage(page)}>{label}</FreightButton></div>
    </section>)}</div>}
  </div>;
}
