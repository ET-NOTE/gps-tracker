import { businessDate, rentalStatus, rentalSummary, vehicleName } from './business.js';
import { rentalAttention } from './businessAttention.js';
import { isAssigned, matchesVehicle } from './rentalInventory.js';
import { addBusinessDays } from './businessWorkspace.js';

export const repairNames = { cleaning: '세차', maintenance: '정비', inspection: '점검', accident: '사고', breakdown: '고장' };
export const isIncident = kind => kind === 'accident' || kind === 'breakdown';
export const workState = item => isIncident(item.kind) && item.closed_at && !item.inspection_released_at
  ? 'review' : item.closed_at ? 'done' : 'open';
export const workStageName = item => ({ open: isIncident(item.kind) ? '처리 중' : '예정·진행', review: '조치 후 점검', done: '완료' })[workState(item)];
export const rentalFleetLabel = device => device.car_plate || device.license_plate || vehicleName(device);
export const sameId = (one, two) => one != null && two != null && String(one) === String(two);

export function vehicleReadiness(device, work, summary, now) {
  const pending = work.filter(item => matchesVehicle(item,device) && workState(item) !== 'done');
  const incident = pending.find(item => isIncident(item.kind) && !item.closed_at);
  const review = pending.some(item => workState(item) === 'review');
  const service = pending.find(item => !isIncident(item.kind) && Date.parse(item.starts_at) <= now && (item.return_inspection || Date.parse(item.ends_at) > now));
  if (device.enabled === false) return { code: 'hold', label: '운영 중지' };
  if (incident) return { code: 'hold', label: repairNames[incident.kind] + ' 처리 중' };
  if (review) return { code: 'hold', label: '조치 후 점검' };
  if (device.rental_profile?.readiness === 'hold') return { code: 'hold', label: '배차 보류' };
  if (summary.occupied.has(String(device.id))) return { code: 'active', label: '대여 중' };
  if (service) return { code: 'service', label: repairNames[service.kind] + ' 중' };
  return { code: 'ready', label: '대여 가능' };
}

export function fleetDashboard(contracts, devices, work, now) {
  const today = businessDate(now), summary = rentalSummary(contracts, devices, now);
  const retained = contracts.filter(row => row.status !== 'cancelled');
  const pickups = [], returns = [], trend = [];
  for (const row of retained) {
    const start = row.rental_terms?.checkout_at || row.starts_at;
    const end = row.returned_at || row.ends_at;
    if (businessDate(start) === today) pickups.push({ at: start, type: '출고', row });
    if (businessDate(end) === today) returns.push({ at: end, type: '반납', row });
  }
  for (let n = -6; n <= 0; n++) {
    const day = addBusinessDays(today, n);
    trend.push({ day, count: retained.filter(row => businessDate(row.rental_terms?.checkout_at || row.starts_at) === day).length });
  }
  const attention = rentalAttention(retained, devices, now);
  const actions = [
    { key: 'assign', label: '배차가 필요한 예약', icon: 'car', rows: retained.filter(row => row.status === 'draft' && !isAssigned(row)).map(contract => ({ contract })) },
    { key: 'pickup', label: '오늘 출고 확인', icon: 'file', rows: pickups.filter(event => event.row.status === 'draft').map(event => ({ contract: event.row })) },
    { key: 'return', label: '반납 시간이 지난 차량', icon: 'clock', rows: summary.overdue.map(contract => ({ contract })) },
    { key: 'care', label: '세차·점검 및 사고 조치', icon: 'wrench', rows: work.filter(item => workState(item) !== 'done' && Date.parse(item.starts_at) <= now).map(item => ({ item })).concat(attention.filter(task => task.category === 'maintenance')) },
    { key: 'signal', label: '단말 수신 확인', icon: 'antenna', rows: attention.filter(task => task.category === 'signal') },
  ];
  const counts = { ready: 0, active: 0, service: 0, hold: 0 };
  for (const device of devices) counts[vehicleReadiness(device, work, summary, now).code]++;
  return { summary, pickups, returns, trend, actions, counts, taskCount: actions.reduce((sum, task) => sum + task.rows.length, 0),
    timeline: [...pickups, ...returns].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) };
}

export function contractStage(row, now) {
  const status = rentalStatus(row, now);
  return ({ draft: isAssigned(row) ? '출고 준비' : '배차 대기', active: '대여 중', overdue: '반납 지연', returned: '반납 완료', cancelled: '취소' })[status] || status;
}

export function kstInput(value) {
  const d = Date.parse(value);
  return Number.isFinite(d) ? new Date(d + 9 * 3600000).toISOString().slice(0, 16) : '';
}
