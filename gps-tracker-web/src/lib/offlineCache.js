// Offline read-cache — localStorage ga saqlaydi.
// Faqat o'qish uchun: qurilmalar ro'yxati + GPS nuqtalar.
// Hajm chegarasi: har bir kalit uchun ~500KB gacha, eski ma'lumotlar 24 soatdan keyin bekor.

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function set(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch {}
}
function get(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > MAX_AGE_MS) { localStorage.removeItem(key); return null; }
    return data;
  } catch { return null; }
}

export const offlineCache = {
  saveDevices(devices) { set('gps_cache_devices', devices); },
  loadDevices()        { return get('gps_cache_devices'); },

  savePoints(deviceId, dateOrMonth, points) {
    set(`gps_cache_pts_${deviceId}_${dateOrMonth}`, points);
  },
  loadPoints(deviceId, dateOrMonth) {
    return get(`gps_cache_pts_${deviceId}_${dateOrMonth}`);
  },

  // 캐시된 날짜가 있는지 확인
  hasPoints(deviceId, dateOrMonth) {
    return localStorage.getItem(`gps_cache_pts_${deviceId}_${dateOrMonth}`) !== null;
  },
};
