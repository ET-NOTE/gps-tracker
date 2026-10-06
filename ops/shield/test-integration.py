#!/usr/bin/env python3
"""Disposable etcom-hub Shield preview integration checks. No production access."""
import concurrent.futures
import copy
import datetime as dt
import http.cookiejar
import json
from pathlib import Path
import secrets
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path('/home/etcom-hub/build/gps-tracker/shield-platform')
BASE = 'http://127.0.0.1:3043'
ORIGIN = 'http://localhost:8043'
checks = []

def check(name, condition):
    assert condition, name
    checks.append(name)
    print('PASS', name, flush=True)

class Client:
    def __init__(self):
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))

    def call(self, path, data=None, headers=None):
        h = {'Origin': ORIGIN, **(headers or {})}
        if data is not None:
            h['Content-Type'] = 'application/json'
        req = urllib.request.Request(BASE + path, data=json.dumps(data).encode() if data is not None else None, headers=h)
        try:
            res = self.opener.open(req, timeout=15)
        except urllib.error.HTTPError as error:
            res = error
        raw = res.read().decode()
        try:
            result = json.loads(raw)
        except json.JSONDecodeError:
            result = raw
        return res.status, result, dict(res.headers)

def cli(command, *args):
    state = json.loads((ROOT / 'preview-state.json').read_text())
    assert state['env_file'] == str(ROOT / 'preview.env')
    output = subprocess.check_output([*state['cli'], command, *args], text=True)
    return json.loads(output.strip().splitlines()[-1])

def sql(statement):
    return subprocess.check_output(['docker','exec','shield-preview-db','psql','-U','shield_test','-d','shield_test','-Atc', statement], text=True).strip()

def iso(value):
    return dt.datetime.fromtimestamp(value, dt.timezone.utc).isoformat()

def main():
    check('isolated database name', sql('select current_database()') == 'shield_test')
    a, b, anonymous = Client(), Client(), Client()
    suffix = secrets.token_hex(4)
    password = secrets.token_urlsafe(24)
    email = f'preview-{suffix}@example.test'
    invite = cli('invite')['invite_code']
    registration = {'email':email, 'password':password, 'display_name':'쉴드 검증 계정', 'invite_code':invite}
    status, _, h = a.call('/api/auth/register', registration)
    cookie = next((v for k,v in h.items() if k.lower() == 'set-cookie'), '')
    check('invite signup and HttpOnly host cookie', status == 200 and 'HttpOnly' in cookie and 'SameSite=Strict' in cookie)
    reused = dict(registration, email=f'reuse-{suffix}@example.test')
    check('invite cannot be reused', anonymous.call('/api/auth/register', reused)[0] == 400)
    check('invalid invite refused', anonymous.call('/api/auth/register', dict(reused, invite_code='0'*64))[0] == 400)
    second = dict(registration, email=f'other-{suffix}@example.test', invite_code=cli('invite')['invite_code'])
    check('second account created', b.call('/api/auth/register', second)[0] == 200)
    check('anonymous data blocked', anonymous.call('/api/devices')[0] == 401)
    check('foreign Origin mutations blocked', a.call('/api/auth/logout', {}, {'Origin':'https://gps.serial.kr'})[0] == 403)
    check('session survives rejected logout', a.call('/api/auth/session')[1]['email'] == email)
    device = cli('provision', 'Synthetic GPS and DHT11')
    now = int(time.time())
    points = [[now-12+i*2,37566500+i*90,126978000,8] for i in range(6)]
    payload = {'shield_v':2,'device_uid':device['device_uid'],'build_tag':'shield-synthetic-integration','ts':500,
               'csq':20,'reg':5,'diag':{'pv_mv':3290,'gnss':1},'points':points,
               'sensors':[{'at':now-8+i*2,'temp_c':24+i/10,'hum_pct':58+i/10} for i in range(4)]}
    key = {'X-Device-Key':device['device_key']}
    check('unclaimed device cannot upload', anonymous.call('/ingest/shield',payload,key)[0] == 409)
    status, claim, _ = a.call('/api/devices/claim', {'claim_code':device['claim_code'],'display_name':'창가 센서 · 합성 시험'})
    check('one-time device claim', status == 200)
    identifier = claim['id']
    check('second account cannot claim same device', b.call('/api/devices/claim', {'claim_code':device['claim_code'],'display_name':'other'})[0] == 400)
    empty = cli('provision', 'Empty fixture')
    empty_id = a.call('/api/devices/claim',{'claim_code':empty['claim_code'],'display_name':'수신 대기 쉴드'})[1]['id']
    third = cli('provision', 'UI claim fixture')
    check('device list has no device secret', len(a.call('/api/devices')[1]) == 2 and 'key_hash' not in json.dumps(a.call('/api/devices')[1]))
    check('other account inventory is empty', b.call('/api/devices')[1] == [])
    check('device key required even with owner cookie', a.call('/ingest/shield',payload)[0] == 401)
    check('wrong device key refused', anonymous.call('/ingest/shield',payload,{'X-Device-Key':'0'*64})[0] == 401)
    status, accepted, _ = anonymous.call('/ingest/shield',payload,key)
    check('six UTC GPS points accepted', status == 200 and accepted['accepted'] == 6)
    check('exact retry deduplicated', anonymous.call('/ingest/shield',payload,key)[1]['duplicate'] is True)
    overlap = dict(payload, ts=501)
    check('overlapping samples deduplicated', anonymous.call('/ingest/shield',overlap,key)[1]['accepted'] == 0)
    period = urllib.parse.urlencode({'since':iso(now-3600),'until':iso(time.time()+1)})
    prefix = f'/api/devices/{identifier}'
    for endpoint in ['summary','readings','locations']:
        check(f'cross-account {endpoint} denied', b.call(f'{prefix}/{endpoint}?{period}')[0] == 404)
    summary = a.call(f'{prefix}/summary?{period}')[1]
    check('UTC samples and canonical statistics', summary['total'] == 4 and abs(summary['stats']['temp_avg']-24.15)<0.001 and len(summary['chart']) >= 1)
    records = a.call(f'{prefix}/readings?{period}&limit=2')[1]
    check('stable cursor pagination', len(records['items']) == 2 and records['next'] is not None)
    remaining = a.call(f'{prefix}/readings?{period}&limit=2&'+urllib.parse.urlencode(records['next']))[1]
    check('pagination has neither duplicate nor missing samples', len(remaining['items'])==2 and remaining['next'] is None and len({x['id'] for x in records['items']+remaining['items']})==4)
    positions = a.call(f'{prefix}/locations?{period}')[1]['items']
    speeds = [p['speed_kmh'] for p in positions if p['speed_kmh'] is not None]
    check('server coordinate speed uses shared algorithm', len(positions)==6 and len(speeds)==4 and all(17.8<s<18.2 for s in speeds))
    for title, replacement in [('invalid humidity', {'sensors':[{'at':now,'hum_pct':101}]}),('future point',{'points':[[now+100,37566500,126978000,8]]}),('out-of-order point',{'points':list(reversed(points))}),('unknown protocol',{'shield_v':9})]:
        check(title+' rejected before write', anonymous.call('/ingest/shield',dict(payload,**replacement),key)[0] == 400)
    check('invalid range rejected', a.call(f'{prefix}/readings?'+urllib.parse.urlencode({'since':iso(now-8*86400),'until':iso(now)}))[0] == 400)
    status_payload = dict(payload, points=[],sensors=[],ts=502)
    check('status-only telemetry accepted', anonymous.call('/ingest/shield',status_payload,key)[0] == 200)
    newperiod = urllib.parse.urlencode({'since':iso(now-3600),'until':iso(time.time()+1)})
    latest = a.call(f'{prefix}/summary?{newperiod}')[1]['latest']
    check('status does not invent sensor measurement', latest['temp_c'] is None and latest['measured_at'] is None)
    sensor = a.call(f'{prefix}/summary?{newperiod}')[1]['temperature']
    check('latest valid sensor survives status-only report with original UTC', abs(sensor['value']-24.3)<0.001 and sensor['measured_at'] is not None)
    check('no-fix status breaks GPS stream', a.call(f'{prefix}/locations?{newperiod}')[1]['items'][0]['fix'] is False)
    check('separate device is empty', a.call(f'/api/devices/{empty_id}/summary?{newperiod}')[1]['latest'] is None)
    # Exercise invitation serialization without allowing two consumers.
    simultaneous = cli('invite')['invite_code']
    def register_race(index):
        return Client().call('/api/auth/register',dict(registration,email=f'race{index}-{suffix}@example.test',invite_code=simultaneous))[0]
    with concurrent.futures.ThreadPoolExecutor(2) as executor:
        race = sorted(executor.map(register_race,[1,2]))
    check('concurrent invite consumption is atomic', race == [200,400])
    old = '; '.join(f'{c.name}={c.value}' for c in a.cookies)
    check('logout succeeds', a.call('/api/auth/logout',{})[0] == 200)
    check('logout revokes copied session token', anonymous.call('/api/auth/session',headers={'Cookie':old})[0] == 401)
    check('GPS cookie cannot authenticate Shield', anonymous.call('/api/auth/session',headers={'Cookie':'token=legacy-gps-token'})[0] == 401)
    check('login remains usable', a.call('/api/auth/login',{'email':email,'password':password})[0] == 200)
    fixture = ROOT/'ui-fixture.json'
    fixture.write_text(json.dumps({'email':email,'password':password,'device':device,'device_id':identifier,'empty_id':empty_id,'claim':third,'invite':cli('invite')['invite_code']},ensure_ascii=False,indent=2))
    fixture.chmod(0o600)
    (ROOT/'integration-results.json').write_text(json.dumps({'passed':len(checks),'checks':checks,'tested_at':iso(time.time())},indent=2))
    print(f'{len(checks)} integration checks passed. Private UI fixture saved on runner.')

if __name__ == '__main__':
    main()
