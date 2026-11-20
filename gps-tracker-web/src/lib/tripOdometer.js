export const ODOMETER_MAX_KM = 9999999.99;

// A blank reading is unknown, while zero is a measured value.
export function validateOdometerInput(before, after) {
  const values = [before, after].map(value => String(value ?? '').trim());
  const empty = values.map(value => value === '');
  if (empty.every(Boolean)) return { error: '', distanceKm: null, payload: { odometer_before_km: null, odometer_after_km: null } };
  if (empty.some(Boolean)) return { error: '주행 전·후 계기판 거리를 모두 입력하거나 두 칸을 모두 비워 주세요.' };
  if (values.some(value => !/^\d+(?:\.\d{1,2})?$/.test(value) || Number(value) > ODOMETER_MAX_KM)) {
    return { error: '계기판 거리는 0~9,999,999.99 km 범위에서 소수 둘째 자리까지 입력해 주세요.' };
  }
  const [start, end] = values.map(Number);
  if (end < start) return { error: '주행 후 계기판 거리는 주행 전 거리보다 작을 수 없습니다.' };
  return { error: '', distanceKm: Math.round((end - start) * 100) / 100, payload: { odometer_before_km: start, odometer_after_km: end } };
}

export function odometerSummary(annotation) {
  const before = annotation?.odometer_before_km, after = annotation?.odometer_after_km;
  if (before == null && after == null) return '계기판 미입력';
  const reading = validateOdometerInput(before, after);
  if (reading.error || reading.distanceKm == null) return '계기판 값 확인 필요';
  const number = value => Number(value).toLocaleString('ko-KR', { maximumFractionDigits: 2 });
  return `계기판 ${number(before)} → ${number(after)} km · ${number(reading.distanceKm)} km`;
}
