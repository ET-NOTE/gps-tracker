#!/usr/bin/env python3
"""WS /gps-tracker/ws/realtime end-to-end:
register → pair (own) + create stranger device → connect WS as user1 → subscribe own+stranger
→ trigger ingest for both → expect to receive only the owned device's location event.
"""
import asyncio, json, os, ssl, sys, time
import urllib.request

import websockets

BASE = "https://seriallog.com/gps-tracker"
WS_BASE = "wss://seriallog.com/gps-tracker"

def http(method, path, *, headers=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

async def main():
    ts = int(time.time())
    user1 = {"email": f"ws-u1-{ts}@seriallog.test", "password": "hunter2hunter"}
    user2 = {"email": f"ws-u2-{ts}@seriallog.test", "password": "hunter2hunter"}
    uid_owned    = f"ws-owned-{ts}"
    uid_stranger = f"ws-stranger-{ts}"

    # 두 유저 만들기, user1이 owned 페어링, user2가 stranger 페어링
    r1 = http("POST", "/api/v1/auth/register", body=user1)
    r2 = http("POST", "/api/v1/auth/register", body=user2)
    h1 = {"Authorization": f"Bearer {r1['access_token']}"}
    h2 = {"Authorization": f"Bearer {r2['access_token']}"}

    p1 = http("POST", "/api/v1/devices/pair", headers=h1, body={"device_uid": uid_owned})
    p2 = http("POST", "/api/v1/devices/pair", headers=h2, body={"device_uid": uid_stranger})
    did_owned = p1["id"]
    did_stranger = p2["id"]
    print(f"user1.access={r1['access_token'][:20]}... owned_id={did_owned} stranger_id={did_stranger}")

    received = []
    ack = None

    url = f"{WS_BASE}/ws/realtime?token={r1['access_token']}"
    async with websockets.connect(url) as ws:
        hello = json.loads(await ws.recv())
        print(f"hello: {hello}")
        assert hello["type"] == "hello" and hello["user_id"] == r1["user_id"]

        # 일부러 stranger도 같이 시도 → rejected에 들어가야 함
        await ws.send(json.dumps({
            "action": "subscribe",
            "device_ids": [did_owned, did_stranger],
        }))
        ack = json.loads(await ws.recv())
        print(f"ack: {ack}")
        assert ack["type"] == "ack"
        assert did_owned in ack["accepted"]
        assert did_stranger in ack["rejected"]

        # 두 디바이스 모두에 ingest. owned만 받아야 함.
        for uid in (uid_owned, uid_stranger):
            http("POST", "/ingest", body={
                "ts": 1, "csq": 24, "reg": 5, "vbat_mv": 3970,
                "device_uid": uid,
                "l80": {"fix": True, "lat": 35.949, "lng": 127.009, "sat": 8, "ttff_s": 5},
            })

        # 1초 동안 들어오는 것 수집
        try:
            while True:
                msg = await asyncio.wait_for(ws.recv(), timeout=1.0)
                received.append(json.loads(msg))
        except asyncio.TimeoutError:
            pass

    print(f"received {len(received)} events:")
    for ev in received:
        print(f"  {ev}")

    # 검증: 수신 이벤트는 모두 type=location, device_id=did_owned
    assert len(received) >= 1, "no events received"
    assert all(ev["type"] == "location" for ev in received), "non-location event leaked"
    assert all(ev["device_id"] == did_owned for ev in received), "stranger event leaked!"
    print("OK ✓")

asyncio.run(main())
