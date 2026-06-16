// Per-device color persistence (localStorage).
// 사용자가 디바이스 카드에서 색을 고를 수 있고, 안 고르면 device_id 해시로 자동 배정.

export const PALETTE = [
  '#e8b4b8', '#5fc9c9', '#ffd166', '#a78bfa', '#f87171',
  '#34d399', '#60a5fa', '#fb923c', '#f472b6', '#facc15',
];

const KEY = (id) => `dev_color_${id}`;

/**
 * 우선순위:
 *   1) 서버 응답 device.color (있으면 모든 기기에서 동일)
 *   2) 로컬 캐시 (예전 사용자가 골랐던 값)
 *   3) device_id 해시로 자동 배정
 * dev: { id, color? } 형태의 device 객체.
 */
export function getDeviceColor(dev) {
  if (typeof dev === 'object' && dev !== null) {
    if (dev.color) return dev.color;
    const cached = localStorage.getItem(KEY(dev.id));
    if (cached) return cached;
    return PALETTE[Math.abs(Number(dev.id)) % PALETTE.length];
  }
  // 호환: id만 넘긴 경우
  const id = dev;
  const cached = localStorage.getItem(KEY(id));
  if (cached) return cached;
  return PALETTE[Math.abs(Number(id)) % PALETTE.length];
}

export function setDeviceColorLocal(deviceId, color) {
  if (color) localStorage.setItem(KEY(deviceId), color);
  else localStorage.removeItem(KEY(deviceId));
}

// 5분 이상 무소식이면 stale (회색 처리 대상)
export const STALE_THRESHOLD_MS = 5 * 60 * 1000;

export function isStale(lastSeenAt) {
  if (!lastSeenAt) return true;
  return (Date.now() - new Date(lastSeenAt).getTime()) > STALE_THRESHOLD_MS;
}

export function ageString(lastSeenAt) {
  if (!lastSeenAt) return '—';
  const ms = Date.now() - new Date(lastSeenAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s 전`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

// ─── 디바이스 상태 분류 ────────────────────────────────────────
// 운행/대기/수면/GPS불량/오프라인/꺼짐 — 디바이스 카드/디테일에서 활용.
// dev: { last_seen_at, last_fix_at, last_event_kind, last_event_at } + meta(WS): { vbatMv, fix }

export const STATUS = {
  ACTIVE:      { id: 'active',      label: '활성',       color: 'var(--accent)' },
  IDLE:        { id: 'idle',        label: '대기',       color: 'var(--text-2)' },
  SLEEPING:    { id: 'sleeping',    label: '수면 중',    color: 'var(--primary)' },
  GPS_LOSS:    { id: 'gps_loss',    label: 'GPS 신호↓', color: '#fbbf24'        },
  SIGNAL_LOSS: { id: 'signal_loss', label: '통신 두절',  color: '#f97316'        },
  OFFLINE:     { id: 'offline',     label: '오프라인',   color: 'var(--danger)'  },
  LOST:        { id: 'lost',        label: '꺼진 후 무소식', color: 'var(--danger)' },
  LOW_BATT:    { id: 'low_batt',    label: '저전압',     color: '#f87171'        },
  UNKNOWN:     { id: 'unknown',     label: '데이터 없음', color: 'var(--text-3)'  },
};

const MIN  = 60 * 1000;
const HOUR = 60 * MIN;

export function classifyDevice(dev, meta) {
  if (!dev?.last_seen_at) return STATUS.UNKNOWN;
  const now = Date.now();
  const seen = new Date(dev.last_seen_at).getTime();
  const seenAge = now - seen;
  const lastEvent = dev.last_event_kind || null;
  const eventAt = dev.last_event_at ? new Date(dev.last_event_at).getTime() : 0;

  // 1) 의도적 sleep — sleep_enter 이벤트 이후 ping 이 들어오지 않은 경우만.
  //    ping 이 들어오면 last_seen_at > last_event_at 이라 이 branch 안 탐.
  //    (이전 버그: ages 끼리 비교했더니 깨어난 후에도 영원히 SLEEPING 으로 분류됨)
  if (lastEvent === 'sleep_enter' && eventAt > 0 && seen <= eventAt + 1000) {
    if (seenAge > 24 * HOUR) return STATUS.LOST;     // 24h 넘게 안 깨어남
    return STATUS.SLEEPING;
  }
  // 2) 저전압 — 가장 최근 페이로드의 vbat
  if (meta?.vbatMv && meta.vbatMv < 3500) return STATUS.LOW_BATT;
  // 3) 긴 무소식
  if (seenAge > 30 * MIN) return STATUS.OFFLINE;
  if (seenAge >  5 * MIN) return STATUS.SIGNAL_LOSS;
  // 4) 활성인데 GPS 가 안 잡힘 — 지하/실내 추정
  if (dev.last_fix_at) {
    const fixGap = seen - new Date(dev.last_fix_at).getTime();
    if (fixGap > 5 * MIN) return STATUS.GPS_LOSS;
  } else {
    return STATUS.GPS_LOSS;
  }
  // 5) 활성 — 정상
  return STATUS.ACTIVE;
}
