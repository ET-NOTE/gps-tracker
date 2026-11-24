// Axis helpers for the desktop line charts (corporate dashboard and analytics).

/** Rounded y ticks starting at 0: 4–5 steps of 1, 2, 2.5 or 5 × 10^n. All zero → 0/1/2/3. */
export function niceTicks(max) {
  if (!(max > 0)) return [0, 1, 2, 3];
  const raw = max / 4, power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(f => f * power).find(s => s >= raw);
  const count = Math.max(3, Math.ceil(max / step));
  return Array.from({ length: count + 1 }, (_, i) => Number((i * step).toPrecision(12)));
}

/** X label positions: every ceil(n / 6)-th point from the first, plus the last one. */
export function axisLabelIndexes(n) {
  if (n <= 0) return [];
  const step = Math.ceil(n / 6), picked = [];
  for (let i = 0; i < n; i += step) picked.push(i);
  if (picked.at(-1) !== n - 1) picked.push(n - 1);
  return picked;
}

/** 'YYYY-MM-DD' → 'MM.DD'; other labels are returned unchanged. */
export const shortDay = day => /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.slice(5).replace('-', '.') : String(day);
