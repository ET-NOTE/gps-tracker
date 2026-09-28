export const validCsq = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 31;

// API returns newest first. A missing fix, time gap, or rejected jump starts a new path.
export function pathSegments(locations) {
  const segments = [];
  let line = [],
    previous = null;
  const flush = () => {
    if (line.length > 1) segments.push(line);
    line = [];
  };
  [...locations].reverse().forEach((point) => {
    const valid =
      point.fix && Number.isFinite(point.lat) && Number.isFinite(point.lng);
    if (
      !valid ||
      ["discontinuity", "outlier"].includes(point.speed_reason) ||
      (previous &&
        Date.parse(point.recorded_at) - Date.parse(previous.recorded_at) >
          60000)
    )
      flush();
    if (valid) line.push([point.lat, point.lng]);
    previous = point;
  });
  flush();
  return segments;
}
