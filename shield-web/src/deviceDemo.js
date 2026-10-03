import { demoData } from "./demo.js";
export function deviceDemo() {
  const data = demoData();
  const device = { ...data.device, display_name: "쉴드 체험 장치" };
  return {
    id: "demo",
    summary: {
      device, latest: data.latest, position: data.position,
      channels: [
        { id: "temperature", label: "온도", unit: "°C", active: true },
        { id: "humidity", label: "습도", unit: "%", active: true },
      ],
    },
    sim: { sim: {
      linked: true, last4: "1234", updated_at: data.latest.received_at,
      usage: { remaining_mb: 350, total_mb: 500, status: "Enabled", expires_at: null },
    } },
    readings: { items: data.items.slice(0, 5).map((r) => ({
      ...r, values_json: { temperature: r.temp_c, humidity: r.hum_pct },
    })) },
  };
}
