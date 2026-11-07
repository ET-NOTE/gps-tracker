import { maintenanceTasks, rentalStatus, rentalSummary, vehicleName } from './business.js';

export const RENTAL_SIGNAL_DELAY_MS = 6 * 3600_000;
export function rentalAttention(contracts, devices, now = Date.now()) {
  const summary = rentalSummary(contracts, devices, now);
  const task = (c, category, label, tone, date, action, priority) => ({
    id: `${category}-${c.id}`, category, title: c.license_plate || c.device_name || `차량 ${c.device_id}`,
    description: c.renter_name, contract: c, label, tone, date, action, priority,
  });
  const tasks = summary.overdue.map(c => task(c, 'return', '반납 지연', 'urgent', c.ends_at, '반납 처리', 0));
  for (const device of devices) {
    if (device.enabled === false || !summary.occupied.has(String(device.id))) continue;
    const seen = device.last_seen_at ? Date.parse(device.last_seen_at) : NaN;
    if (Number.isFinite(seen) && now - seen < RENTAL_SIGNAL_DELAY_MS) continue;
    tasks.push({ id: `signal-${device.id}`, category: 'signal', title: vehicleName(device), device,
      description: Number.isFinite(seen) ? '임대 중 · 6시간 이상 새 통신 없음. 전원과 연결 상태를 확인하세요.' : '임대 중 · 통신 기록이 없습니다. 전원과 연결 상태를 확인하세요.',
      label: '통신 확인', tone: 'urgent', date: Number.isFinite(seen) ? device.last_seen_at : null, action: '차량 확인', priority: 1 });
  }
  tasks.push(...maintenanceTasks(devices.filter(d => d.enabled !== false), now).filter(t => t.overdue).map(t => ({
    id: `maintenance-${t.device.id}-${t.field}`, category: 'maintenance', title: vehicleName(t.device), device: t.device,
    description: `${t.label} 기한이 지났습니다. 점검 후 차량 정보를 갱신하세요.`, date: `${t.date}T00:00:00+09:00`,
    label: '점검 기한 경과', tone: 'urgent', action: '점검 확인', priority: 2,
  })));
  tasks.push(...summary.todayReturns.filter(c => rentalStatus(c, now) !== 'overdue').map(c => task(c, 'return', '오늘 반납', 'info', c.ends_at, '반납 처리', 3)));
  tasks.push(...summary.todayPickups.map(c => task(c, 'pickup', c.status === 'draft' ? '출고 확인' : '오늘 출고', 'good', c.starts_at, '계약 확인', 4)));
  return tasks.sort((a, b) => a.priority - b.priority || (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0) || a.id.localeCompare(b.id));
}

export function upcomingReservation(reservations, now = Date.now()) {
  return reservations.filter(r => r.status === 'planned' && Date.parse(r.starts_at) > now)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))[0] || null;
}
