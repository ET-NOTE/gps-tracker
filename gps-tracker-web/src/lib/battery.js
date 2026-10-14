import policy from '../../../gps-tracker-api/battery-policy.json';

export const batteryPolicy = policy;
export const BATTERY_STATES = {
  normal: { label: '정상', color: 'var(--status-success-text)' },
  low: { label: '저전압', color: 'var(--status-warning-text)' },
  critical: { label: '전압 매우 부족', color: 'var(--status-danger-text)' },
  unknown: { label: '전압 미확인', color: 'var(--text-3)' },
};

export function calibratedVoltage(rawMv) {
  const points = policy.calibration.points;
  if (rawMv <= points[0][0]) return rawMv + points[0][1] - points[0][0];
  for (let i = 1; i < points.length; i++) {
    const [lo, lv] = points[i - 1], [hi, hv] = points[i];
    if (rawMv <= hi) return lv + Math.floor(((rawMv - lo) * (hv - lv) + Math.floor((hi - lo) / 2)) / (hi - lo));
  }
  const [lastRaw, lastValue] = points.at(-1);
  return rawMv + lastValue - lastRaw;
}

// ADC is the battery source. CBC is a separate modem rail measurement and is
// never substituted for it. Missing/invalid values must not become 0% or 100%.
export function batteryReading(mv) {
  if (typeof mv !== 'number' || !Number.isFinite(mv) || mv < policy.valid_min_mv || mv > policy.valid_max_mv)
    return { state: 'unknown', ...BATTERY_STATES.unknown, rawMv: null, mv: null, voltage: '—', percent: null };
  const rawMv = mv;
  mv = calibratedVoltage(rawMv);
  const points = policy.calibration.points;
  const outsideCalibration = rawMv < points[0][0] || rawMv > points.at(-1)[0];
  const state = mv < policy.critical_below_mv ? 'critical' : mv < policy.normal_min_mv ? 'low' : 'normal';
  let percent = mv <= policy.curve[0][0] ? 0 : 100;
  for (let i = 1; i < policy.curve.length; i++) {
    const [lo, lp] = policy.curve[i - 1], [hi, hp] = policy.curve[i];
    if (mv > lo && mv < hi) { percent = Math.round(lp + (mv - lo) * (hp - lp) / (hi - lo)); break; }
    if (mv === hi) { percent = hp; break; }
  }
  return { state, ...BATTERY_STATES[state], rawMv, mv, outsideCalibration, voltage: `${(mv / 1000).toFixed(2)} V`, percent };
}

// GPS coordinates can be old while battery telemetry is current. Compare the
// battery receipt time, not the last GPS fix time, before choosing a reading.
export function deviceBattery(device, meta) {
  if (device?.device_kind === 'phone') return batteryReading(null);
  const mt = Date.parse(meta?.batteryAt ?? meta?.receivedAt ?? meta?.recordedAt);
  const dt = Date.parse(device?.last_battery_at ?? device?.last_seen_at);
  const fromMeta = Object.hasOwn(meta || {}, 'vbatMv') && (!Number.isFinite(dt) || (Number.isFinite(mt) && mt >= dt));
  return batteryReading(fromMeta ? meta.vbatMv : device?.last_vbat_mv);
}

export function batteryText(mv) {
  const b = batteryReading(mv);
  return b.percent == null ? '전압 미확인' : `약 ${b.percent}% · ${b.voltage} · ${b.label}`;
}

export function telemetryBatteryPatch(msg) {
  return { last_vbat_mv: msg.vbat_mv ?? null, last_cbc_mv: msg.cbc_mv ?? null, last_battery_at: msg.recorded_at };
}
