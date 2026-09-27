// Shared time and sampling contract for both history explorers.
export const KST_OFFSET_MS = 9 * 3600 * 1000;
export const KST_TIME_OPTIONS = { timeZone: 'Asia/Seoul' };
export function kstDate(value = Date.now()) {
  return new Date(new Date(value).getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}
export function bucket10min(value) {
  const d = new Date(new Date(value).getTime() + KST_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(Math.floor(d.getUTCMinutes() / 10) * 10).padStart(2, '0')}`;
}
export function dayWindow(date) {
  const start = Date.parse(`${date}T00:00:00+09:00`);
  return { since: new Date(start).toISOString(), until: new Date(start + 86400000).toISOString() };
}
export function monthWindow(month) {
  const [y, m] = month.split('-').map(Number);
  return { since: `${month}-01T00:00:00+09:00`,
    until: `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01T00:00:00+09:00` };
}
export function seekerBucket(mode, precision) {
  return precision === 'auto' ? (mode === 'month' ? '1h' : '1m') : precision;
}
export const BUCKET_LABEL = { '1m': '1분', '5m': '5분', '1h': '1시간' };
export function normalizeAggregates(rows) {
  return (rows || []).filter(r => r.lat_last != null && r.lng_last != null && r.recorded_at_last)
    .map(r => ({ recorded_at: r.recorded_at_last, lat: r.lat_last, lng: r.lng_last, fix: true,
      speed_kmh: r.speed_kmh, speed_source: r.speed_source,
      speed_avg_kmh: r.speed_avg_kmh, speed_max_kmh: r.speed_max_kmh,
      sat: r.sat_avg == null ? null : Math.round(r.sat_avg), vbat_mv: r.vbat_avg, batch_size: r.fix_count,
    })).sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at));
}
export function isSeekerVisible(view, deviceId, detailed, mini) {
  return deviceId != null && ((view === 'tools' && detailed) || (view === 'home' && mini));
}
