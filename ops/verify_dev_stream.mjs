// Windows Node 22+. Reads only the dedicated synthetic device's private login.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.join(process.env.LOCALAPPDATA, 'GPS-DevSimulator');
const credentials = JSON.parse(await readFile(path.join(root, 'login-private.json'), 'utf8'));
const base = 'https://dev-gps.serial.kr/gps-tracker/api/v1';
assert.equal(credentials.email, 'dev-simulator-20260924@example.invalid');
const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: credentials.email, password: credentials.password, remember_me: false }) });
assert.equal(login.status, 200);
const tokens = await login.json();
const headers = { Authorization: `Bearer ${tokens.access_token}` };
async function get(suffix) {
  const start = performance.now();
  const response = await fetch(`${base}/devices/${credentials.device_id}/${suffix}`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  return { body, ms: Math.round(performance.now() - start) };
}
const events = [];
await new Promise((resolve, reject) => {
  const socket = new WebSocket(`wss://dev-gps.serial.kr/gps-tracker/ws/realtime?token=${encodeURIComponent(tokens.access_token)}`);
  const timer = setTimeout(() => { socket.close(); reject(Error('No three live events within 45 seconds')); }, 45000);
  socket.onopen = () => socket.send(JSON.stringify({ action: 'subscribe', device_ids: [credentials.device_id] }));
  socket.onerror = () => { clearTimeout(timer); socket.close(); reject(Error('WebSocket connection failed')); };
  socket.onmessage = ({ data }) => {
    const event = JSON.parse(data);
    if (event.type !== 'location') return;
    try {
      assert.equal(event.device_id, credentials.device_id);
      assert.ok(event.fixes.length >= 1);
      const latest = event.fixes.reduce((a, b) => Date.parse(a.recorded_at) > Date.parse(b.recorded_at) ? a : b);
      assert.equal(event.recorded_at, latest.recorded_at);
      assert.equal(event.lat, latest.lat);
      assert.equal(event.speed_kmh, latest.speed_kmh);
      assert.ok(event.fixes.every(f => Number.isFinite(f.speed_kmh)));
      events.push({ time: event.recorded_at, points: event.fixes.length, speed: event.speed_kmh });
      if (events.length === 3) { clearTimeout(timer); socket.close(); resolve(); }
    } catch (error) { clearTimeout(timer); socket.close(); reject(error); }
  };
});
const [latest, history, dates, daily] = await Promise.all([
  get('locations/latest'), get('locations?limit=2'), get('active-dates'), get('stats/daily?limit=2'),
]);
assert.ok(Date.parse(latest.body.recorded_at) >= Date.parse(events.at(-1).time));
assert.ok(history.body.length > 2, 'row limit must keep every fix in each batch');
assert.ok(dates.body.length > 0, 'seeker must see active dates immediately');
const result = { checked_at: new Date().toISOString(), device_id: credentials.device_id, events,
  history_points_in_two_posts: history.body.length, active_dates: dates.body,
  latency_ms: { latest: latest.ms, history: history.ms, dates: dates.ms, daily: daily.ms } };
await writeFile(path.join(root, 'verification.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
