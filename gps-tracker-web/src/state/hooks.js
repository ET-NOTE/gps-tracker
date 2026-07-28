// (2026-07-28) Phase F2 — 공용 useQuery 훅 모음.
//
// 원칙:
//   1. 하나의 API endpoint = 하나의 훅. 중복 fetch 사라짐 (dedup).
//   2. 훅 이름은 use{Resource} — 컴포넌트에서 바로 데이터·loading·error 사용.
//   3. mutation 은 useMutation + invalidateQueries — setTick(t=>t+1) 대체.
//
// 사용:
//   const { data: me, isLoading } = useMe();
//   const { data: devices } = useDevices();
//   const rentals = useRentals({ status: ['draft','active'] });
//   const addRental = useCreateRental(); addRental.mutate(body);

import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { qk } from './keys';
import { chatBus } from '../lib/chatBus';

// ═══════════════════════════════════════════════════════════
// 사용자 · 계정 정보
// ═══════════════════════════════════════════════════════════

export function useMe(opts = {}) {
  return useQuery({
    queryKey: qk.me(),
    queryFn: () => api.getMe(),
    staleTime: 5 * 60_000,   // 5분 — 자주 안 바뀌는 프로필
    ...opts,
  });
}

export function useAccountType(opts = {}) {
  return useQuery({
    queryKey: qk.accountType(),
    queryFn: () => api.getAccountType(),
    staleTime: 10 * 60_000,  // 10분 — 계정 유형은 거의 안 바뀜
    ...opts,
  });
}

export function useUserPrefs(opts = {}) {
  return useQuery({
    queryKey: qk.userPrefs(),
    queryFn: () => api.getMyPrefs?.() ?? Promise.resolve({}),
    staleTime: 5 * 60_000,
    ...opts,
  });
}

// (F2-b) account type 변경 mutation — 성공 시 캐시 즉시 갱신 → SideRail/BottomNav
// 리렌더 (accountType stale bug 근본 해결).
export function useSetAccountType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (type) => api.setAccountType(type),
    onSuccess: (data) => {
      qc.setQueryData(qk.accountType(), data);   // optimistic — 서버 응답 그대로
    },
  });
}

// ═══════════════════════════════════════════════════════════
// Device fleet
// ═══════════════════════════════════════════════════════════

export function useDevices(opts = {}) {
  return useQuery({
    queryKey: qk.devices(),
    queryFn: () => api.listDevices(),
    staleTime: 30_000,   // 30s
    ...opts,
  });
}

// ═══════════════════════════════════════════════════════════
// Corporate (법인차 · 예약 · 직원 · 문서)
// ═══════════════════════════════════════════════════════════

export function useCorporateInfo(opts = {}) {
  return useQuery({
    queryKey: qk.corporateInfo(),
    queryFn: () => api.getCorporateInfo(),
    staleTime: 5 * 60_000,
    ...opts,
  });
}

export function useStaff(opts = {}) {
  return useQuery({
    queryKey: qk.staff(),
    queryFn: () => api.listStaff(),
    ...opts,
  });
}

export function useReservations(params = {}, opts = {}) {
  return useQuery({
    queryKey: qk.reservations(params),
    queryFn: () => api.listReservations(params),
    ...opts,
  });
}

// (F6-b) Fleet 단위 trip aggregate — devices.map(listTrips) N+1 대체.
export function useFleetTripStats(params = {}, opts = {}) {
  return useQuery({
    queryKey: qk.fleetTripStats(params),
    queryFn: () => api.fleetTripStats(params),
    staleTime: 60_000,   // 1분 — 요약 지표라 자주 안 바뀜
    ...opts,
  });
}

export function useDocuments(deviceId, opts = {}) {
  return useQuery({
    queryKey: qk.documents(deviceId),
    queryFn: () => api.listDocuments(deviceId),
    enabled: !!deviceId,
    ...opts,
  });
}

// Reservation mutations
export function useCreateReservation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.createReservation(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.reservations() }),
  });
}
export function useUpdateReservation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) => api.updateReservation(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.reservations() }),
  });
}
export function useDeleteReservation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.deleteReservation(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.reservations() }),
  });
}

// Staff mutations
export function useCreateStaff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.createStaff(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.staff() }),
  });
}
export function useUpdateStaff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) => api.updateStaff(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.staff() }),
  });
}
export function useRemoveStaff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.removeStaff(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.staff() }),
  });
}

// Documents mutations
export function useUploadDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ deviceId, body }) => api.uploadDocument(deviceId, body),
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: qk.documents(vars.deviceId) }),
  });
}
export function useDeleteDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) => api.deleteDocument(id),
    onSuccess: (_data, vars) => {
      if (vars.deviceId != null) qc.invalidateQueries({ queryKey: qk.documents(vars.deviceId) });
    },
  });
}

// ═══════════════════════════════════════════════════════════
// Chat unread — ChatPanel + ProfilePanel 중복 폴링 통합.
// ═══════════════════════════════════════════════════════════
export function useChatUnread(enabled = true) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['chat-unread'],
    queryFn: async () => {
      const t = await api.chatMyThread();
      return t?.unread_for_user || 0;
    },
    staleTime: 5_000,
    // (F7-b) WS push 로 실시간 반영 후엔 poll 은 fallback — 60s 로 완화 (10s→60s).
    refetchInterval: 60_000,
    enabled,
  });
  // (F7-b) admin 발신 chat_message push 시 unread +1 (optimistic).
  // ChatPanel 이 열려 있으면 그쪽에서 markUnreadZero 로 0 세팅함 (레이스 무해 — 뒤가 이김).
  useEffect(() => {
    if (!enabled) return;
    return chatBus.subscribe((m) => {
      if (m?.sender_role === 'admin') {
        qc.setQueryData(['chat-unread'], (prev = 0) => (prev || 0) + 1);
      }
    });
  }, [enabled, qc]);
  return q;
}

// ═══════════════════════════════════════════════════════════
// Rentcar
// ═══════════════════════════════════════════════════════════

export function useRentals(params = {}, opts = {}) {
  return useQuery({
    queryKey: qk.rentals(params),
    queryFn: () => api.listRentals(params),
    ...opts,
  });
}

export function useRenters(opts = {}) {
  return useQuery({
    queryKey: qk.renters(),
    queryFn: () => api.listRenters(),
    ...opts,
  });
}

export function useRenterDetail(phone, opts = {}) {
  return useQuery({
    queryKey: qk.renterDetail(phone),
    queryFn: () => api.renterDetail(phone),
    enabled: !!phone,
    ...opts,
  });
}

export function useBlacklist(opts = {}) {
  return useQuery({
    queryKey: qk.blacklist(),
    queryFn: () => api.listBlacklist(),
    ...opts,
  });
}

export function useHandoffTokens(contractId, opts = {}) {
  return useQuery({
    queryKey: qk.handoffTokens(contractId),
    queryFn: () => api.listHandoffTokens(contractId),
    enabled: !!contractId,
    ...opts,
  });
}

export function useRentalPhotos(contractId, opts = {}) {
  return useQuery({
    queryKey: qk.rentalPhotos(contractId),
    queryFn: () => api.listRentalPhotos(contractId),
    enabled: !!contractId,
    ...opts,
  });
}

// ═══════════════════════════════════════════════════════════
// Mutations — 성공 시 관련 query 자동 invalidate.
// setTick(t => t+1) 패턴 대체.
// ═══════════════════════════════════════════════════════════

export function useCreateRental() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.createRental(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.rentals() });
      qc.invalidateQueries({ queryKey: qk.renters() });
    },
  });
}

export function useUpdateRental() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) => api.updateRental(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.rentals() });
      qc.invalidateQueries({ queryKey: qk.renters() });
    },
  });
}

export function useReturnRental() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) => api.returnRental(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.rentals() });
      qc.invalidateQueries({ queryKey: qk.renters() });
    },
  });
}

export function useDeleteRental() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.deleteRental(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.rentals() });
      qc.invalidateQueries({ queryKey: qk.renters() });
    },
  });
}

// Blacklist
export function useAddBlacklist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.addBlacklist(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.blacklist() });
      qc.invalidateQueries({ queryKey: qk.renters() });
    },
  });
}
export function useRemoveBlacklist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.removeBlacklist(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.blacklist() });
      qc.invalidateQueries({ queryKey: qk.renters() });
    },
  });
}

// Handoff tokens
export function useIssueHandoffToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ contractId, purpose, expiresHours }) =>
      api.issueHandoffToken(contractId, purpose, expiresHours ?? 72),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: qk.handoffTokens(vars.contractId) });
    },
  });
}
export function useRevokeHandoffToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tokenId }) => api.revokeHandoffToken(tokenId),
    onSuccess: (_data, vars) => {
      if (vars.contractId != null) {
        qc.invalidateQueries({ queryKey: qk.handoffTokens(vars.contractId) });
      }
    },
  });
}

// Rental photos
export function useUploadRentalPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ contractId, kind, dataUrl }) =>
      api.uploadRentalPhoto(contractId, { kind, data_url: dataUrl }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: qk.rentalPhotos(vars.contractId) });
    },
  });
}
export function useDeleteRentalPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ photoId }) => api.deleteRentalPhoto(photoId),
    onSuccess: (_data, vars) => {
      if (vars.contractId != null) {
        qc.invalidateQueries({ queryKey: qk.rentalPhotos(vars.contractId) });
      }
    },
  });
}
