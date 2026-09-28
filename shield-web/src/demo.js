export function demoData() {
  const now = Date.now();
  const points = Array.from({ length: 48 }, (_, i) => ({
    at: new Date(now - (47 - i) * 300000).toISOString(),
    temp_c: 23.2 + i * 0.035 + Math.sin(i / 5) * 0.38,
    hum_pct: 57 + Math.sin(i / 7) * 2.1,
    pv_mv: 4160 + Math.sin(i / 6) * 12,
  }));
  const latest = {
    ...points.at(-1),
    recorded_at: points.at(-1).at,
    received_at: new Date(now - 10000).toISOString(),
    measured_at: points.at(-1).at,
    csq: 24,
    reg: 5,
    build_tag: "데모 · 실제 단말 아님",
    gnss: 10,
  };
  return {
    device: {
      id: "demo",
      device_uid: "SHIELD-DEMO",
      display_name: "온습도 센서 01",
      last_seen_at: latest.received_at,
    },
    latest,
    position: { recorded_at: latest.recorded_at, lat: 37.5665, lng: 126.978 },
    received_today: 180,
    total: 48,
    chart: points,
    stats: {
      temp_min: 23.2,
      temp_avg: 24.1,
      temp_max: 25.2,
      hum_min: 55,
      hum_avg: 57,
      hum_max: 59,
    },
    items: points
      .slice()
      .reverse()
      .map((p, i) => ({
        ...p,
        id: i,
        recorded_at: p.at,
        measured_at: p.at,
        received_at: p.at,
        csq: 24,
        gnss: 10,
        build_tag: "데모",
      })),
  };
}
