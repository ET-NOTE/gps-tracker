export function timeRange(hours, now = Date.now()) {
  return {
    since: new Date(now - hours * 3600000).toISOString(),
    until: new Date(now).toISOString(),
  };
}
export async function request(path, { method = "GET", body, signal } = {}) {
  const response = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response
    .json()
    .catch(() => ({ error: "응답을 읽지 못했습니다." }));
  if (!response.ok)
    throw Object.assign(
      new Error(data.error || "잠시 후 다시 시도해 주세요."),
      { status: response.status },
    );
  return data;
}
export const query = (params) =>
  new URLSearchParams(
    Object.entries(params).filter(([, v]) => v != null),
  ).toString();
export function csv(rows) {
  const cell = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return "\ufeff" + rows.map((row) => row.map(cell).join(",")).join("\r\n");
}
export async function exportReadings(id, range, signal) {
  let cursor = {},
    all = [],
    seen = new Set();
  while (true) {
    const page = await request(
      `/devices/${id}/readings?${query({ ...range, ...cursor, limit: 1000 })}`,
      { signal },
    );
    all.push(...page.items);
    if (all.length > 50000)
      throw new Error("기록이 많습니다. 조회 기간을 줄여 내려받아 주세요.");
    if (!page.next) break;
    const key = JSON.stringify(page.next);
    if (seen.has(key))
      throw new Error("페이지를 이어 읽지 못했습니다. 다시 시도해 주세요.");
    seen.add(key);
    cursor = page.next;
  }
  return csv([
    [
      "기록 시각(UTC)",
      "측정 시각(UTC)",
      "수신 시각(UTC)",
      "온도(°C)",
      "습도(%)",
      "PV(mV)",
      "CSQ",
      "망 등록",
      "펌웨어",
    ],
    ...all.map((r) => [
      r.recorded_at,
      r.measured_at,
      r.received_at,
      r.temp_c,
      r.hum_pct,
      r.pv_mv,
      r.csq,
      r.reg,
      r.build_tag,
    ]),
  ]);
}
