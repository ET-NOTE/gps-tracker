import { businessDate } from './business.js';
import { purposeLabel,tripDriverKey } from './businessExport.js';
import { reportIncluded } from './tripQuality.js';
import { fleetAssetLabel } from './fleetAssets.js';
import { expenseDepartmentKey } from './fleetExpenses.js';

export const analyticGroups = {
  trips: {vehicle:'차량', driver:'운전자', department:'차량 부서'},
  costs: {category:'지출 항목', vehicle:'차량', department:'지출 부서'},
};

export function analyticsPeriodError(from, to) {
  const day = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const stamp = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(stamp) && new Date(stamp).toISOString().startsWith(value) ? stamp : NaN;
  };
  const span = (day(to) - day(from)) / 86400000;
  if (!Number.isFinite(span) || span < 0) return '시작일과 종료일을 확인해 주세요.';
  return span >= 366 ? '조회 기간은 시작일과 종료일을 포함해 최대 366일입니다.' : '';
}

export function tripAnalyticsRows(trips, device) {
  const vehicle = String(device.id);
  const vehicleLabel = device.asset ? fleetAssetLabel(device.asset) : device.license_plate || device.vehicle_name || `차량 ${device.id}`;
  return trips.filter(reportIncluded).map(trip => {
    const annotation = trip.annotation || {};
    const driverLabel = annotation.driver_name || '운전자 미지정';
    const category = annotation.purpose || 'unspecified';
    return {
      date:businessDate(trip.started_at), amount:trip.distance_m / 1000,
      minutes:Number.isFinite(trip.duration_min) ? trip.duration_min : (Date.parse(trip.ended_at) - Date.parse(trip.started_at)) / 60000,
      vehicle, vehicleLabel, driver:tripDriverKey(annotation), driverLabel,
      category:annotation.company_purpose_id==null?category:'company:'+annotation.company_purpose_id,
      categoryLabel:annotation.company_purpose_name || purposeLabel[category] || '미분류',
      department:String(device.asset?.department_id ?? device.department ?? 'unassigned'), departmentLabel:device.department || '부서 미지정',
    };
  });
}

export function costAnalyticsRows(expenses) {
  return expenses.map(row => ({
    date:row.spent_on, amount:row.amount_krw, minutes:0,
    vehicle:String(row.vehicle_id ?? 'general'), vehicleLabel:row.vehicle_name || '일반 지출',
    category:String(row.category_id), categoryLabel:[row.group_name,row.category_name].filter(Boolean).join(' · ') || '미분류',
    department:expenseDepartmentKey(row), departmentLabel:row.department_name || '부서 미지정',
  }));
}

export function groupAnalytics(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    const id = row[field];
    const group = groups.get(id) || {id,label:row[field+'Label'],count:0,amount:0,minutes:0};
    group.count++;
    group.amount += row.amount;
    group.minutes += row.minutes;
    groups.set(id, group);
  }
  return [...groups.values()].sort((a,b) => b.amount - a.amount || a.label.localeCompare(b.label,'ko'));
}

export function trendSeries(rows, from, to, count = false) {
  const first = Date.parse(from+'T00:00:00Z'), last = Date.parse(to+'T00:00:00Z');
  const monthly = last - first > 62 * 86400000;
  const buckets = new Map();
  for (let stamp = first; stamp <= last; stamp += 86400000) {
    buckets.set(new Date(stamp).toISOString().slice(0,monthly ? 7 : 10), 0);
  }
  for (const row of rows) {
    const key = row.date.slice(0,monthly ? 7 : 10);
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + (count ? 1 : row.amount));
  }
  return [...buckets].map(([date,value]) => ({date,value}));
}
