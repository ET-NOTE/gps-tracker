// 이미지 Canvas 압축 — maxPx: 긴 변 최대 픽셀, quality: JPEG 품질 0~1.
// 결과 크기가 대략 300~700KB 수준으로 유지돼 nginx 1MB 제한을 통과함.
function compressImage(file, maxPx = 900, quality = 0.82) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const ratio = Math.min(1, maxPx / Math.max(img.width, img.height));
      const w = Math.round(img.width  * ratio);
      const h = Math.round(img.height * ratio);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => resolve(blob ?? file), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// 도메인 감지: gps.serial.kr 은 prefix 없이 /api/v1, 그 외 (seriallog.com 등) 는 /gps-tracker/api/v1
const BASE = (typeof window !== 'undefined' && window.location.hostname === 'gps.serial.kr')
  ? '/api/v1'
  : '/gps-tracker/api/v1';

// 토큰 저장소 — "로그인 기억하기" 옵션에 따라 분기:
//   localStorage: 브라우저 닫아도 유지 (remember_me=true)
//   sessionStorage: 탭 닫으면 사라짐 (remember_me=false)
// activeStorage 는 양쪽 확인 — refresh 회전 시 같은 storage 유지.
export function activeStorage() {
  if (localStorage.getItem('access_token'))   return localStorage;
  if (sessionStorage.getItem('access_token')) return sessionStorage;
  return null;
}
function getToken() {
  const s = activeStorage();
  return s ? s.getItem('access_token') : null;
}

// remember=true → localStorage, false → sessionStorage. 둘 다 미리 클리어해서 충돌 방지.
export function setTokens(access, refresh, remember = true) {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  sessionStorage.removeItem('access_token');
  sessionStorage.removeItem('refresh_token');
  const s = remember ? localStorage : sessionStorage;
  s.setItem('access_token', access);
  s.setItem('refresh_token', refresh);
  schedulePreemptiveRefresh(access);
}

export function clearTokens() {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  sessionStorage.removeItem('access_token');
  sessionStorage.removeItem('refresh_token');
  clearTimeout(refreshTimer);
  refreshTimer = null;
}

// ── 사전 refresh ─────────────────────────────────────────────────────
// access JWT 의 exp 를 파싱해서 만료 60초 전에 refresh 예약.
// 사용자가 활성으로 API 호출 안 하다가도 토큰을 사전에 갱신해두므로,
// 만료 직후 401 → race 로 인한 logout 위험을 거의 제거.
let refreshTimer = null;

function decodeExp(accessToken) {
  try {
    const [, payload] = accessToken.split('.');
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch { return null; }
}

function schedulePreemptiveRefresh(accessToken) {
  clearTimeout(refreshTimer);
  refreshTimer = null;
  const expMs = decodeExp(accessToken);
  if (!expMs) return;
  // 만료 60초 전. 이미 임박했으면 즉시.
  const delay = Math.max(0, expMs - Date.now() - 60_000);
  refreshTimer = setTimeout(() => { tryRefresh().catch(() => {}); }, delay);
}

// 앱 부팅 시 기존 토큰이 있으면 사전 refresh 스케줄.
const _bootToken = getToken();
if (_bootToken) schedulePreemptiveRefresh(_bootToken);

// ── refresh 실행 ─────────────────────────────────────────────────────
// 반환값:
//   true       — 성공
//   'unauth'   — 서버가 401/403 (refresh 토큰 만료/취소) — 로그아웃 필요
//   'transient'— 네트워크/5xx — 토큰 유지, 다음에 재시도
let refreshing = null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function tryRefresh() {
  if (refreshing) return refreshing;
  const s = activeStorage();
  const rt = s ? s.getItem('refresh_token') : null;
  if (!rt) return 'unauth';

  refreshing = (async () => {
    // 네트워크 깜빡임 (모바일 셀룰러) 대응: 일시 오류면 한 번 더 시도.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: rt }),
        });
        if (res.status === 401 || res.status === 403) {
          // 진짜 인증 실패 — 더 시도해도 의미 없음
          return 'unauth';
        }
        if (!res.ok) {
          if (attempt === 0) { await sleep(500); continue; }
          return 'transient';
        }
        const data = await res.json();
        // 같은 storage 에 새 토큰 쌍 기록 (remember 정책 유지). storage 가 그 사이
        // 비워졌을 가능성 (다른 탭 logout 등) 도 대비.
        const cur = activeStorage() || s;
        cur.setItem('access_token',  data.access_token);
        cur.setItem('refresh_token', data.refresh_token);
        schedulePreemptiveRefresh(data.access_token);
        return true;
      } catch {
        // 네트워크 fetch reject — 일시
        if (attempt === 0) { await sleep(500); continue; }
        return 'transient';
      }
    }
    return 'transient';
  })();

  try { return await refreshing; }
  finally { refreshing = null; }
}

async function req(method, path, body, retry = true) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && retry) {
    const r = await tryRefresh();
    if (r === 'unauth') {
      // 진짜 만료/취소 — 로그아웃 후 reload
      clearTokens();
      window.location.reload();
      return;
    }
    if (r === 'transient') {
      // 네트워크 일시 오류 — 토큰 유지, 호출자에게 에러 전달 (사용자가 다시 시도 가능)
      throw Object.assign(new Error('네트워크 연결이 불안정합니다. 잠시 후 다시 시도해주세요.'),
                          { status: 0, transient: true });
    }
    return req(method, path, body, false);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.error || err.message || res.statusText), { status: res.status });
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export const api = {
  // auth
  register: (body) => req('POST', '/auth/register', body),     // {email,password,phone,otp_code,display_name?}
  login:    (email, password, remember_me = false) =>
              req('POST', '/auth/login', { email, password, remember_me }),
  sendOtp:  (phone) => req('POST', '/auth/send-otp', { phone }),

  // 아이디 찾기 (2-step: 번호 OTP → 결과 ≤3개)
  findIdSendOtp:    (phone) => req('POST', '/auth/find-id/send-otp', { phone }),
  findIdVerify:     (phone, otp_code) =>
                      req('POST', '/auth/find-id/verify', { phone, otp_code }),
  // 비밀번호 재설정 (email + phone OTP → 비번 변경)
  resetSendOtp:     (email, phone) =>
                      req('POST', '/auth/password-reset/send-otp', { email, phone }),
  resetVerify:      (email, phone, otp_code, new_password) =>
                      req('POST', '/auth/password-reset/verify',
                          { email, phone, otp_code, new_password }),

  // devices
  listDevices:  ()                      => req('GET',    '/devices'),
  pairDevice:   (params) => req('POST', '/devices/pair', params),  // { device_uid?, iccid?, display_name? }
  updateDevice: (id, patch)             => req('PATCH',  `/devices/${id}`, patch),
  uploadCarImage: async (id, file) => {
    // 업로드 전 Canvas로 압축 — nginx 1MB 제한 대응.
    const compressed = await compressImage(file, 900, 0.82);
    const form = new FormData();
    form.append('image', compressed, 'car.jpg');
    const token = getToken();
    const res = await fetch(`${BASE}/devices/${id}/car-image`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  unpairDevice: (id, opts = {}) => {
    const purge = opts.purge ? '?purge=true' : '';
    return req('DELETE', `/devices/${id}${purge}`);
  },

  // user profile
  getMe:           ()       => req('GET',    '/auth/me'),
  updateMe:        (patch)  => req('PATCH',  '/auth/me', patch),
  changePassword:  (current_password, new_password) =>
                      req('POST', '/auth/me/password', { current_password, new_password }),
  cleanupMe:       (body) => req('POST', '/auth/me/cleanup', body),
  deleteMe:        (password) => req('DELETE', '/auth/me', { password }),

  // user prefs (filter_device_id 등 UI 영속) — top-level JSON 병합
  getMyPrefs:      ()       => req('GET',    '/auth/me/prefs'),
  patchMyPrefs:    (patch)  => req('PATCH',  '/auth/me/prefs', patch),

  // 다중 전화번호 관리
  listPhones:      ()                        => req('GET',    '/auth/phones'),
  sendPhoneOtp:    (phone)                   => req('POST',   '/auth/phones', { phone }),
  verifyPhone:     (phone, otp_code, set_primary = false) =>
                                                req('POST',   '/auth/phones/verify', { phone, otp_code, set_primary }),
  setPrimaryPhone: (id)                      => req('PUT',    `/auth/phones/${id}/primary`),
  deletePhone:     (id)                      => req('DELETE', `/auth/phones/${id}`),

  // notification settings
  getNotificationSettings:    () => req('GET',   '/notifications/settings'),
  updateNotificationSettings: (patch) => req('PATCH', '/notifications/settings', patch),

  // device extras (Phase C)
  getSimInfo:    (id) => req('GET',  `/devices/${id}/sim`),
  refreshSimInfo:(id) => req('POST', `/devices/${id}/sim/refresh`),
  getAuditLog:   (id) => req('GET',  `/devices/${id}/audit`),
  wipeDevice:    (id) => req('POST', `/devices/${id}/wipe`),

  // Round 4: lifecycle 이벤트 (wake/sleep/low_batt/offline 등)
  getDeviceEvents: (id) => req('GET', `/devices/${id}/events`),

  // 운행 통계 (Phase D)
  getDailyStats: (id, params = {}) => {
    const q = new URLSearchParams();
    if (params.from)  q.set('from',  params.from);
    if (params.to)    q.set('to',    params.to);
    if (params.limit) q.set('limit', params.limit);
    const qs = q.toString();
    return req('GET', `/devices/${id}/stats/daily${qs ? '?' + qs : ''}`);
  },

  // geofences
  listGeofences:        () => req('GET',    '/geofences'),
  createGeofence:       (body) => req('POST',   '/geofences', body),
  updateGeofence:       (id, body) => req('PATCH',  `/geofences/${id}`, body),
  deleteGeofence:       (id) => req('DELETE', `/geofences/${id}`),
  geofenceHistoryAll:   () => req('GET',    '/geofences/history'),
  geofenceHistoryOne:   (id) => req('GET',  `/geofences/${id}/history`),

  // 디바이스가 fix 데이터를 남긴 KST 날짜 목록 (daily_stats catchup 대비 fallback)
  getActiveDates: (deviceId) => req('GET', `/devices/${deviceId}/active-dates`),

  // locations
  listLocations: (deviceId, params = {}) => {
    const q = new URLSearchParams();
    if (params.limit)    q.set('limit',    params.limit);
    if (params.since)    q.set('since',    params.since);
    if (params.until)    q.set('until',    params.until);
    if (params.fix_only) q.set('fix_only', 'true');
    const qs = q.toString();
    return req('GET', `/devices/${deviceId}/locations${qs ? '?' + qs : ''}`);
  },

  // 공유 링크 (Phase D Round 2)
  listShares:   (deviceId)              => req('GET',    `/devices/${deviceId}/shares`),
  createShare:  (deviceId, body)        => req('POST',   `/devices/${deviceId}/shares`, body),
  revokeShare:  (shareId)               => req('DELETE', `/shares/${shareId}`),
  extendShare:  (shareId, extra_hours)  => req('POST',   `/shares/${shareId}/extend`, { extra_hours }),

  // AI 경로 분석 (Round 3)
  aiUsageToday:    () => req('GET',  '/ai/usage'),
  analyzeRoute:    (deviceId, date) => req('POST', `/devices/${deviceId}/route/analyze`, { date }),
  // AI 분석 영구 이력
  listAiAnalyses:  (deviceId, params = {}) => {
    const q = new URLSearchParams();
    if (params.date)  q.set('date',  params.date);
    if (params.limit) q.set('limit', params.limit);
    const qs = q.toString();
    return req('GET', `/devices/${deviceId}/ai-analyses${qs ? '?' + qs : ''}`);
  },
  getAiAnalysis:   (id) => req('GET',    `/ai-analyses/${id}`),
  deleteAiAnalysis:(id) => req('DELETE', `/ai-analyses/${id}`),

  // 관리자 (role='admin' 만 접근 가능)
  adminListUsers:        ()         => req('GET',  '/admin/users'),
  adminUserDetail:       (id)       => req('GET',  `/admin/users/${id}`),
  adminUserDevices:      (id)       => req('GET',  `/admin/users/${id}/devices`),
  adminImpersonate:      (id)       => req('POST', `/admin/users/${id}/impersonate`),
  adminTopupSim:         (iccid, mb = 500) => req('POST', `/admin/sims/${encodeURIComponent(iccid)}/topup`, { mb }),
  adminListDevices:      ()         => req('GET',  '/admin/devices'),
  adminDeviceDetail:     (id)       => req('GET',  `/admin/devices/${id}`),

  // 포인트 (1 credit = 1 KRW)
  getCreditBalance:      () => req('GET',  '/credits/balance'),
  getCreditLog:          () => req('GET',  '/credits/log'),
  selfTopupCredit:       (amount) => req('POST', '/credits/topup', { amount }),
  // 포인트 충전 요청 (사용자 → 관리자 승인)
  listMyCreditRequests:  () => req('GET',  '/credits/requests'),
  createCreditRequest:   (amount, note) => req('POST', '/credits/requests', { amount, note }),
  cancelMyCreditRequest: (id) => req('POST', `/credits/requests/${id}/cancel`),

  // Toss Payments — 직접 결제로 포인트 충전
  tossConfig:        () => req('GET',  '/payments/toss/config'),
  tossInit:          (amount) => req('POST', '/payments/toss/init', { amount }),
  tossConfirm:       (body)   => req('POST', '/payments/toss/confirm', body),
  tossMarkFailed:    (orderId, code, message) =>
                        req('POST', '/payments/toss/fail', { orderId, code, message }),
  listMyOrders:      () => req('GET',  '/payments/orders'),
  // 관리자
  adminListCreditReqs:   () => req('GET',  '/admin/credits/requests'),
  adminApproveCreditReq: (id) => req('POST', `/admin/credits/requests/${id}/approve`),
  adminRejectCreditReq:  (id, reason) => req('POST', `/admin/credits/requests/${id}/reject`, { reason }),

  // SIM 충전 요청 (사용자 → 관리자)
  simTopupPricing:       () => req('GET',  '/sim-requests/pricing'),
  listMySimRequests:     () => req('GET',  '/sim-requests'),
  createSimRequest:      (device_id, data_mb) => req('POST', '/sim-requests', { device_id, data_mb }),
  cancelMySimRequest:    (id) => req('POST', `/sim-requests/${id}/cancel`),
  // 관리자
  adminListSimRequests:  () => req('GET',  '/admin/sim-requests'),
  adminProcessSimReq:    (id) => req('POST', `/admin/sim-requests/${id}/process`),
  // opts.refresh=true → order 강제 재조회 (보통 캐시 hit). opts.refresh_sim=true → SIM 라이브 호출.
  adminSimRequestOrder:  (id, opts = {}) => {
    const q = new URLSearchParams();
    if (opts.refresh)     q.set('refresh', '1');
    if (opts.refresh_sim) q.set('refresh_sim', '1');
    const qs = q.toString();
    return req('GET', `/admin/sim-requests/${id}/order${qs ? '?' + qs : ''}`);
  },
  adminManualCompleteSimReq: (id) => req('POST', `/admin/sim-requests/${id}/manual-complete`),
  adminManualFailSimReq:     (id) => req('POST', `/admin/sim-requests/${id}/manual-fail`),
  adminCancelSimReq:     (id) => req('POST', `/admin/sim-requests/${id}/cancel`),

  // 1:1 채팅 (사용자)
  chatMyThread:          () => req('GET',  '/chat/thread'),
  chatMyMessages:        (afterId) => {
    const qs = afterId ? `?after_id=${afterId}` : '';
    return req('GET', `/chat/messages${qs}`);
  },
  chatSendUser:          (body) => req('POST', '/chat/messages', { body }),
  chatMarkReadUser:      () => req('POST', '/chat/read'),
  // 계정 유형 (rentcar/corporate_fleet/delivery/unspecified)
  getAccountType:        () => req('GET',  '/me/account-type'),
  setAccountType:        (account_type) => req('PATCH', '/me/account-type', { account_type }),
  setDeviceAccountType:  (deviceId, account_type) => req('PATCH', `/devices/${deviceId}/account-type`, { account_type }),

  // 법인운행 — 회사 정보 / 직원
  getCorporateInfo:      () => req('GET',  '/corporate/info'),
  putCorporateInfo:      (body) => req('PUT', '/corporate/info', body),
  listStaff:             () => req('GET',  '/corporate/staff'),
  createStaff:           (body) => req('POST', '/corporate/staff', body),
  updateStaff:           (id, body) => req('PATCH', `/corporate/staff/${id}`, body),
  removeStaff:           (id) => req('DELETE', `/corporate/staff/${id}`),
  // 법인운행 — 운행/주석
  listTrips:             (deviceId, params = {}) => {
    const q = new URLSearchParams();
    if (params.from) q.set('from', params.from);
    if (params.to)   q.set('to',   params.to);
    const qs = q.toString();
    return req('GET', `/corporate/devices/${deviceId}/trips${qs ? '?' + qs : ''}`);
  },
  upsertTripAnnotation:  (deviceId, body) =>
    req('PATCH', `/corporate/devices/${deviceId}/trips/annotation`, body),
  // CSV 다운로드 URL (브라우저가 직접 GET — 인증 헤더 필요해서 fetch 후 blob)
  tripsCsv: async (deviceId, params = {}) => {
    const q = new URLSearchParams();
    if (params.from) q.set('from', params.from);
    if (params.to)   q.set('to',   params.to);
    const qs = q.toString();
    const tok = getToken(); // activeStorage() orqali — sessionStorage foydalanuvchilari uchun ham ishlaydi
    const res = await fetch(`${BASE}/corporate/devices/${deviceId}/trips.csv${qs ? '?' + qs : ''}`, {
      headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || res.statusText);
    }
    const blob = await res.blob();
    const cd   = res.headers.get('content-disposition') || '';
    // filename* utf-8 우선, 없으면 filename, 없으면 default
    const m1 = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    const m2 = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
    const filename = m1 ? decodeURIComponent(m1[1])
                   : m2 ? decodeURIComponent(m2[1])
                        : `trips_${deviceId}.csv`;
    return { blob, filename };
  },
  // 법인운행 — 구독
  getCorporateSubscription:  () => req('GET', '/corporate/subscription'),
  buyCorporateSubscription:  () => req('POST', '/corporate/subscription'),

  // 1:1 채팅 (관리자)
  adminChatThreads:      () => req('GET',  '/admin/chat/threads'),
  adminChatMessages:     (threadId, afterId) => {
    const qs = afterId ? `?after_id=${afterId}` : '';
    return req('GET', `/admin/chat/threads/${threadId}/messages${qs}`);
  },
  adminChatSend:         (threadId, body) => req('POST', `/admin/chat/threads/${threadId}/messages`, { body }),
  adminChatMarkRead:     (threadId) => req('POST', `/admin/chat/threads/${threadId}/read`),
  // 채팅 통합 검색
  adminChatSearch:       (params = {}) => {
    const qs = new URLSearchParams();
    if (params.user_id) qs.set('user_id', params.user_id);
    if (params.user)    qs.set('user', params.user);
    if (params.q)       qs.set('q', params.q);
    if (params.from)    qs.set('from', params.from);
    if (params.to)      qs.set('to', params.to);
    if (params.limit)   qs.set('limit', params.limit);
    return req('GET', `/admin/chat/search?${qs.toString()}`);
  },

  // 결제 내역 (관리자 — 전체)
  adminListPayments:     (params = {}) => {
    const qs = new URLSearchParams();
    if (params.user_id) qs.set('user_id', params.user_id);
    if (params.status)  qs.set('status', params.status);
    if (params.q)       qs.set('q', params.q);
    if (params.limit)   qs.set('limit', params.limit);
    return req('GET', `/admin/payments?${qs.toString()}`);
  },
};

// 공유 링크 — 인증 없이 호출 (별도 fetch).
export async function fetchSharedView(token) {
  const res = await fetch(`${BASE}/share/${encodeURIComponent(token)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.error || res.statusText), { status: res.status });
  }
  return res.json();
}

export async function fetchSharedLocations(token, params = {}) {
  const q = new URLSearchParams();
  if (params.limit)    q.set('limit',    params.limit);
  if (params.since)    q.set('since',    params.since);
  if (params.until)    q.set('until',    params.until);
  if (params.fix_only) q.set('fix_only', 'true');
  const qs = q.toString();
  const res = await fetch(`${BASE}/share/${encodeURIComponent(token)}/locations${qs ? '?' + qs : ''}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.error || res.statusText), { status: res.status });
  }
  return res.json();
}

// 공개 토큰의 디바이스 일별 fix 카운트. 시커 날짜 리스트용.
export async function fetchSharedDailyStats(token, { limit } = {}) {
  const q = new URLSearchParams();
  if (limit) q.set('limit', limit);
  const qs = q.toString();
  const res = await fetch(`${BASE}/share/${encodeURIComponent(token)}/daily_stats${qs ? '?' + qs : ''}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.error || res.statusText), { status: res.status });
  }
  return res.json();
}
