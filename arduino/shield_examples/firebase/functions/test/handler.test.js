"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { makeHandler, sampleDecision } = require("../handler");
const key = "a".repeat(64), now = 1790900000000;
const body = { device_id: "test-shield", at: now / 1000, temperature_c: 24.8, humidity_pct: 58 };
async function call({ payload = body, token = key, method = "POST", json = true, size = 200, secret = key, store } = {}) {
  let writes = 0;
  const handler = makeHandler({ getKey: () => secret, deviceId: "test-shield", now: () => now,
    store: store || (async () => { writes++; return 200; }) });
  const req = { method, body: payload, rawBody: Buffer.alloc(size), is: () => json, get: () => token };
  const res = { headers: {}, set(k,v) {this.headers[k]=v;return this;}, status(s) {this.code=s;return this;}, json(b) {this.body=b;return this;} };
  await handler(req,res);return { ...res, writes };
}
test("valid sample writes once", async () => { const r=await call();assert.equal(r.code,200);assert.equal(r.writes,1); });
for(const [name,options,code] of [
  ["missing key",{token:""},401], ["wrong key",{token:"b".repeat(64)},401],
  ["placeholder secret",{secret:"YOUR_KEY"},503], ["GET",{method:"GET"},405],
  ["non JSON",{json:false},415], ["large payload",{size:1025},413],
  ["different device",{payload:{...body,device_id:"other"}},400],
  ["stale sample",{payload:{...body,at:body.at-301}},400],
  ["future sample",{payload:{...body,at:body.at+31}},400],
  ["missing temperature",{payload:{at:body.at,device_id:body.device_id,humidity_pct:58}},400],
  ["string temperature",{payload:{...body,temperature_c:"24.8"}},400],
  ["NaN",{payload:{...body,temperature_c:NaN}},400],
  ["sensor range",{payload:{...body,humidity_pct:101}},400],
  ["unknown field",{payload:{...body,admin:true}},400],
  ["array",{payload:[]},400], ["null",{payload:null},400],
]) test(name,async()=>{const r=await call(options);assert.equal(r.code,code);assert.equal(r.writes,0);});
test("unknown storage failure is not success",async()=>assert.equal((await call({store:async()=>{throw Error("private failure");}})).code,503));
test("rate limit returns delay",async()=>{const r=await call({store:async()=>429});assert.equal(r.code,429);assert.equal(r.headers["Retry-After"],"60");});
test("idempotency, ordering and rate decisions",()=>{
  const prev={...body,received_at_ms:now};
  assert.equal(sampleDecision(undefined,prev),200);
  assert.equal(sampleDecision(prev,{...prev,received_at_ms:now+1}),200);
  assert.equal(sampleDecision(prev,{...prev,humidity_pct:59}),409);
  assert.equal(sampleDecision(prev,{...prev,at:body.at-1}),409);
  assert.equal(sampleDecision(prev,{...prev,at:body.at+1,received_at_ms:now+1000}),429);
  assert.equal(sampleDecision(prev,{...prev,at:body.at+60,received_at_ms:now+60000}),200);
});
