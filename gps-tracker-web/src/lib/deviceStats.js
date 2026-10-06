import { kstDate } from './seeker.js';

export function todayStats(rows, now = new Date().toISOString()) {
  return rows?.find(row => row.date === kstDate(now));
}
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds > 0 && seconds < 60) return `${Math.floor(seconds)}초`;
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60);
  return h ? `${h}시간 ${m}분` : `${m}분`;
}
export function formatDistance(metres, decimals = 1) {
  return Number.isFinite(metres) && metres >= 0 ? (metres / 1000).toFixed(decimals) : '—';
}
