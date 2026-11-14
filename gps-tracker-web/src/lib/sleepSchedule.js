// Match the API connection worker: legacy 24h minimum, plus a 15-minute
// startup/transmission allowance when firmware advertises a daily report.
export function sleepReportDeadlineMs(stationary) {
  const seconds = stationary?.timer_wake_s;
  if (stationary?.timer_wake_enabled !== true || !Number.isSafeInteger(seconds) || seconds < 60 || seconds > 604800) return 86400000;
  return Math.max(1440, Math.ceil(seconds / 60) + 15) * 60000;
}
