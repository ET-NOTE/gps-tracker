#!/usr/bin/env python3
"""Verify four actual sketch payloads with the disposable launch fixture only.

Run verify-production.py smoke first and cleanup afterwards. Never enables the
real device, sends sensor/location data over HTTP, or calls financial APIs.
"""
import argparse
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
spec = importlib.util.spec_from_file_location('production', ROOT / 'verify-production.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--examples', type=Path, required=True)
    args = parser.parse_args()
    assert os.geteuid() == 0 and c.BASE == 'https://shield.serial.kr'
    fixture = json.loads(c.FIXTURE.read_text())
    assert re.fullmatch(r'launch-smoke-[0-9a-f]{12}@example\.test', fixture['email'])
    owner, anon = c.Client(), c.Client()
    assert owner.call('/api/auth/login', {k: fixture[k] for k in ('email', 'password')})[0] == 200
    identifier = fixture['device_id']
    owned = owner.call('/api/devices')[1]
    assert len(owned) == 1 and owned[0]['id'] == identifier
    route = f'/api/devices/{identifier}/http-demo'

    def template(folder, uid, extra=()):
        source = (args.examples / folder / (folder + '.ino')).read_text()
        section = re.search(r'int\s+n\s*=\s*snprintf_P([\s\S]*?)SHIELD_(?:DEMO_)?UID\s*,\s*millis\(\)', source)[1]
        fmt = ''.join(json.loads(s) for s in re.findall(r'"(?:\\.|[^"\\])*"', section)).replace('%lu', '%d')
        return json.loads(fmt % (uid, 300, 23, 5, *extra))

    opener = urllib.request.build_opener(NoRedirect())

    def plain(path, data=None):
        request = urllib.request.Request('http://shield.serial.kr' + path,
            data=None if data is None else json.dumps(data).encode(),
            headers={'Content-Type': 'application/json'})
        try:
            response = opener.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        body = response.read()
        return response.status, body, response.headers

    try:
        c.check('real devices remain HTTP disabled', c.pg(f'SELECT count(*) FROM http_demo_links WHERE device_id<>{identifier}') == '0')
        c.check('test device starts HTTP disabled', owner.call(route)[1]['enabled'] is False)
        for folder, extra in [('04_shield_upload', (int(time.time()), '24.8', '58.0')),
                              ('06_first_upload', ()), ('07_easy_https', ())]:
            payload = template(folder, fixture['device']['device_uid'], extra)
            c.check(folder + ' key required', anon.call('/ingest/shield', payload)[0] == 401)
            c.check(folder + ' live HTTPS accepted', anon.call('/ingest/shield', payload,
                {'X-Device-Key': fixture['device']['device_key']})[0] == 200)
        status, setting, headers = owner.call(route, {'enabled': True})
        c.check('owner can issue one-time 24-hour UID', status == 200 and re.fullmatch(r'demo-[0-9a-f]{32}', setting['device_uid']))
        c.check('credential response is no-store', headers.get('cache-control', headers.get('Cache-Control')) == 'no-store')
        c.check('UID cannot be retrieved later', 'device_uid' not in owner.call(route)[1])
        payload = template('08_shield_http_pairing', setting['device_uid'])
        c.check('08 live plain HTTP accepted', plain('/ingest/shield-demo', payload)[0] == 200)
        c.check('08 duplicate is idempotent', json.loads(plain('/ingest/shield-demo', payload)[1])['duplicate'] is True)
        c.check('plain HTTP rejects sensor payload', plain('/ingest/shield-demo', dict(payload,
            sensors=[{'at': int(time.time()), 'temp_c': 20}]))[0] == 400)
        c.check('plain HTTP demo is POST only', plain('/ingest/shield-demo')[0] == 405)
        for path in ['/api/auth/login', '/ingest/shield']:
            result = plain(path)
            c.check(path + ' still requires HTTPS', result[0] == 308 and result[2]['Location'] == c.BASE + path)
        period = urllib.parse.urlencode({'since': c.dt.datetime.fromtimestamp(time.time()-120,c.dt.timezone.utc).isoformat(),
                                        'until': c.dt.datetime.fromtimestamp(time.time()+1,c.dt.timezone.utc).isoformat()})
        summary = owner.call(f'/api/devices/{identifier}/summary?{period}')[1]
        c.check('HTTP status visible to owner without invented measurements', summary['latest']['build_tag'] == 'example-http-8'
            and summary['latest']['csq'] == 23 and summary['latest']['measured_at'] is None)
        c.check('HTTP link can be disabled', owner.call(route, {'enabled': False})[0] == 200)
        c.check('disabled UID rejected at live HTTP edge', plain('/ingest/shield-demo', payload)[0] == 401)
        (ROOT / 'http-examples-results.json').write_text(json.dumps({'passed': len(c.checks), 'checks': c.checks}, indent=2))
        print(json.dumps({'passed': len(c.checks), 'hardware_validation': 'pending'}))
    finally:
        assert owner.call(route, {'enabled': False})[0] == 200
        assert owner.call('/api/auth/logout', {})[0] == 200


if __name__ == '__main__':
    main()
