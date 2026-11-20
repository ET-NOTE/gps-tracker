import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { classifyDevice } from '../../colors';
import { deviceBattery } from '../../lib/battery';
import { kstDateTime } from '../../lib/businessExport';
import { corporateAttention, corporateVehicleName } from '../../lib/corporateOverview';
import { notificationDecisions, selectedAttention } from '../../lib/fleetNotifications';
import { BusinessButton, BusinessError } from './BusinessWorkspace';
import { notificationResultsKey, useNotificationPolicy } from './FleetNotificationSettings';
import FleetNotificationTrips from './FleetNotificationTrips';

export default function FleetNotificationList({devices,vehicleStatus,now,onVehicle,onVisit,canOpenSettings}) {
  const q=useNotificationPolicy(),policy=q.data;
  const results=useQuery({queryKey:notificationResultsKey,queryFn:api.fleetNotificationResults,
    enabled:!!policy?.in_app && !!(policy.reservation||policy.trip||policy.expense),refetchInterval:30000});
  if(q.isError) return <BusinessError onRetry={q.refetch}>회사 알림 설정을 불러오지 못했습니다.</BusinessError>;
  if(!policy) return <p role="status">알림 설정을 불러오는 중…</p>;
  const attention=selectedAttention(corporateAttention(devices,now,{classify:classifyDevice,battery:deviceBattery}),policy);
  const decisions=notificationDecisions(results.data||[],policy);
  const withDecisions=policy.reservation||policy.expense||policy.trip;
  const withVehicles=policy.connection||policy.maintenance;
  return <div className="fleet-quick-panel fleet-notification-list">
    {!policy.in_app?<p role="status">이 회사의 앱 알림이 꺼져 있습니다.</p>:<>
      {policy.trip&&<FleetNotificationTrips devices={devices} now={now} onVehicle={onVehicle}/>}
      {decisions.length>0&&<section><h3>최근 7일 업무 알림</h3>{decisions.map(n=>{
        const vehicle=devices.find(d=>String(d.id)===String(n.vehicle_id));
        return <button type="button" key={n.category+'-'+n.id} onClick={()=>onVisit(n.category==='expense'?'expenses':'reservations')}>
          <strong>{n.label}</strong><small>{[vehicle&&corporateVehicleName(vehicle),kstDateTime(n.at)].filter(Boolean).join(' · ')}</small>
        </button>;
      })}</section>}
      {attention.length>0&&<section><h3>차량 확인 사항</h3>{attention.map(n=>
        <button type="button" key={n.id} onClick={()=>onVehicle(n.device)}><strong>{n.label}</strong>
          <small>{corporateVehicleName(n.device)} · {n.description}</small></button>)}</section>}
      {withDecisions&&results.isError&&<BusinessError onRetry={results.refetch}>예약·지출 처리 결과를 불러오지 못했습니다.</BusinessError>}
      {withVehicles&&vehicleStatus==='error'&&<p role="status">차량 정보를 불러오지 못했습니다.</p>}
      {!attention.length&&!decisions.length&&!(withDecisions&&results.isError)&&!(withVehicles&&vehicleStatus==='error')&&
        <p role="status">{(withDecisions&&results.isPending)||(withVehicles&&vehicleStatus!=='ready')?'운영 알림을 확인하는 중…':'표시할 운영 알림이 없습니다.'}</p>}
    </>}
    {canOpenSettings&&<BusinessButton className="business-button fleet-notification-link" icon="settings" onClick={()=>onVisit('settings','notifications')}>알림 설정</BusinessButton>}
  </div>;
}
