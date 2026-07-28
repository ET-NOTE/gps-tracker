// (2026-07-28) Phase F3 — panel React.memo 공용 compare.
//
// Dashboard 가 WS location fix 마다 `setDevices(prev.map(...))` 로 devices array
// identity 를 갱신 → 그 아래 CorporatePanel/RentcarPanel/DeliveryPanel 매번 재렌더.
// panel 이 관심 있는 필드 (id, display_name, license_plate, last_event_kind) 만
// stable 하면 lat/lng 변화는 무시 → 재렌더 skip.
//
// 사용: export default React.memo(RentcarPanel, panelPropsEqual);

export function panelPropsEqual(prev, next) {
  const a = prev.devices, b = next.devices;
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i], n = b[i];
    if (p.id !== n.id) return false;
    if (p.display_name  !== n.display_name)  return false;
    if (p.license_plate !== n.license_plate) return false;
    if (p.last_event_kind !== n.last_event_kind) return false;
    if (p.owner_id !== n.owner_id) return false;
  }
  // (기본 shallow) — 다른 prop 은 identity 비교
  for (const k of Object.keys(next)) {
    if (k === 'devices') continue;
    if (prev[k] !== next[k]) return false;
  }
  for (const k of Object.keys(prev)) {
    if (k === 'devices') continue;
    if (!(k in next)) return false;
  }
  return true;
}
