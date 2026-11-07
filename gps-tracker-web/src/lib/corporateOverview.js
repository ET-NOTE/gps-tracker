import { businessDate, maintenanceTasks } from './business.js';
import { validPosition } from './businessWorkspace.js';

export const LOCATION_FRESH_MS = 5 * 60_000;
export const corporateVehicleName = d => d.vehicle_name || d.car_model || d.car_plate || d.license_plate || '차량 정보 미등록';
export const terminalName = d => d.display_name || d.device_uid || `단말 ${d.id}`;

export function locationState(device, now = Date.now()) {
  if (!validPosition(device)) return 'none';
  const at = Date.parse(device.last_fix_at), age = now - at;
  // Unknown and future timestamps cannot establish freshness.
  return Number.isFinite(at) && age >= 0 && age <= LOCATION_FRESH_MS ? 'current' : 'old';
}
export function locationSummary(devices, now = Date.now()) {
  return devices.reduce((counts, d) => { counts[locationState(d, now)]++; return counts; }, { current: 0, old: 0, none: 0 });
}
export const missingMaintenance = devices => devices.filter(d => ['next_service_date', 'insurance_expiry', 'inspection_expiry'].some(key => !d[key]));

// Only count this workspace's vehicles, never other account types returned by
// the account-wide endpoint. A daily aggregate needs two fixes to measure distance.
export function fleetDistance(devices, rows, now = Date.now()) {
  const byId = new Map((rows || []).map(r => [String(r.device_id), r]));
  const day = businessDate(now);
  let todayM = 0, monthM = 0, measured = 0, pending = 0, noData = 0;
  const lastFixes = [], updated = [];
  for (const d of devices || []) {
    const r = byId.get(String(d.id));
    monthM += Math.max(0, Number(r?.total_distance_m) || 0);
    const distance = r?.today_distance_m;
    if (r?.today_fix_count >= 2 && typeof distance === 'number' && Number.isFinite(distance) && distance >= 0) {
      todayM += distance; measured++;
      if (r.today_last_fix_at) lastFixes.push(r.today_last_fix_at);
      if (r.today_updated_at) updated.push(r.today_updated_at);
    } else {
      const at = Date.parse(d.last_fix_at);
      if (r?.today_fix_count > 0 || Number.isFinite(at) && at <= now && businessDate(at) === day) pending++;
      else noData++;
    }
  }
  return { todayKm: measured ? Math.round(todayM / 100) / 10 : null, monthKm: Math.round(monthM / 1000),
    measured, pending, noData, partial: measured > 0 && measured < (devices?.length || 0),
    lastFixAt: lastFixes.sort().at(-1) || null, updatedAt: updated.sort().at(-1) || null };
}

// Merge nearby screen labels. Anchor-relative grouping avoids a long chain of
// vehicles collapsing into one group. Stable ID order keeps redraws predictable.
export function groupMapPositions(items, width = 154, height = 46) {
  const groups = [];
  for (const item of [...items].sort((a, b) => String(a.device.id).localeCompare(String(b.device.id)))) {
    const group = groups.find(g => Math.abs(g.x - item.x) < width && Math.abs(g.y - item.y) < height);
    if (group) group.items.push(item);
    else groups.push({ x: item.x, y: item.y, items: [item] });
  }
  return groups;
}

export function corporateAttention(devices, now, { classify, battery }) {
  const tasks = [];
  for (const d of devices) {
    const status = classify(d, undefined, now), b = battery(d);
    if (['offline', 'lost', 'unknown'].includes(status.id)) tasks.push({ id: `signal-${d.id}`, device: d, priority: 0, label: '통신 확인', description: d.last_seen_at ? '장기간 새 통신 없음' : '통신 이력 없음', tone: 'urgent' });
    if (['low', 'critical', 'overcharge'].includes(b.state)) tasks.push({ id: `battery-${d.id}`, device: d, priority: 1, label: b.label, description: `마지막 배터리 ${b.percent}% · ${b.voltage}`, tone: b.state === 'low' ? 'info' : 'urgent' });
  }
  for (const t of maintenanceTasks(devices, now)) tasks.push({ ...t, id: `maintenance-${t.device.id}-${t.field}`, priority: t.overdue ? 2 : 3, label: t.overdue ? '점검 기한 경과' : '점검 임박', description: `${t.label} · ${t.date}`, tone: t.overdue ? 'urgent' : 'info' });
  return tasks.sort((a, b) => a.priority - b.priority || String(a.id).localeCompare(String(b.id)));
}
