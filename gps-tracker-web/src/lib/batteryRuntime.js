// Only format the server estimate. Do not infer time from the displayed percent.
export function batteryRuntimeView(estimate, now = Date.now()) {
  if (!estimate) return null;
  const messages = {
    unavailable: '전압 수신 후 시간 계산',
    sleeping: '절전 중 · 시간 계산 보류',
    stale: '새 전압 수신 후 시간 계산',
    external_power_possible: '외부 전원 가능 · 시간 계산 보류',
  };
  if (messages[estimate.status]) return { text: messages[estimate.status], date: null };
  const at = Date.parse(estimate.measurement_at);
  const end = Date.parse(estimate.estimated_empty_at);
  if (!Number.isFinite(at) || !Number.isFinite(end) || !Number.isFinite(estimate.remaining_seconds))
    return { text: messages.unavailable, date: null };
  if (now - at > 300_000 || at - now > 60_000) return { text: messages.stale, date: null };
  if (estimate.status === 'depleted' || end <= now) return { text: '방전 기준 도달 · 충전 필요', date: null };
  if (estimate.status !== 'estimated') return { text: messages.unavailable, date: null };
  const step = (end - now) >= 3_600_000 ? 30 : 5;
  const minutes = Math.max(5, Math.round((end - now) / 60_000 / step) * step);
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  const duration = [hours ? `${hours}시간` : '', rest ? `${rest}분` : ''].filter(Boolean).join(' ');
  const roundedEnd = new Date(Math.round(end / (step * 60_000)) * step * 60_000);
  const date = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(roundedEnd);
  return { text: `예상 남은 시간 약 ${duration}`, date: `예상 방전 ${date} (한국 시간)` };
}
