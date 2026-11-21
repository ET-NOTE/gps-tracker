import { matchesVehicle } from './rentalInventory.js';
export const entryKinds = { payment: '이용료 수납', refund: '이용료 환불', deposit_in: '보증금 수납', deposit_out: '보증금 반환' };
export const methods = { card: '카드', cash: '현금', transfer: '계좌이체' };
export const costKinds = { wash: '세차', repair: '정비', fuel: '주유·충전', insurance: '보험', other: '기타' };
export const won = value => Number(value || 0).toLocaleString('ko-KR') + '원';
export const kstInput = (date = Date.now()) => new Date(new Date(date).getTime() + 9 * 3600000).toISOString().slice(0,16);
export const kstDay = date => kstInput(date).slice(0,10);
export const readTime = date => date ? kstInput(date).replace('T',' ') : '—';
export const initialPeriod = () => {
  const today = kstDay();
  return { from: today.slice(0,7) + '-01', to: today };
};
export const periodOk = ({from,to}) => {
  if (!from || !to) return false;
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  return days >= 0 && days <= 366;
};
export function recordLimit(c, kind) {
  if (!c) return 0;
  if (c.settlement_finalized && (kind==='payment' || kind==='refund')) return 0;
  if (kind === 'refund') return c.paid_krw;
  if (kind === 'deposit_out') return c.held_krw;
  if (c.status === 'cancelled') return kind==='payment' ? Math.max(0,(c.cancellation_fee_krw ?? 0)-c.paid_krw) : 0;
  return Math.max(0, kind === 'payment' ? c.billed_krw-c.paid_krw : c.deposit_krw-c.held_krw);
}
export function suggestedRecordAmount(c,kind) {
  const limit = recordLimit(c,kind);
  if (kind==='refund' && c && c.paid_krw>c.billed_krw) return Math.min(limit,c.paid_krw-c.billed_krw);
  return limit;
}
export function outstandingReturns(contracts) {
  return contracts.flatMap(contract => {
    const excess = Math.max(0, contract.paid_krw - contract.billed_krw);
    const deposit = ['returned', 'cancelled'].includes(contract.status) ? Math.max(0, contract.held_krw) : 0;
    return excess || deposit ? [{id: contract.id, contract, excess, deposit}] : [];
  });
}
const normalizedPhone = phone => (phone || '').replace(/\D/g,'');
export function matchOfficeCustomer(c, catalog) {
  if (c.customer_id != null) return catalog.customers?.find(v => v.id === c.customer_id);
  const phone = normalizedPhone(c.renter_phone);
  return phone && catalog.customers?.find(v => normalizedPhone(v.phone) === phone);
}
export const templateKeys = ['회사명','계약번호','고객명','고객연락처','차량번호','차종','대여시작','반납예정','대여지점','반납지점','대여요금','보증금'];
export function fillTemplate(body, c, company, devices = []) {
  if (!c) return body;
  const device = devices.find(d => matchesVehicle(c,d));
  const fields = [company, '#' + c.id, c.renter_name, c.renter_phone, device?.license_plate || device?.car_plate || c.vehicle_name,
    c.requested_model || device?.car_model, readTime(c.starts_at), readTime(c.ends_at), c.pickup_location,
    c.return_location, won(c.billed_krw), won(c.deposit_krw)];
  const fieldsByKey = Object.fromEntries(templateKeys.map((k,i) => [k, fields[i] ?? '—']));
  return String(body).replace(/\{\{([^{}]+)\}\}/g, (token,key) => Object.hasOwn(fieldsByKey,key.trim()) ? fieldsByKey[key.trim()] : token);
}

function unionDuration(intervals) {
  let total = 0, end = -Infinity;
  for (const [a,b] of intervals.sort((left,right) => left[0]-right[0])) {
    total += Math.max(0,b - Math.max(a,end));
    end = Math.max(end,b);
  }
  return total;
}
export function returnReadingsRange(contracts, period) {
  const from=Date.parse(period.from+'T00:00:00+09:00');
  const to=Date.parse(period.to+'T00:00:00+09:00')+86400000;
  const returned=contracts.filter(c=>c.status==='returned' && Date.parse(c.returned_at)>=from && Date.parse(c.returned_at)<to);
  if (!returned.length) return null;
  // The contracts endpoint filters the scheduled window, including for late returns.
  const first=returned.reduce((min,c)=>Math.min(min,Date.parse(c.starts_at)||min),from);
  return {from:new Date(first).toISOString(),to:new Date(to).toISOString(),status:'returned'};
}

export function vehicleUsage(book, devices, period, now = Date.now(), {readings=[],work=[]}={}) {
  const start = Date.parse(period.from+'T00:00:00+09:00');
  const periodEnd = Date.parse(period.to+'T00:00:00+09:00')+86400000;
  const end = Math.min(now,periodEnd);
  const rows = new Map();
  const ensure = (id,name) => {
    const key = id ?? 'old:'+name;
    if (!rows.has(key)) rows.set(key,{ id:key, name:name || '차량 미배정', intervals:[], completed:[], scheduled:[], cost:0, revenue:0, distance:0, measured:0, missing:0 });
    return rows.get(key);
  };
  devices.forEach(d => ensure(d.id,d.license_plate || d.display_name || '차량 '+d.id));
  const rowId = r => r.vehicle_id ?? devices.find(d=>matchesVehicle(r,d))?.id ?? (r.device_id==null ? null : 'device:'+r.device_id);
  const odometers=new Map(readings.map(c=>[String(c.id),c]));
  book.contracts.filter(c => rowId(c)!=null && ['active','overdue','returned'].includes(c.status)).forEach(c => {
    const from = Math.max(start,Date.parse(c.starts_at));
    const to = Math.min(end,c.status === 'returned' ? Date.parse(c.returned_at || c.ends_at) : now);
    if (to>from) ensure(rowId(c),c.vehicle_name).intervals.push([from,to]);
    const returned=Date.parse(c.returned_at);
    if(c.status==='returned'&&returned>=start&&returned<periodEnd) {
      const row=ensure(rowId(c),c.vehicle_name),record=odometers.get(String(c.id));
      if(Number.isFinite(record?.pickup_odometer_km)&&Number.isFinite(record?.return_odometer_km)&&record.return_odometer_km>=record.pickup_odometer_km){
        row.distance+=record.return_odometer_km-record.pickup_odometer_km;
        row.measured++;
      }else row.missing++;
    }
  });
  for(const job of work){
    if (!['maintenance','inspection','cleaning'].includes(job.kind))continue;
    const id=rowId(job),from=Math.max(start,Date.parse(job.starts_at));
    const to=Math.min(job.closed_at?end:periodEnd,Date.parse(job.closed_at||job.ends_at));
    if(id==null||!(to>from))continue;
    const row=ensure(id,devices.find(d=>String(d.id)===String(id))?.license_plate||('차량 '+id));
    (job.closed_at?row.completed:row.scheduled).push([from,to]);
  }
  book.costs.forEach(k => { ensure(rowId(k),k.vehicle_name).cost += k.amount_krw; });
  book.entries.filter(e => ['payment','refund'].includes(e.kind)).forEach(e => {
    const c = book.contracts.find(c => c.id === e.contract_id);
    const id=rowId(e) ?? (c && rowId(c)); if(id==null)return;
    ensure(id,c?.vehicle_name).revenue += (e.kind === 'refund' ? -1 : 1) * e.amount_krw;
  });
  return [...rows.values()].map(r => {
    const time = unionDuration(r.intervals);
    return { ...r, hours:time/3600000, utilization:end>start ? time*100/(end-start) : 0,
      completedHours:unionDuration(r.completed)/3600000,scheduledHours:unionDuration(r.scheduled)/3600000 };
  }).sort((a,b)=>b.hours-a.hours || a.name.localeCompare(b.name,'ko'));
}
export function dailyFigures(book) {
  const days = new Map();
  function at(day) {
    if (!days.has(day)) days.set(day,{ id:day, payment:0, refund:0, cost:0 });
    return days.get(day);
  }
  for (const e of book.entries) if (['payment','refund'].includes(e.kind)) at(kstDay(e.recorded_at))[e.kind] += e.amount_krw;
  for (const c of book.costs) at(c.occurred_on).cost += c.amount_krw;
  return [...days.values()].sort((a,b)=>b.id.localeCompare(a.id));
}
