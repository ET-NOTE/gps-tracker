// Desktop design display formats: bar values, dotted dates and units. Display only; exports keep raw values.

/** '20.4 %', '1 건', '740,000 원': integers as they are, other numbers with one decimal, a space before the unit. */
export function valueText(value, unit = '') {
  const n = Number(value) || 0;
  const text = Number.isInteger(n) ? n.toLocaleString('ko-KR') : n.toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return unit ? text + ' ' + unit : text;
}

/** One decimal always ('0.0', '95.0'). */
export const oneDecimal = value => (Number(value) || 0).toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Instant → '2026.11.20 10:42' in Korean time; '' when missing. */
export function dotDateTime(value) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '';
  return new Date(new Date(value).getTime() + 9 * 3600000).toISOString().slice(0, 16).replace('T', ' ').replace(/^(\d{4})-(\d{2})-(\d{2})/, '$1.$2.$3');
}

/** 'YYYY-MM-DD' (or an instant) → '2026.11.20'. Other text is returned unchanged. */
export function dotDay(value) {
  const text = String(value ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text.replaceAll('-', '.');
  return dotDateTime(text).slice(0, 10) || text;
}

/** Splits a trailing unit from text like '1,905,000원' → ['1,905,000', '원']; null when there is none. */
export function splitUnit(text) {
  const m = typeof text === 'string' && text.match(/^([-−]?[\d,.]+)\s*(원|명|건|대|곳|%|시간|일|km)$/);
  return m ? [m[1], m[2]] : null;
}
