import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { useStaff } from '../../state';
import { usePurposes } from './CompanyPurposePicker';
import { useFleetAssets } from './FleetAssets';
import { BusinessSection } from './BusinessWorkspace';

// Company usage at a glance (mockup "서비스 이용 현황"). The bars show the share of active items;
// plan limits are not part of the service, so no "n / limit" is shown.
export default function FleetServiceUsage({ subscription }) {
  const assets = useFleetAssets(), staff = useStaff(), purposes = usePurposes();
  const groups = useQuery({ queryKey: ['fleet-permission-groups'], queryFn: () => api.fleetPermissionGroups(), retry: false });
  const vehicles = assets.data || [], people = staff.data || [];
  const activeVehicles = vehicles.filter(v => v.enabled).length, activePeople = people.filter(p => p.active).length;
  const terminals = new Set(vehicles.flatMap(v => (v.bindings || []).filter(b => !b.ended_at).map(b => b.device_id))).size;
  const purposeList = purposes.data?.items || purposes.data || [];
  const val = (ready, text) => ready ? text : '—';
  const bar = (label, active, total, unit, ready) => <div className="fleet-usage-bar">
    <div><span>{label}</span><strong>{val(ready, `${total}${unit}`)}<small>{ready && total ? ` · 사용 중 ${active}${unit}` : ''}</small></strong></div>
    <i aria-hidden="true"><b style={{ width: (total ? 100 * active / total : 0) + '%' }}/></i>
  </div>;
  return <BusinessSection className="fleet-service-usage" title="서비스 이용 현황" description="현재 등록된 차량과 사용자 수입니다."
    action={subscription && <span className={'business-badge ' + (subscription.active ? 'info' : '')}>{subscription.active ? '리포트 이용 중' : '리포트 미사용'}</span>}>
    {bar('등록 차량', activeVehicles, vehicles.length, '대', Boolean(assets.data))}
    {bar('등록 사용자', activePeople, people.length, '명', Boolean(staff.data))}
    <dl className="fleet-usage-facts">
      <div><dt>연결 단말</dt><dd>{val(Boolean(assets.data), terminals + '대')}</dd></div>
      <div><dt>권한 그룹</dt><dd>{4 + (groups.data?.length || 0)}개</dd></div>
      <div><dt>사용 중인 운행 목적</dt><dd>{val(Boolean(purposes.data), (Array.isArray(purposeList) ? purposeList.filter(p => p.active !== false).length : 0) + '개')}</dd></div>
    </dl>
  </BusinessSection>;
}
