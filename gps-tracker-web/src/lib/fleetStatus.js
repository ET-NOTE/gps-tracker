import { classifyDevice } from '../colors';

export const FLEET_GROUPS = [
  { id: 'all', label: '전체', tone: 'default' },
  { id: 'active', label: '통신 정상', tone: 'success' },
  { id: 'idle', label: '절전 중', tone: 'primary' },
  { id: 'attention', label: '확인 필요', tone: 'warning' },
  { id: 'offline', label: '오프라인', tone: 'muted' },
  { id: 'unknown', label: '수신 전', tone: 'muted' },
];
export function fleetStatusGroup(device, now = Date.now()) {
  const { id } = classifyDevice(device, undefined, now);
  if (id === 'active') return 'active';
  if (id === 'sleeping') return 'idle';
  if (id === 'offline' || id === 'lost') return 'offline';
  if (id === 'unknown') return 'unknown';
  return 'attention';
}
