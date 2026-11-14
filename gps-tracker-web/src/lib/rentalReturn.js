// Match rentcar.rs whole-minute/hour/day truncation before ceiling units.
// The server remains authoritative for the saved settlement.
export function computeSettlementPreview(c, { returnOdometerKm, extraFeeKrw, extraLabel, returnedAt }) {
  const dur = new Date(c.ends_at) - new Date(c.starts_at); // ms
  const hours = dur / 3600_000;
  let units, unitLabel;
  if (c.rate_type === 'hourly')       { units = Math.max(1, Math.ceil(Math.trunc(dur / 60000) / 60));       unitLabel = '시간'; }
  else if (c.rate_type === 'monthly') { units = Math.max(1, Math.ceil(Math.trunc(hours / 24) / 30)); unitLabel = '개월'; }
  else                                { units = Math.max(1, Math.ceil(Math.trunc(hours) / 24));    unitLabel = '일'; }
  const rate = c.rate_amount_krw || 0;
  const baseFee = units * rate;

  // 초과 주행
  let overKm = 0, overFee = 0;
  if (returnOdometerKm != null && c.pickup_odometer_km != null
      && c.included_km_per_day != null && c.over_km_price_krw != null) {
    const driven = Math.max(0, returnOdometerKm - c.pickup_odometer_km);
    const days   = Math.max(1, Math.ceil(Math.trunc(hours) / 24));
    const allowed = c.included_km_per_day * days;
    overKm  = Math.max(0, driven - allowed);
    overFee = overKm * c.over_km_price_krw;
  }
  // 지연 반납
  const endsAt = new Date(c.ends_at);
  const lateHours = returnedAt > endsAt ? Math.max(0, Math.ceil(Math.trunc((returnedAt - endsAt) / 60000) / 60)) : 0;
  const hourly = c.rate_type === 'hourly' ? rate
    : c.rate_type === 'monthly' ? Math.floor(rate / 720)
    : Math.floor(rate / 24);
  const lateFee = lateHours > 0 ? Math.round(lateHours * hourly * 1.5) : 0;

  const extra = Number(extraFeeKrw) || 0;
  const lines = [
    { kind: 'base', label: `기본 요금 (${units}${unitLabel} × ${rate.toLocaleString()}원)`, amount: baseFee },
  ];
  if (overKm > 0 && overFee > 0) {
    lines.push({ kind: 'over_km',
      label: `초과 주행 (${overKm}km × ${c.over_km_price_krw.toLocaleString()}원)`, amount: overFee });
  }
  if (lateHours > 0 && lateFee > 0) {
    lines.push({ kind: 'late',
      label: `지연 반납 (${lateHours}시간 × ${hourly.toLocaleString()}원 × 1.5배)`, amount: lateFee });
  }
  if (extra !== 0) {
    lines.push({ kind: 'extra', label: extraLabel, amount: extra });
  }
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const balance  = (c.deposit_krw || 0) - subtotal;
  return { lines, subtotal, balance };
}

export function validateReturn(contract, form, now = Date.now()) {
  const at = Date.parse(form.returnedAt), start = Date.parse(contract.starts_at);
  let information = '', charges = '';
  if (!Number.isFinite(at)) information = '실제 반납 시각을 입력해 주세요.';
  else if (at < start) information = '반납 시각은 계약 시작보다 빠를 수 없습니다.';
  else if (at > now + 5 * 60000) information = '미래 시각으로 반납할 수 없습니다. 실제 반납 시각을 확인해 주세요.';
  const odometer = Number(form.odometer);
  if (form.odometer !== '' && (!Number.isInteger(odometer) || odometer < 0 || odometer > 2147483647)) information ||= '오도미터는 0 이상의 정수 km로 입력해 주세요.';
  else if (form.odometer !== '' && contract.pickup_odometer_km != null && odometer < contract.pickup_odometer_km) information ||= '반납 오도미터가 인수 때보다 작습니다. 계기판을 다시 확인해 주세요.';
  const extra = Number(form.extraFee);
  if (!Number.isSafeInteger(extra)) charges = '기타 금액은 원 단위 정수로 입력해 주세요.';
  else if (extra !== 0 && !form.extraLabel.trim()) charges = '기타 요금이나 할인의 사유를 입력해 주세요.';
  return { information, charges };
}

export function returnPayload(form) {
  return { returned_at: new Date(form.returnedAt).toISOString(), return_odometer_km: form.odometer === '' ? null : Number(form.odometer),
    return_location: form.location.trim() || null, extra_fee_krw: form.extraFee === '' ? null : Number(form.extraFee),
    extra_fee_label: form.extraLabel.trim() || null, note: form.note.trim() || null };
}

