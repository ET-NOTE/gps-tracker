const STORAGE_KEY = 'seriallink-public-fleet-demo-v1';
const fleetKey = 'seriallink-fleet-prototype-v1';
const fields = [fleetKey, 'seriallink-view-width-v1', 'seriallink-service-v2'];
export const channel = 'seriallink-demo-v1';
export const bootstrapMarker = '<!--seriallink-demo-bootstrap-->';
let volatileState = null;

// Match the original ID, field and entire default value so custom notes and contracts survive.
const rentalContract = '차량 대여 계약 확인\n\n고객과 차량, 이용 기간 및 확정 요금은 해당 계약 정보를 따릅니다.\n출고와 반납 시 주행거리, 연료·충전량, 외관과 비품을 함께 확인합니다.\n기간 연장 및 차량 변경은 직원 확인 후 계약에 기록합니다.';
const oldSampleFields = [
  ['rental', 'accounts', ['ra1'], 'memo', '예시 거래처 · 월별 이용 내역 확인', '월별 이용 내역 확인'],
  ['rental', 'accounts', ['ra2'], 'memo', '예시 거래처', ''],
  ['rental', 'customers', ['rc1','rc2','rc3','rc4','rc5','rc6','rc7','rc8'], 'memo', '예시 고객 정보', ''],
  ['rental', 'rentals', ['rr1','rr2','rr3','rr4','rr5','rr6','rr7','rr8','rr9'], 'notes', '예시 대여 건', ''],
  ['rental', 'payments', ['rp1','rp2','rp3','rp4','rp5','rp6','rp7','rp8','rp9','rp10','rp12','rp13'], 'note', '예시 결제 기록', ''],
  ['rental', 'costs', ['re1','re2','re3','re4','re5'], 'note', '예시 운영 비용', ''],
  ['rental', 'templates', ['rt1'], 'body', rentalContract + '\n\n이 문서는 화면 구성을 확인하기 위한 예시 양식입니다.', rentalContract],
  ['cargo', 'shippers', ['cs1','cs2','cs3','cs4','cs5'], 'note', '예시 거래처', ''],
  ['cargo', 'carriers', ['cc1','cc2','cc3'], 'note', '예시 협력 운송사', ''],
  ['cargo', 'orders', ['co11'], 'note', '화주 요청으로 취소된 예시 주문', '화주 요청으로 취소'],
  ['cargo', 'recurring', ['cr1','cr2'], 'note', '반복 주문 예시', ''],
  ['cargo', 'rates', ['cp3'], 'note', '냉장 운송 예시', '냉장 운송'],
  ['cargo', 'payments', ['cy3'], 'note', '직영 운송비 내부 정산 예시', '직영 운송비 내부 정산'],
];

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
  const saved = sampleFields(state);
  if (saved[fleetKey]) saved[fleetKey] = updateDefaultSampleCopy(saved[fleetKey]);
  // Sample pages sit under /demo/, so relative asset paths need the app's base to resolve.
  const data = JSON.stringify({...target, state: saved, assetBase: import.meta.env?.BASE_URL || '/'}).replaceAll('<', '\\u003c');
  return html.replace(bootstrapMarker, () => '<script>window.SERIAL_DEMO_BOOT=' + data + ';</script>');
}

function updateDefaultSampleCopy(serialized) {
  let fleet;
  try { fleet = JSON.parse(serialized); }
  catch { return serialized; }
  if (fleet?.version !== 1) return serialized;
  let changed = false;
  for (const [service, collection, ids, field, previous, current] of oldSampleFields) {
    const rows = fleet[service]?.[collection];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (ids.includes(row?.id) && row[field] === previous) {
        row[field] = current;
        changed = true;
      }
    }
  }
  return changed ? JSON.stringify(fleet) : serialized;
}
