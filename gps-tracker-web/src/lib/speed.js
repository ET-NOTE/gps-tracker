// (2026-07-28 F6-c) 속도·인터벌 공용 헬퍼.
//
// 이전엔 wsEventHandler.js + deviceLoader.js + Dashboard.jsx 세 곳에 각각 있던 중복 사본.
// F6-a-2 · F6-a-3 에서 Dashboard 는 정리했지만 wsEventHandler / deviceLoader 에 여전히
// 사본이 있어 debt register 에 등록됨. 이 라운드에서 lib/speed.js 로 통합.

import { haversineM } from './stops';

export function calcSpeedKmh(prev, next) {
  if (!prev?.lat || !prev?.lng || !prev?.recordedAt ||
      !next?.lat || !next?.lng || !next?.recordedAt) return null;
  const dt = new Date(next.recordedAt).getTime() - new Date(prev.recordedAt).getTime();
  if (!(dt > 0)) return null;
  const distM = haversineM(prev.lat, prev.lng, next.lat, next.lng);
  if (distM < 3) return 0;
  const speed = (distM / (dt / 1000)) * 3.6;
  return Number.isFinite(speed) ? Math.min(speed, 240) : null;
}

// Zoom level 별 클릭 가능한 dot 간격 (m). 확대 시 촘촘, 축소 시 sparse.
export function clickableIntervalM(zoomLevel) {
  if (zoomLevel <= 3)  return 30;
  if (zoomLevel <= 5)  return 60;
  if (zoomLevel <= 7)  return 120;
  if (zoomLevel <= 9)  return 250;
  return 500;
}
