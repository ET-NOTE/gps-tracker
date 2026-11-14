import { businessDate, rentalStatus } from './business.js';

export const addBusinessDays = (day, count) => businessDate(new Date(`${day}T00:00:00+09:00`).getTime() + count * 86400000);
export const boardDays = start => Array.from({ length: 7 }, (_, i) => addBusinessDays(start, i));
export function validPosition(device) {
  const { last_lat: lat, last_lng: lng } = device;
  return [lat, lng].every(v => (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(Number(v)))
    && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180 && !(Number(lat) === 0 && Number(lng) === 0);
}
// Half-open intervals: a midnight return does not reserve the next day. Overdue
// contracts continue occupying a vehicle through today until a return is confirmed.
export function rentalOnDay(contract, day, now = Date.now()) {
  if (contract.status === 'cancelled') return false;
  const start = new Date(`${day}T00:00:00+09:00`).getTime();
  const finish = rentalStatus(contract, now) === 'overdue'
    ? Math.max(new Date(contract.ends_at).getTime(), now + 1) : new Date(contract.ends_at).getTime();
  return new Date(contract.starts_at).getTime() < start + 86400000 && finish > start;
}
export function tripCompleteness(trips) {
  const missingPurpose = trips.filter(t => !t.annotation?.purpose || t.annotation.purpose === 'unspecified').length;
  const missingDriver = trips.filter(t => t.annotation?.driver_staff_id == null && !t.annotation?.driver_name?.trim()).length;
  const complete = trips.filter(t => t.annotation?.purpose && t.annotation.purpose !== 'unspecified'
    && (t.annotation.driver_staff_id != null || t.annotation.driver_name?.trim())).length;
  const recordedFuel = trips.filter(t => t.annotation?.fuel_cost != null && Number.isFinite(Number(t.annotation.fuel_cost)));
  return { total: trips.length, complete, percent: trips.length ? Math.round(complete / trips.length * 100) : null,
    missingPurpose, missingDriver, fuelEntries: recordedFuel.length,
    fuelCost: recordedFuel.reduce((sum, t) => sum + Number(t.annotation.fuel_cost), 0) };
}
