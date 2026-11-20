import { businessDate, rentalStatus } from './business.js';

export const rentalStageNames = { reservations:'예약 접수', dispatch:'배차 목록', contracts:'대여 계약', checkout:'출고 점검', active:'대여 중 차량', returns:'반납·정산' };
export const workflowStatus = (c, now) => {
  const status = rentalStatus(c, now);
  if (status === 'draft') return c.device_id == null ? '배차 대기' : c.rental_terms?.confirmed_at ? '출고 준비' : '예약 접수';
  return ({active:'대여 중',overdue:'반납 지연',returned:'반납 완료',cancelled:'취소'})[status] || status;
};
export const agreementTotal = c => {
  const duration = new Date(c.ends_at) - new Date(c.starts_at);
  const [step,divisor] = {hourly:[60000,60],monthly:[86400000,30]}[c.rate_type] || [3600000,24];
  return Math.max(1, Math.ceil(Math.trunc(duration / step) / divisor)) * Number(c.rate_amount_krw || 0);
};
export function workflowRows(rows, stage, { query='', status='', branch='', from='', to='', device='' } = {}, now = Date.now()) {
  const q = query.trim().toLocaleLowerCase();
  return rows.filter(c => {
    const state = rentalStatus(c,now);
    if (stage==='dispatch' && !['draft','active','overdue'].includes(state)) return false;
    if (stage==='checkout' && state!=='draft') return false;
    if (stage==='active' && !['active','overdue'].includes(state)) return false;
    if (stage==='returns' && !['active','overdue','returned'].includes(state)) return false;
    if (status && workflowStatus(c,now)!==status) return false;
    if ((branch && c.pickup_location!==branch) || (device && String(c.device_id)!==String(device))) return false;
    const start = businessDate(c.starts_at), end = businessDate(c.ends_at);
    if ((from && end<from) || (to && start>to)) return false;
    return !q || [c.id, 'R-'+c.id, c.license_plate,c.device_name,c.renter_name,c.renter_phone,c.rental_terms?.driver_name,c.rental_terms?.requested_model]
      .some(v=>String(v ?? '').toLocaleLowerCase().includes(q));
  }).sort((a,b)=> Date.parse(stage==='active' || stage==='returns'?a.ends_at:a.starts_at) - Date.parse(stage==='active' || stage==='returns'?b.ends_at:b.starts_at) || a.id-b.id);
}
