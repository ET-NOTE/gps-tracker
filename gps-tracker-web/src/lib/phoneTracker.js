// (2026-07-29) 스마트폰 tracker — 연구소 토글에서 활성화.
//
// 흐름:
//   1) start() — Geolocation permission 요청 → api.pairPhoneDevice() → localStorage 저장
//   2) watchPosition() 으로 위치 추적. 30s 간격 throttle → POST /ingest
//   3) stop() — watchPosition clear. Device 는 살아있음 (unpair 는 사용자 명시 액션에서).
//
// device_uid = "phone-{user_id}-{client_uuid}"
//   client_uuid 는 localStorage 에 영구 보관. 브라우저/기기 초기화 시 새 UUID → 새 device.
//
// Browser 한계:
//   - 백그라운드 tracking = Tab 열려있어야 함 (visibilityChange 안 감지 이슈 있음).
//   - Flutter WebView 에서 실행 시엔 Flutter 가 background 지원 (플랫폼 API 로).
//   - 이 파일은 browser 우선 구현. Flutter bridge 는 window.__phoneTrackerBridge 확인.

import { api } from '../api';

const STORAGE_KEY = 'phone_tracker_uuid';
const POST_MIN_INTERVAL_MS = 30_000;      // 30s throttle — POST /ingest 최소 간격
const HIGH_ACCURACY = true;

let watchId = null;
let deviceUid = null;
let lastPostMs = 0;
let queuedPos = null;
let flushTimer = null;

function getOrCreateUuid() {
  let uuid = localStorage.getItem(STORAGE_KEY);
  if (!uuid) {
    // crypto.randomUUID (모던 브라우저) fallback for older = Math.random hex
    uuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
    localStorage.setItem(STORAGE_KEY, uuid);
  }
  return uuid;
}

function detectPlatform() {
  const ua = navigator.userAgent || '';
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  return 'web';
}

async function ingestPos(pos) {
  if (!deviceUid) return;
  const { latitude: lat, longitude: lng, accuracy, altitude, speed, heading } = pos.coords;
  // 백엔드 ingest payload — 기존 firmware POST 와 호환. lte fix 로 표기.
  const payload = {
    device_uid: deviceUid,
    ts: Math.floor(pos.timestamp / 1000),
    lte: {
      fix: true,
      lat, lng,
      sat: null,
      hdop: accuracy ? Math.round(accuracy) : null,
      alt: altitude,
      speed_kmh: (typeof speed === 'number' && speed >= 0) ? speed * 3.6 : null,
      heading: (typeof heading === 'number' && heading >= 0) ? heading : null,
    },
    // 폰은 배터리 mV 개념 없음 — null.
    vbat_mv: null,
  };
  try {
    await fetch(new URL('/api/v1/ingest', window.location.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.warn('phone tracker: ingest failed', e);
  }
}

function schedulePost(pos) {
  queuedPos = pos;
  const now = Date.now();
  const elapsed = now - lastPostMs;
  if (elapsed >= POST_MIN_INTERVAL_MS) {
    lastPostMs = now;
    const p = queuedPos; queuedPos = null;
    ingestPos(p);
    return;
  }
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!queuedPos) return;
    lastPostMs = Date.now();
    const p = queuedPos; queuedPos = null;
    ingestPos(p);
  }, POST_MIN_INTERVAL_MS - elapsed);
}

/**
 * 위치 tracking 시작. 최초 호출 시 device 자동 페어링 + Geolocation 권한 요청.
 * @returns { device } — 페어링된 device 정보 (fetchdevice 결과)
 * @throws Error — 권한 거부 / 브라우저 미지원 / 서버 실패
 */
export async function startPhoneTracker() {
  if (!('geolocation' in navigator)) {
    throw new Error('이 브라우저는 위치 기능을 지원하지 않습니다.');
  }
  // 1) permission — getCurrentPosition 이 prompt 트리거.
  const firstPos = await new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: HIGH_ACCURACY,
      timeout: 15_000,
      maximumAge: 0,
    });
  });

  // 2) pair phone device — idempotent.
  const uuid = getOrCreateUuid();
  const device = await api.pairPhoneDevice(uuid, '내 스마트폰', detectPlatform());
  deviceUid = device.device_uid;

  // 3) 첫 fix 즉시 전송.
  await ingestPos(firstPos);
  lastPostMs = Date.now();

  // 4) watchPosition — 지속 갱신.
  watchId = navigator.geolocation.watchPosition(
    (pos) => schedulePost(pos),
    (err) => console.warn('phone tracker: watch err', err),
    { enableHighAccuracy: HIGH_ACCURACY, timeout: 30_000, maximumAge: 10_000 },
  );
  return device;
}

/** 위치 tracking 중단. Device 는 살아있음 (unpair 는 별도). */
export function stopPhoneTracker() {
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  queuedPos = null;
  lastPostMs = 0;
  deviceUid = null;
}

/** 진행 중인지 여부 (persistence 는 lab_phone_tracker pref) */
export function isPhoneTrackerRunning() {
  return watchId != null;
}
