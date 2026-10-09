const DAY = 86400_000;
export const businessDate = (value = Date.now()) => new Date(new Date(value).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
export function businessPeriod(now = Date.now()) {
  const day = businessDate(now);
  return { day, from: `${day.slice(0, 7)}-01T00:00:00+09:00`, to: new Date(new Date(`${day}T00:00:00+09:00`).getTime() + 91 * DAY).toISOString(),
    todayStart: `${day}T00:00:00+09:00`, todayEnd: new Date(new Date(`${day}T00:00:00+09:00`).getTime() + DAY).toISOString() };
}
export const vehicleName = d => d.car_plate || d.license_plate || d.display_name || d.device_uid || `차량 ${d.id}`;
export const rentalStatus = (c, now = Date.now()) => c.status === 'active' && new Date(c.ends_at).getTime() < now ? 'overdue' : c.status;
export function rentalSummary(contracts, devices, now = Date.now()) {
  const period = businessPeriod(now), month = period.day.slice(0, 7);
  const open = contracts.filter(c => ['active', 'overdue'].includes(rentalStatus(c, now)));
  const overdue = open.filter(c => rentalStatus(c, now) === 'overdue');
  const occupied = new Set(open.filter(c => rentalStatus(c, now) === 'overdue' || new Date(c.starts_at).getTime() <= now).map(c => String(c.device_id)).filter(id => devices.some(d => String(d.id) === id)));
  // A draft is a request, not a dispatched vehicle. Disabled vehicles cannot be offered.
  const available = devices.filter(d => d.enabled !== false && !occupied.has(String(d.id)));
  const todayReturns = open.filter(c => businessDate(c.ends_at) === period.day);
  const todayPickups = contracts.filter(c => ['draft', 'active'].includes(rentalStatus(c, now)) && businessDate(c.starts_at) === period.day);
  const revenue = contracts.filter(c => c.status === 'returned' && c.settled_at && businessDate(c.settled_at).slice(0, 7) === month)
    .reduce((sum, c) => sum + (Number(c.settled_amount_krw) || 0), 0);
  return { open, overdue, occupied, available, todayReturns, todayPickups, revenue };
}
export function filterRentals(contracts, { status = 'all', deviceId, query = '' } = {}, now = Date.now()) {
  const needle = query.trim().toLowerCase();
  return contracts.filter(c => (!deviceId || String(c.device_id) === String(deviceId))
    && (status === 'all' || (status === 'active' ? ['draft', 'active'].includes(rentalStatus(c, now)) : rentalStatus(c, now) === status))
    && (!needle || [c.license_plate, c.device_name, c.renter_name, c.renter_phone].some(v => String(v || '').toLowerCase().includes(needle))));
}
export function maintenanceTasks(devices, now = Date.now()) {
  const today = businessDate(now), cutoff = businessDate(now + 30 * DAY);
  return devices.flatMap(device => [['next_service_date', '정비'], ['insurance_expiry', '보험 만료'], ['inspection_expiry', '검사 만료']]
    .filter(([field]) => device[field] && device[field] <= cutoff)
    .map(([field, label]) => ({ device, field, label, date: device[field], overdue: device[field] < today })))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Calendar cells are local Date objects representing labels, not UTC instants.
export const calendarDate = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
