// deviceMapSync.js — loadDevices / loadDevicesIncremental uchun umumiy marker/history logikasi.
// Ikkala funksiya bir xil kodni takrorlash o'rniga shu helperdan foydalanadi.
import { api } from '../api';
import { getDeviceColor, isStale } from '../colors';
import { enrichWithSpeedStops } from './stops';

/**
 * Bitta device uchun API dan loc'lar olib xaritaga marker + history sync qiladi.
 * @param {object} mapRef - KakaoMap ref
 * @param {object} d - device object
 * @param {object} lastMetaRef - { current: { [deviceId]: meta } }
 * @returns {Array|null} - chartDays: [[dateStr, mV], ...] yoki null
 */
export async function syncDeviceToMap(mapRef, d, lastMetaRef) {
  const locs = await api.listLocations(d.id, { limit: 500, fix_only: true });
  if (!locs?.length) return null;

  const ordered = [...locs].reverse();
  const color = getDeviceColor(d);
  const stale = isStale(d.last_seen_at);
  const label = d.display_name || d.device_uid;

  // polyline + main marker
  ordered.forEach((loc, i) => {
    if (!loc.lat || !loc.lng) return;
    const isLast = i === ordered.length - 1;
    const meta = isLast
      ? { recordedAt: loc.recorded_at, sat: loc.sat, vbatMv: loc.vbat_mv, fix: loc.fix, stale }
      : { stale };
    mapRef.current?.updateMarker(d.id, loc.lat, loc.lng, label, color, meta);
    if (isLast) lastMetaRef.current[d.id] = meta;
  });

  // history dot markers
  mapRef.current?.clearHistoryPoints(d.id);
  const enriched = enrichWithSpeedStops(ordered);
  enriched.slice(0, -1).forEach(loc => {
    if (!loc.lat || !loc.lng) return;
    mapRef.current?.addHistoryPoint(d.id, loc.lat, loc.lng, color, {
      recordedAt: loc.recorded_at, sat: loc.sat, vbatMv: loc.vbat_mv, fix: loc.fix,
      speedKmh: loc._speed, isStop: loc._isStop,
    });
  });

  // battery trend chart data (7-kun) — KST
  const KST = 9 * 3600 * 1000;
  const byDay = {};
  ordered.forEach(loc => {
    if (!loc.recorded_at || !loc.vbat_mv) return;
    const date = new Date(new Date(loc.recorded_at).getTime() + KST).toISOString().slice(0, 10);
    byDay[date] = loc.vbat_mv;
  });
  const chartDays = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).slice(-7);
  return chartDays.length ? chartDays : null;
}
