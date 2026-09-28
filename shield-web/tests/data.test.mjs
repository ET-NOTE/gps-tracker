import test from "node:test";
import assert from "node:assert/strict";
import { csv, exportReadings } from "../src/api.js";
import { pathSegments, validCsq } from "../src/telemetry.js";

test("unknown CSQ does not become a valid zero signal", () => {
  for (const value of [null, undefined, -1, 99, "20", NaN, 1.2])
    assert.equal(validCsq(value), false);
  assert.equal(validCsq(0), true);
  assert.equal(validCsq(31), true);
});
test("GPS paths split across outages and rejected jumps", () => {
  const p = (seconds, extra = {}) => ({
    recorded_at: new Date(seconds * 1000).toISOString(),
    fix: true,
    lat: 37 + seconds / 10000,
    lng: 127,
    ...extra,
  });
  const rows = [
    p(0),
    p(2),
    p(4, { fix: false }),
    p(6),
    p(8),
    p(100),
    p(102),
    p(104, { speed_reason: "discontinuity" }),
    p(106),
  ];
  assert.deepEqual(
    pathSegments(rows.reverse()).map((s) => s.length),
    [2, 2, 2, 2],
  );
});
test("CSV quotes commas, newlines, quotes and formula text", () => {
  const result = csv([
    ["a,b", 'x"y', '=HYPERLINK("bad")', "hello\nworld", null],
  ]);
  assert.ok(result.startsWith('\ufeff"a,b","x""y","\'=HYPERLINK'));
  assert.ok(result.includes('"hello\nworld",""'));
});
test("CSV reads every page with the same range and cursor", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    return {
      ok: true,
      json: async () =>
        urls.length === 1
          ? {
              items: [{ build_tag: "first" }],
              next: { before: "2026-09-28T00:00:00Z", before_id: 7 },
            }
          : { items: [{ build_tag: "last" }], next: null },
    };
  });
  const result = await exportReadings(8, { since: "s", until: "u" });
  assert.equal(urls.length, 2);
  assert.ok(urls.every((u) => u.includes("since=s&until=u")));
  assert.ok(urls[1].includes("before_id=7"));
  assert.ok(result.includes("first") && result.includes("last"));
});
test("CSV fails as a whole when any later page fails", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () =>
    ++calls === 1
      ? { ok: true, json: async () => ({ items: [{}], next: { before: "x" } }) }
      : {
          ok: false,
          status: 500,
          json: async () => ({ error: "second page failed" }),
        },
  );
  await assert.rejects(exportReadings(1, {}), /second page failed/);
});
test("CSV repeated cursor cannot loop forever", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({ items: [], next: { before: "same" } }),
  }));
  await assert.rejects(exportReadings(1, {}), /페이지/);
});
test("CSV forwards cancellation", async (t) => {
  const controller = new AbortController();
  controller.abort();
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    assert.equal(signal, controller.signal);
    signal.throwIfAborted();
  });
  await assert.rejects(exportReadings(1, {}, controller.signal), {
    name: "AbortError",
  });
});
