// GPS describes movement, not ignition or whether the vehicle is parked.
export function liveMotion(speedKmh, recordedAt, now = Date.now()) {
  const age = now - Date.parse(recordedAt);
  if (!Number.isFinite(age) || age < -60_000 || age > 90_000) {
    return { label: '위치 오래됨', moving: false, speedKmh: null };
  }
  if (!Number.isFinite(speedKmh) || speedKmh < 0 || speedKmh > 250) {
    return { label: '속도 미확인', moving: false, speedKmh: null };
  }
  const moving = speedKmh >= 3;
  return { label: moving ? '이동 중' : '정지·저속', moving, speedKmh };
}
