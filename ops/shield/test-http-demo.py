#!/usr/bin/env python3
"""Four actual UNO payload templates and HTTP capability isolation; shield_test only."""
import concurrent.futures
import importlib.util
import json
from pathlib import Path
import re
import secrets
import time
import urllib.parse

ROOT = Path('/home/etcom-hub/build/gps-tracker/shield-platform')
SOURCE = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('integration', ROOT / 'ops/shield/test-integration.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def template(folder, uid, extra=()):
    source = (SOURCE / 'arduino/shield_examples' / folder / (folder + '.ino')).read_text()
    section = re.search(r'int\s+n\s*=\s*snprintf_P([\s\S]*?)(?:SHIELD_(?:DEMO_)?UID|enrollment\.uid)\s*,\s*millis\(\)', source)[1]
    fmt = ''.join(json.loads(s) for s in re.findall(r'"(?:\\.|[^"\\])*"', section)).replace('%lu', '%d')
    raw = fmt % (uid, 200, 23, 5, *extra)
    assert len(raw) < (448 if extra else 224 if folder.startswith('08') else 256)
    return json.loads(raw)


def main():
    assert c.BASE == 'http://127.0.0.1:3043' and c.sql('select current_database()') == 'shield_test'
    owner, other, anon = c.Client(), c.Client(), c.Client()
    suffix, password = secrets.token_hex(6), secrets.token_urlsafe(24)
    email = f'http-demo-{suffix}@example.test'
    for client, mail in [(owner, email), (other, f'other-{suffix}@example.test')]:
        assert client.call('/api/auth/register', {'email': mail, 'password': password,
            'display_name': 'HTTP 학습 시험', 'invite_code': c.cli('invite')['invite_code']})[0] == 200
    device = c.cli('provision', 'Four UNO examples fixture')
    identifier = owner.call('/api/devices/claim', {'claim_code': device['claim_code'], 'display_name': 'HTTP 학습 검증 장치'})[1]['id']
    route = f'/api/devices/{identifier}/http-demo'
    endpoint = '/ingest/shield-demo'
    uid = lambda: owner.call(route, {'enabled': True})[1]['device_uid']
    c.check('HTTP starts disabled', owner.call(route)[1]['enabled'] is False)
    c.check('anonymous settings denied', anon.call(route, {'enabled': True})[0] == 401)
    c.check('other owner cannot read or enable', other.call(route)[0] == 404 and other.call(route, {'enabled': True})[0] == 404)
    c.check('foreign Origin cannot enable', owner.call(route, {'enabled': True}, {'Origin': 'https://gps.serial.kr'})[0] == 403)
    token = uid()
    c.check('educational UID generated', re.fullmatch(r'demo-[0-9a-f]{32}', token) is not None)
    expiry = owner.call(route)[1]
    c.check('UID cannot be read back', 'device_uid' not in expiry and token not in json.dumps(owner.call('/api/devices')[1]))
    c.check('expires in 24 hours', 86300 < float(c.sql(f"SELECT extract(epoch FROM expires_at-now()) FROM http_demo_links WHERE device_id={identifier}")) <= 86400)
    c.check('raw UID absent from storage and audit', token not in c.sql(f"SELECT row_to_json(l) FROM http_demo_links l WHERE device_id={identifier}") and token not in c.sql(f"SELECT detail FROM audit_log WHERE target_type='device' AND target_id='{identifier}'"))

    for folder, extra in [('04_shield_upload', (int(time.time()), '24.8', '58.0')), ('06_first_upload', ()), ('07_easy_https', ())]:
        payload = template(folder, device['device_uid'], extra)
        c.check(folder + ' requires key', owner.call('/ingest/shield', payload)[0] == 401)
        c.check(folder + ' accepts unchanged template', anon.call('/ingest/shield', payload, {'X-Device-Key': device['device_key']})[0] == 200)

    payload = template('08_shield_http_pairing', token)
    c.check('HTTP accepts actual 08 template', anon.call(endpoint, payload)[0] == 200)
    c.check('HTTP retry deduplicated', anon.call(endpoint, payload)[1]['duplicate'] is True)
    c.check('normal device UID rejected on HTTP', anon.call(endpoint, dict(payload, device_uid=device['device_uid']))[0] == 401)
    c.check('operational key rejected on HTTP', anon.call(endpoint, payload, {'X-Device-Key': device['device_key']})[0] == 401)
    c.check('educational UID cannot replace HTTPS key', anon.call('/ingest/shield', payload)[0] == 401 and anon.call('/ingest/shield', payload, {'X-Device-Key': device['device_key']})[0] == 401)
    c.check('unknown classroom UID rejected', anon.call(endpoint, dict(payload, device_uid='demo-' + '0' * 32))[0] == 401)
    count = c.sql(f'SELECT count(*) FROM readings WHERE device_id={identifier}')
    for label, change in [('GPS', {'points': [[int(time.time()), 37000000, 127000000, 8]]}),
                          ('sensors', {'sensors': [{'at': int(time.time()), 'temp_c': 20}]}),
                          ('voltage', {'diag': {'pv_mv': 3300, 'gnss': 0}}),
                          ('foreign build', {'build_tag': 'arbitrary'}),
                          ('GNSS active', {'diag': {'gnss': 1}})]:
        c.check('HTTP rejects ' + label, anon.call(endpoint, dict(payload, **change))[0] == 400)
    c.check('invalid requests wrote no readings', c.sql(f'SELECT count(*) FROM readings WHERE device_id={identifier}') == count)
    c.check('HTTP payload limit', anon.call(endpoint, dict(payload, build_tag='x' * 2000))[0] == 413)
    period = urllib.parse.urlencode({'since': c.iso(time.time()-60), 'until': c.iso(time.time()+1)})
    data = owner.call(f'/api/devices/{identifier}/summary?{period}')[1]
    c.check('HTTP visible to owner without fabricated GPS/sensors', data['latest']['build_tag'] == 'example-http-8' and data['latest']['csq'] == 23 and data['latest']['measured_at'] is None and data['position'] is None)
    c.check('HTTPS DHT channels survive status upload', len(data['channels']) == 2)
    c.check('HTTP data not readable by another owner', other.call(f'/api/devices/{identifier}/summary?{period}')[0] == 404)

    replacement = uid()
    c.check('rotation revokes old UID', anon.call(endpoint, payload)[0] == 401)
    payload['device_uid'] = replacement
    c.check('replacement works', anon.call(endpoint, payload)[0] == 200)
    c.sql(f"UPDATE http_demo_links SET expires_at=now()-interval '1 second' WHERE device_id={identifier}")
    c.check('expired UID cannot ingest', anon.call(endpoint, payload)[0] == 401 and owner.call(route)[1]['enabled'] is False)
    payload['device_uid'] = uid()
    user_id = owner.call('/api/auth/session')[1]['id']
    c.sql(f'UPDATE users SET disabled=true WHERE id={user_id}')
    c.check('disabled owner cannot ingest', anon.call(endpoint, payload)[0] == 401)
    c.sql(f'UPDATE users SET disabled=false WHERE id={user_id}')
    c.sql(f'UPDATE devices SET owner_id=NULL WHERE id={identifier}')
    c.check('ownership loss revokes HTTP capability', anon.call(endpoint, payload)[0] == 401)
    c.sql(f'UPDATE devices SET owner_id={user_id} WHERE id={identifier}')
    c.sql(f"UPDATE auth_attempts SET attempts=29,started_at=now() WHERE bucket='http-demo-ingest:{identifier}'")
    c.check('per-device rate bounded', anon.call(endpoint, dict(payload, ts=205))[0] == 200 and anon.call(endpoint, dict(payload, ts=206))[0] == 429)
    c.check('HTTP limit does not block HTTPS', anon.call('/ingest/shield', template('07_easy_https', device['device_uid']), {'X-Device-Key': device['device_key']})[0] == 200)
    c.sql(f"DELETE FROM auth_attempts WHERE bucket='http-demo-ingest:{identifier}'")
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        off = pool.submit(owner.call, route, {'enabled': False})
        send = pool.submit(anon.call, endpoint, dict(payload, ts=207))
        assert off.result()[0] == 200 and send.result()[0] in (200, 401)
    c.check('disable serializes with ingestion', anon.call(endpoint, payload)[0] == 401 and owner.call(route)[1]['enabled'] is False)
    fixture = ROOT / 'http-demo-ui-fixture.json'
    fixture.write_text(json.dumps({'email': email, 'password': password, 'device_id': identifier}))
    fixture.chmod(0o600)
    print(json.dumps({'passed': len(c.checks), 'scope': 'four templates, shield_test only'}))


if __name__ == '__main__':
    main()
