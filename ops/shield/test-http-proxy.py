#!/usr/bin/env python3
"""Exercise the actual Shield nginx routes on loopback, with disposable preview data."""
import importlib.util
import json
from pathlib import Path
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path('/home/etcom-hub/build/gps-tracker/shield-platform')
HERE = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    c = load('integration', ROOT / 'ops/shield/test-integration.py')
    assert c.sql('select current_database()') == 'shield_test'
    # Validate the additive migration on the production PostgreSQL major too.
    infra = load('infrastructure', HERE / 'test-infrastructure.py')
    infra.SOURCE = HERE
    infra.main()
    fixture = json.loads((ROOT / 'http-demo-ui-fixture.json').read_text())
    owner = c.Client()
    assert owner.call('/api/auth/login', {k: fixture[k] for k in ('email', 'password')})[0] == 200
    settings = f"/api/devices/{fixture['device_id']}/http-demo"
    name = 'shield-http-proxy-check'
    names = subprocess.check_output(['docker', 'ps', '-a', '--format', '{{.Names}}'], text=True).splitlines()
    assert name not in names
    with tempfile.TemporaryDirectory(prefix='http-proxy-', dir=ROOT) as tmp:
        directory = Path(tmp)
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
            '-keyout', str(directory / 'privkey.pem'), '-out', str(directory / 'fullchain.pem')],
            check=True, capture_output=True)
        config = (HERE / 'shield.serial.kr.conf').read_text()
        config = config.replace('listen 80;', 'listen 127.0.0.1:18043;').replace('listen [::]:80;', '')
        config = config.replace('listen 443 ssl;', 'listen 127.0.0.1:18443 ssl;').replace('listen [::]:443 ssl;', '')
        (directory / 'nginx.conf').write_text(config)
        opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(
            context=ssl.create_default_context(cafile=str(directory / 'fullchain.pem'))))

        def call(path, payload=None, secure=False):
            url = ('https://127.0.0.1:18443' if secure else 'http://127.0.0.1:18043') + path
            request = urllib.request.Request(url, data=json.dumps(payload).encode() if payload is not None else None,
                headers={'Host': 'shield.serial.kr', 'Content-Type': 'application/json'})
            try:
                response = opener.open(request, timeout=5)
            except urllib.error.HTTPError as error:
                response = error
            return response.status, response.read(), response.headers

        subprocess.run(['docker', 'run', '-d', '--name', name, '--network', 'host', '--memory=64m', '--cpus=1',
            '-v', f'{directory}/nginx.conf:/etc/nginx/conf.d/default.conf:ro',
            '-v', f'{directory}:/etc/letsencrypt/live/shield.serial.kr:ro', 'nginx:stable-alpine'], check=True, capture_output=True)
        try:
            for _ in range(20):
                try:
                    if call('/ingest/shield-demo')[0] == 405:
                        break
                except OSError:
                    pass
                time.sleep(.2)
            else:
                raise RuntimeError('Loopback nginx did not start')
            c.check('HTTP lesson is POST only', call('/ingest/shield-demo')[0] == 405)
            for path in ['/ingest/shield', '/api/auth/login', '/api/devices/claim', '/ingest/shield-demo/']:
                status, _, headers = call(path, {})
                c.check('HTTP redirect retained ' + path, status == 308 and headers['Location'] == 'https://shield.serial.kr' + path)
            token = owner.call(settings, {'enabled': True})[1]['device_uid']
            payload = {'shield_v': 2, 'device_uid': token, 'build_tag': 'example-http-8', 'ts': 991,
                       'csq': 22, 'reg': 5, 'diag': {'gnss': 0}, 'points': []}
            c.check('HTTP exact route reaches isolated ingest', call('/ingest/shield-demo', payload)[0] == 200)
            c.check('HTTPS demo route also works', call('/ingest/shield-demo', dict(payload, ts=992), secure=True)[0] == 200)
            c.check('nginx limits classroom body to 1 KiB', call('/ingest/shield-demo', dict(payload, build_tag='x'*2000))[0] == 413)
            statuses = [call('/ingest/shield-demo', dict(payload, device_uid='demo-'+'0'*32))[0] for _ in range(15)]
            c.check('nginx throttles classroom requests', 429 in statuses)
            print(json.dumps({'proxy_checks': len(c.checks), 'ports': [18043, 18443], 'production_requests': 0}))
        finally:
            owner.call(settings, {'enabled': False})
            subprocess.run(['docker', 'rm', '-f', name], check=True, capture_output=True)


if __name__ == '__main__':
    main()
