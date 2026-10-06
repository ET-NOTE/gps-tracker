#!/usr/bin/env python3
"""Upload-first enrollment contract, isolated shield_test only; no real board."""
import concurrent.futures
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import secrets

ROOT = Path('/home/etcom-hub/build/gps-tracker/shield-platform')
spec = importlib.util.spec_from_file_location('integration', ROOT / 'ops/shield/test-integration.py')
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)

def bootstrap(client):
    status, body, headers = client.call('/device/bootstrap', {})
    assert status == 200 and len(body) == 126
    assert headers.get('cache-control') == 'no-store'
    uid, key, code = body.splitlines()
    assert re.fullmatch(r'uno-shield-[a-f0-9]{32}', uid)
    assert re.fullmatch(r'[a-f0-9]{64}', key) and re.fullmatch(r'[a-f0-9]{16}', code)
    return uid, key, code

def main():
    assert c.BASE == 'http://127.0.0.1:3043' and c.sql('select current_database()') == 'shield_test'
    owner, other, anon = c.Client(), c.Client(), c.Client()
    suffix, password = secrets.token_hex(5), secrets.token_urlsafe(24)
    email = f'bootstrap-{suffix}@example.test'
    for client, mail in [(owner,email),(other,f'other-{suffix}@example.test')]:
        assert client.call('/api/auth/register', {'email':mail,'password':password,'display_name':'자동 등록 검증','invite_code':c.cli('invite')['invite_code']})[0] == 200
    uid, key, code = bootstrap(anon)
    c.check('anonymous bootstrap bounded plain ASCII response', True)
    c.check('unknown input rejected', anon.call('/device/bootstrap', {'owner_id':1})[0] == 422)
    c.check('body bound', anon.call('/device/bootstrap', {'padding':'x'*200})[0] == 413)
    stored = c.sql(f"SELECT row_to_json(d) FROM devices d WHERE device_uid='{uid}'")
    c.check('no stored raw key or claim code', key not in stored and code not in stored)
    c.check('unclaimed device absent from account inventory', owner.call('/api/devices')[1] == [])
    payload = {'shield_v':2,'device_uid':uid,'build_tag':'example-https-7','ts':100,'csq':20,'reg':5,'diag':{'gnss':0},'points':[]}
    headers = {'X-Device-Key':key}
    c.check('no telemetry before owner claim', anon.call('/ingest/shield',payload,headers)[0] == 409)
    form = {'claim_code':'-'.join(code[i:i+4] for i in range(0,16,4)).upper(),'display_name':'시리얼 등록 쉴드'}
    c.check('anonymous claim denied', anon.call('/api/devices/claim',form)[0] == 401)
    c.check('foreign origin claim denied', owner.call('/api/devices/claim',form,{'Origin':'https://gps.serial.kr'})[0] == 403)
    status, body, _ = owner.call('/api/devices/claim',form); assert status == 200
    identifier = body['id']
    c.check('grouped uppercase code claims without administrator', True)
    c.check('pending record consumed', c.sql(f'SELECT count(*) FROM device_enrollments WHERE device_id={identifier}') == '0')
    c.check('claim code single use and owner cannot be stolen', other.call('/api/devices/claim',form)[0] == 400)
    c.check('actual status reaches owner', anon.call('/ingest/shield',payload,headers)[0] == 200)
    c.check('duplicate status deduplicated', anon.call('/ingest/shield',payload,headers)[1]['duplicate'] is True)
    c.check('wrong key rejected', anon.call('/ingest/shield',payload,{'X-Device-Key':'0'*64})[0] == 401)
    listing = json.dumps(owner.call('/api/devices')[1])
    c.check('web inventory never exposes key/code', key not in listing and code not in listing)
    audit = c.sql(f"SELECT detail FROM audit_log WHERE target_type='device' AND target_id='{identifier}'")
    c.check('audit without secrets', 'serial' in audit and key not in audit and code not in audit)
    expired_uid, _, expired_code = bootstrap(anon)
    c.sql(f"UPDATE device_enrollments SET expires_at=now()-interval '1 second' WHERE device_id=(SELECT id FROM devices WHERE device_uid='{expired_uid}')")
    c.check('expired code rejected', owner.call('/api/devices/claim',{'claim_code':expired_code,'display_name':'expired'})[0] == 400)
    race_uid, _, race_code = bootstrap(anon)
    c.check('only expired pending identities pruned', c.sql(f"SELECT count(*) FROM devices WHERE device_uid='{expired_uid}'") == '0' and c.sql(f'SELECT count(*) FROM devices WHERE id={identifier}') == '1')
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda client: client.call('/api/devices/claim',{'claim_code':race_code,'display_name':'race'})[0], [owner,other]))
    c.check('concurrent claims assign one owner', sorted(results) == [200,400])
    c.sql("UPDATE auth_attempts SET attempts=60,started_at=now() WHERE bucket='device-bootstrap'")
    c.check('anonymous global rate limit', anon.call('/device/bootstrap',{})[0] == 429)
    c.sql("DELETE FROM auth_attempts WHERE bucket='device-bootstrap'")
    fixture = ROOT / 'bootstrap-ui-fixture.json'
    fixture.write_text(json.dumps({'email':email,'password':password,'device_id':identifier})); fixture.chmod(0o600)
    print(json.dumps({'passed':len(c.checks),'scope':'shield_test only'}))

if __name__ == '__main__': main()
