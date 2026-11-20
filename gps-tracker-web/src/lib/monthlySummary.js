import { reportIncluded } from './tripQuality.js';

export function summarizeMonthlyTrips(trips) {
  const result = { totalKm: 0, businessKm: 0, personalKm: 0, includedCount: 0,
    excludedCount: 0, annotationCost: 0, annotationCount: 0 };
  for (const trip of trips) {
    // A recorded expense exists independently of whether GPS distance is usable.
    if (Number.isFinite(trip.annotation?.fuel_cost) && trip.annotation.fuel_cost >= 0) {
      result.annotationCost += trip.annotation.fuel_cost;
      result.annotationCount++;
    }
    if (!reportIncluded(trip)) { result.excludedCount++; continue; }
    result.includedCount++;
    const km = trip.distance_m / 1000;
    result.totalKm += km;
    if (['business', 'commute'].includes(trip.annotation?.purpose)) result.businessKm += km;
    else result.personalKm += km;
  }
  return result;
}

export function monthlyDistance(km, includedCount) {
  if (includedCount === 0 || !Number.isFinite(km)) return '—';
  if (km > 0 && km < 0.01) return '<0.01';
  return km.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
}

export function monthlyPercentages(row) {
  if (!(row.totalKm > 0) || row.includedCount === 0) return { business: null, other: null };
  const business = Math.round(row.businessKm / row.totalKm * 100);
  return { business, other: 100 - business };
}

export function monthlyExportDistance(km, includedCount) {
  if (includedCount === 0) return '';
  return km > 0 && km < 0.01 ? '<0.01' : Number(km.toFixed(2));
}

export function monthlyStatus(row) {
  if (row.includedCount === 0) return row.excludedCount ? `확정 기록 없음 · 합계 제외 ${row.excludedCount}건` : '운행 기록 없음';
  return `확정 ${row.includedCount}건 · 합계 제외 ${row.excludedCount}건`;
}
