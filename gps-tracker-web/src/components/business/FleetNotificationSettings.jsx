import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { kstDateTime } from '../../lib/businessExport';
import { notificationTopics } from '../../lib/fleetNotifications';
import Icon from '../Icon';
import { BusinessError, BusinessSection } from './BusinessWorkspace';
import { useFleetAccess } from './FleetAccess';
import { useOperatingPolicy } from './FleetReservationPolicy';
import './fleet-settings-controls.css';
import './fleet-notifications.css';

export const notificationPolicyKey = ['fleet-notification-policy'];
export const notificationResultsKey = ['fleet-notification-results'];
export function useNotificationPolicy(){
  return useQuery({queryKey: notificationPolicyKey, queryFn: api.fleetNotificationPolicy});
}

function Switch({label,hint,icon,checked,onChange,disabled}) {
  return <label className="fleet-notification-row">
    {icon && <span aria-hidden="true" className="fleet-notification-symbol"><Icon name={icon} size={19}/></span>}
    <span className="fleet-notification-label"><strong>{label}</strong><small>{hint}</small></span>
    <input className="fleet-setting-switch" role="switch" aria-label={label} type="checkbox" checked={checked} disabled={disabled} onChange={e=>onChange(e.target.checked)} />
  </label>;
}

function Mailbox() {
  const mail=useQuery({queryKey:['fleet-notification-mail-preview'],queryFn:api.fleetNotificationMailbox,refetchInterval:5000});
  return <BusinessSection title="이메일 미리보기" description="내 계정의 최근 알림 메일 5건">
    {mail.isError ? <BusinessError onRetry={mail.refetch}>이메일 미리보기를 불러오지 못했습니다.</BusinessError>
      : !mail.data?.length ? <p className="fleet-notification-empty" role="status">{mail.isPending?'불러오는 중…':'미리 볼 알림 메일이 없습니다.'}</p>
      : <ul className="fleet-mail-preview">{mail.data.map(item=><li key={item.id}><strong>{notificationTopics.find(t=>t.key===item.category)?.label} 알림</strong><time dateTime={item.at}>{kstDateTime(item.at)}</time></li>)}</ul>}
  </BusinessSection>;
}

export default function FleetNotificationSettings({onPolicy}) {
  const q=useNotificationPolicy(),operating=useOperatingPolicy(),cache=useQueryClient(),access=useFleetAccess();
  const [message,setMessage]=useState('');
  const save=useMutation({mutationFn:api.setFleetNotificationPolicy,
    onSuccess:async (data,change)=>{
      cache.setQueryData(notificationPolicyKey,data);
      await cache.invalidateQueries({queryKey:notificationResultsKey});
      const label = notificationTopics.find(t=>t.key===change.key)?.label || (change.key==='email'?'이메일':'앱 알림');
      setMessage(label+' 수신을 '+(change.enabled?'켰습니다.':'껐습니다.'));
    },
    onError:async error=>{setMessage(error.message||'알림 설정을 저장하지 못했습니다.');await q.refetch();},
  });
  if(q.isError && !q.data) return <BusinessError onRetry={q.refetch}>회사 알림 설정을 불러오지 못했습니다.</BusinessError>;
  if(!q.data) return <p role="status">회사 알림 설정을 불러오는 중…</p>;
  const p=q.data,canEdit=access.role==='owner';
  const configure=key=>({checked:p[key]===true,disabled:!canEdit||save.isPending,
    onChange:enabled=>{setMessage('');save.mutate({key,enabled,revision:p.revision});}});
  const selected=notificationTopics.filter(t=>p[t.key]).length;
  return <div className="fleet-notification-settings">
    <div className="fleet-notification-grid">
      <BusinessSection title="업무 알림" action={<small>{canEdit?'변경 즉시 저장':'회사 소유자가 수신 항목을 설정합니다.'}</small>}>
        <div className="fleet-notification-rows">
        {notificationTopics.map(({key,...topic})=><Switch key={key} {...topic} {...configure(key)}/>)}</div>
      </BusinessSection>
      <div className="fleet-notification-side">
        <BusinessSection title="수신 방법"><div className="fleet-notification-rows">
          <Switch label="앱 알림" hint="알림 목록에서 확인합니다." {...configure('in_app')}/>
          <Switch label="이메일" hint={p.email_mode==='preview'?'이메일은 미리보기로만 제공됩니다. 운행 알림은 예약 상태가 바뀔 때 생성됩니다.':p.email_available?'등록 이메일로 보냅니다. 운행 메일은 예약 상태 변경 시 생성됩니다.':'메일 발송 서버 연결이 필요합니다.'}
            {...configure('email')} disabled={!canEdit||save.isPending||(!p.email_available&&!p.email)}/></div>
        </BusinessSection>
        <BusinessSection title="현재 설정">
          <dl className="fleet-notification-summary"><div><dt>선택한 업무 알림</dt><dd>{selected}개</dd></div>
            <div><dt>수신 방법</dt><dd>{[p.in_app&&'앱 알림',p.email&&'이메일'].filter(Boolean).join(' · ')||'선택 없음'}</dd></div>
            <div><dt>단말 수신 지연 기준</dt><dd>{operating.data?.offline_minutes??'—'}분</dd></div></dl>
          {onPolicy&&<button type="button" className="fleet-notification-policy-link" onClick={onPolicy}>운영 정책에서 기준 변경 <span aria-hidden="true">→</span></button>}
        </BusinessSection>
        {p.email_mode==='preview'&&p.email&&<Mailbox/>}
      </div>
    </div>
    {message&&<p className="fleet-notification-feedback" role={save.isError?'alert':'status'}>{message}</p>}
  </div>;
}
