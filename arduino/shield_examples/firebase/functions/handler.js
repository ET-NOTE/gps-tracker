"use strict";
const { timingSafeEqual } = require("node:crypto");

// Testable core: never logs a request body, device key or service account credential.
function makeHandler({ getKey, deviceId, store, now = () => Date.now() }) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
    if (!req.is("application/json")) return res.status(415).json({ error: "JSON required" });
    if (!req.rawBody || req.rawBody.length > 1024) return res.status(413).json({ error: "Payload too large" });
    let key;
    try { key = getKey(); } catch { return res.status(503).json({ error: "Setup incomplete" }); }
    if (!/^[a-f0-9]{64}$/.test(key || "") || !/^[a-zA-Z0-9_.-]{1,40}$/.test(deviceId) || deviceId.includes("YOUR_"))
      return res.status(503).json({ error: "Setup incomplete" });
    const provided = req.get("x-device-key") || "";
    if (!/^[a-f0-9]{64}$/.test(provided) || !timingSafeEqual(Buffer.from(key), Buffer.from(provided)))
      return res.status(401).json({ error: "Device authentication failed" });
    const b = req.body, receivedAt = now();
    if (!b || Array.isArray(b) || typeof b !== "object" ||
        Object.keys(b).sort().join(",") !== "at,device_id,humidity_pct,temperature_c" ||
        b.device_id !== deviceId || !Number.isSafeInteger(b.at) ||
        b.at < Math.floor(receivedAt / 1000) - 300 || b.at > Math.floor(receivedAt / 1000) + 30 ||
        !Number.isFinite(b.temperature_c) || b.temperature_c < 0 || b.temperature_c > 50 ||
        !Number.isFinite(b.humidity_pct) || b.humidity_pct < 0 || b.humidity_pct > 100)
      return res.status(400).json({ error: "Invalid sensor sample" });
    try {
      const status = await store({ ...b, received_at_ms: receivedAt });
      if (status === 429) res.set("Retry-After", "60");
      return res.status(status).json(status === 200 ? { ok: true } : { error: status === 429 ? "Send at most once per minute" : "Older or conflicting sample" });
    } catch { return res.status(503).json({ error: "Storage unavailable; check console" }); }
  };
}
function sampleDecision(previous, next) {
  if (!previous) return 200;
  if (next.at === previous.at)
    return next.temperature_c === previous.temperature_c && next.humidity_pct === previous.humidity_pct ? 200 : 409;
  if (next.at < previous.at) return 409;
  if (next.received_at_ms - previous.received_at_ms < 50000) return 429;
  return 200;
}
module.exports = { makeHandler, sampleDecision };
