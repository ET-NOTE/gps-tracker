// Deliberately transfer display data only. JWTs, cookies and account details
// remain in the existing authenticated web session.
const finite = value => typeof value === 'number' && Number.isFinite(value);
const coordinate = row => row && finite(row.lat) && finite(row.lng) && Math.abs(row.lat) <= 90 && Math.abs(row.lng) <= 180;
const safeColor = value => /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#5B7CFF';
const pickMeta = meta => ({
  recordedAt: meta?.recordedAt || null,
  speedKmh: finite(meta?.speedKmh) ? meta.speedKmh : null,
  heading: finite(meta?.heading) ? meta.heading : null,
  fix: meta?.fix !== false,
});

export function buildNativeTrackingSnapshot({ selectedId, devices, display, metadata = {}, fences = [], cached = {}, colors = {}, statuses = {}, now = Date.now() }) {
  if (selectedId == null || !display) return null;
  const rows = devices.map(device => {
    const marker = display.markers?.[device.id];
    const meta = metadata[device.id] || marker?.meta || {};
    const row = {
      id: String(device.id), label: String(device.display_name || device.device_uid || '단말기').slice(0, 80),
      lat: marker?.lat ?? device.last_lat, lng: marker?.lng ?? device.last_lng,
      color: safeColor(colors[device.id]), ...pickMeta(meta),
      recordedAt: meta.recordedAt || device.last_fix_at || null,
      markerHeading: finite(marker?.heading) ? marker.heading : 0,
      statusLabel: statuses[device.id] || '', cached: !!(cached.devices || cached[device.id]),
    };
    const age = now - Date.parse(row.recordedAt);
    const stale = !Number.isFinite(age) || age > 120000 || age < -30000 || row.cached;
    row.state = stale ? 'offline' : row.fix && finite(row.speedKmh) && row.speedKmh >= 3 ? 'moving' : 'stopped';
    return row;
  }).filter(coordinate);
  const selected = rows.find(row => row.id === String(selectedId));
  if (!selected) return null;
  // Selected first, so a large fleet cannot crowd its selected tracker out.
  const visible = [selected, ...rows.filter(row => row !== selected)].slice(0, 100);
  let budget = 2500;
  const segments = [];
  // Keep segment boundaries: never draw a fictitious straight line over a gap.
  for (const input of (display.segments || []).slice(-200).reverse()) {
    const valid = input.filter(coordinate).slice(-budget);
    if (budget <= 0) break;
    if (valid.length > 1) segments.unshift(valid.map(({ lat, lng }) => ({ lat, lng })));
    budget -= valid.length;
  }
  return {
    version: 1, selectedId: selected.id, devices: visible, segments, trailColor: selected.color,
    points: (display.points || []).filter(coordinate).slice(-150).map(point => ({
      lat: point.lat, lng: point.lng, ...pickMeta(point.meta), label: selected.label,
      color: safeColor(point.color || selected.color), isStop: point.isStop === true,
    })),
    fences: fences.filter(f => coordinate({ lat: f.center_lat, lng: f.center_lng }) && finite(f.radius_m) && f.radius_m > 0 && f.radius_m <= 100000)
      .slice(0, 100).map(f => ({ lat: f.center_lat, lng: f.center_lng, radius: f.radius_m, color: '#2563EB' })),
  };
}
