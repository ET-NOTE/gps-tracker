const STORAGE_KEY = 'seriallink-public-fleet-demo-v1';
const fields = ['seriallink-fleet-prototype-v1', 'seriallink-view-width-v1', 'seriallink-service-v2'];
export const channel = 'seriallink-demo-v1';
export const bootstrapMarker = '<!--seriallink-demo-bootstrap-->';
let volatileState = null;

function sampleFields(state) {
  return Object.fromEntries(fields.filter(key => typeof state?.[key] === 'string').map(key => [key, state[key]]));
}

export function readSampleSession() {
  if (volatileState) return volatileState;
  try { return sampleFields(JSON.parse(sessionStorage.getItem(STORAGE_KEY))); }
  catch { return {}; }
}

export function writeSampleSession(state) {
  volatileState = sampleFields(state);
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(volatileState));
    return true;
  } catch {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* Storage unavailable. */ }
    return false;
  }
}

export function endSampleSession() {
  volatileState = null;
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* Storage unavailable. */ }
}

export function bootDocument(html, target, state) {
  if (!html.includes(bootstrapMarker)) throw new Error('체험 화면을 불러오지 못했습니다.');
  const data = JSON.stringify({...target, state: sampleFields(state)}).replaceAll('<', '\\u003c');
  return html.replace(bootstrapMarker, () => '<script>window.SERIAL_DEMO_BOOT=' + data + ';</script>');
}
