#!/usr/bin/env python3
"""Live HTTPS enrollment of one disposable launch-fixture device, then cleanup."""
import importlib.util
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path('/home/mmm/shield-deploy')
spec = importlib.util.spec_from_file_location('checks', ROOT / 'verify-production.py')
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)

def main():
    assert os.geteuid() == 0 and c.BASE == 'https://shield.serial.kr'
    fixture = json.loads(c.FIXTURE.read_text())
    assert re.fullmatch(r'launch-smoke-[0-9a-f]{12}@example\.test', fixture['email'])
    owner, other, anon = c.Client(), c.Client(), c.Client()
    for client, email in [(owner,fixture['email']),(other,fixture['other_email'])]:
        assert client.call('/api/auth/login', {'email':email,'password':fixture['password']})[0] == 200
    uid = None
    try:
        status, body, headers = anon.call('/device/bootstrap', {})
        assert status == 200 and len(body) == 126
        uid, key, code = body.splitlines()
        assert re.fullmatch(r'uno-shield-[a-f0-9]{32}',uid)
        assert re.fullmatch(r'[a-f0-9]{64}',key) and re.fullmatch(r'[a-f0-9]{16}',code)
        c.check('live HTTPS issues device connection without administrator', True)
        c.check('credential response cannot be cached', headers.get('Cache-Control',headers.get('cache-control')) == 'no-store')
        payload={'shield_v':2,'device_uid':uid,'build_tag':'example-https-7','ts':11,'csq':20,'reg':5,'diag':{'gnss':0},'points':[]}
        key_header={'X-Device-Key':key}
        c.check('unregistered board cannot store readings',anon.call('/ingest/shield',payload,key_header)[0] == 409)
        form={'claim_code':'-'.join(code[i:i+4] for i in range(0,16,4)).upper(),'display_name':'자동 등록 배포 검증 · 합성 데이터'}
        c.check('anonymous owner registration rejected',anon.call('/api/devices/claim',form)[0] == 401)
        status, claimed, _=owner.call('/api/devices/claim',form); assert status == 200
        identifier=claimed['id']
        c.check('serial code assigns device to signed-in tester',True)
        c.check('code cannot transfer ownership',other.call('/api/devices/claim',form)[0] == 400)
        c.check('next board upload accepted',anon.call('/ingest/shield',payload,key_header)[0] == 200)
        c.check('replayed upload deduplicated',anon.call('/ingest/shield',payload,key_header)[1]['duplicate'] is True)
        period=urllib.parse.urlencode({'since':c.dt.datetime.fromtimestamp(time.time()-60,c.dt.timezone.utc).isoformat(),'until':c.dt.datetime.fromtimestamp(time.time()+1,c.dt.timezone.utc).isoformat()})
        route=f'/api/devices/{identifier}/summary?{period}'
        status, summary, _=owner.call(route)
        c.check('tester sees actual status and no invented sensors/GPS',status == 200 and summary['latest']['csq'] == 20 and summary['position'] is None and summary['channels'] == [])
        c.check('another tester cannot view readings',other.call(route)[0] == 404)
        listing=json.dumps(owner.call('/api/devices')[1])
        c.check('connection secrets absent from account API',key not in listing and code not in listing)
        (ROOT/'bootstrap-results.json').write_text(json.dumps({'passed':len(c.checks),'checks':c.checks},indent=2))
        print(json.dumps({'passed':len(c.checks),'hardware_validation':'pending'}))
    finally:
        if uid:
            assert re.fullmatch(r'uno-shield-[a-f0-9]{32}',uid)
            row=json.loads(c.pg(f"SELECT row_to_json(d) FROM devices d WHERE device_uid='{uid}'"))
            owner_id=int(c.pg(f"SELECT id FROM users WHERE email='{fixture['email']}'"))
            assert row['sim_iccid'] is None and row['owner_id'] in (None,owner_id)
            assert c.pg(f"SELECT count(*) FROM sensor_channels WHERE device_id={int(row['id'])}") == '0'
            c.pg(f"DELETE FROM devices WHERE id={int(row['id'])} AND device_uid='{uid}'")
        owner.call('/api/auth/logout',{}); other.call('/api/auth/logout',{})

if __name__ == '__main__': main()
