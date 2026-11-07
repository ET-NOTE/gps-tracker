// Never replace a server rejection with a browser estimate (or a cached receiver value).
export function serverSpeed(point) {
  const value = point?.speed_kmh;
  return point?.speed_source === 'server_coordinate_v1' && Number.isFinite(value) && value >= 0 && value <= 250
    ? value : null;
}

// Zoom level 별 클릭 가능한 dot 간격 (m). 확대 시 촘촘, 축소 시 sparse.
export function clickableIntervalM(zoomLevel) {
  if (zoomLevel <= 3)  return 30;
  if (zoomLevel <= 5)  return 60;
  if (zoomLevel <= 7)  return 120;
  if (zoomLevel <= 9)  return 250;
  return 500;
}
