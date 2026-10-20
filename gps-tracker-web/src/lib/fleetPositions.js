// Fleet receives both polled snapshots and live fixes. A slower REST snapshot
// must not move a marker back over a newer live fix.
export function validFleetPosition(point) {
  return point?.lat != null && point?.lng != null &&
    Number.isFinite(point.lat) && Number.isFinite(point.lng) &&
    Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;
}

export function latestFleetPosition(previous, incoming) {
  if (!validFleetPosition(incoming)) return previous;
  const before = Date.parse(previous?.recordedAt);
  const after = Date.parse(incoming.recordedAt);
  if (previous && Number.isFinite(before) && (!Number.isFinite(after) || after < before)) return previous;
  if (previous && previous.lat === incoming.lat && previous.lng === incoming.lng && previous.recordedAt === incoming.recordedAt) return previous;
  return incoming;
}
