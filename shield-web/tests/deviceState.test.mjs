import test from "node:test";
import assert from "node:assert/strict";
import { simState } from "../src/deviceState.js";
test("missing quota is never treated as zero or a recharge warning", () => {
  assert.equal(simState({linked: true}).warning, false);
  assert.equal(simState({linked: true, usage:{remaining_mb:null}}).warning, false);
  assert.equal(simState({linked: true, usage:{remaining_mb:0}}).warning, true);
  assert.equal(simState({linked: true, usage:{remaining_mb:20,status:"Enabled"}}).warning, false);
});
test("expired and disabled SIMs need attention even with remaining quota", () => {
  const now=Date.parse("2026-10-01T00:00:00Z");
  assert.equal(simState({linked:true,usage:{remaining_mb:100,expires_at:"2026-09-30T00:00:00Z",status:"Enabled"}},now).warning,true);
  assert.equal(simState({linked:true,usage:{remaining_mb:100,status:"Disabled"}},now).warning,true);
});
