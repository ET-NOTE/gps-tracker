// (2026-07-28) Phase F2 — Query key 통합.
//
// React Query 는 key 배열 기반 캐시. 오탈자로 다른 key 쓰면 캐시 miss + dedup 실패.
// 여기서 factory 로 만들어 오탈자 방지 + invalidate 시 refactor-safe.
//
// 사용:
//   useQuery({ queryKey: qk.me(), queryFn: ... })
//   useQuery({ queryKey: qk.devices(), queryFn: ... })
//   queryClient.invalidateQueries({ queryKey: qk.devices() })
//   queryClient.invalidateQueries({ queryKey: qk.rentals() })   // 모든 rental query 무효화

export const qk = {
  // ── 나 ──
  me:          () => ['me'],
  accountType: () => ['account-type'],
  userPrefs:   () => ['user-prefs'],

  // ── device fleet ──
  devices:     () => ['devices'],
  device:      (id) => ['device', id],

  // ── corporate ──
  corporateInfo: () => ['corporate-info'],
  staff:         () => ['staff'],
  reservations:  (params = {}) => ['reservations', params],
  trips:         (deviceId, params = {}) => ['trips', deviceId, params],
  fleetTripStats:(params = {}) => ['fleet-trip-stats', params],

  // ── rentcar ──
  rentals:        (params = {}) => ['rentals', params],
  renters:        () => ['renters'],
  renterDetail:   (phone) => ['renter', phone],
  blacklist:      () => ['blacklist'],
  handoffTokens:  (contractId) => ['handoff-tokens', contractId],
  rentalPhotos:   (contractId) => ['rental-photos', contractId],

  // ── etc ──
  geofences:  () => ['geofences'],
  fuelPrices: () => ['fuel-prices'],
  documents:  (deviceId) => ['documents', deviceId],
};
