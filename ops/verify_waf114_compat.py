#!/usr/bin/env python3
"""Read-only compatibility: auth rejection, WS headers, JSON photo-size envelope."""
import datetime
import hashlib
import http.client
import json
from pathlib import Path
from verify_waf114 import request


def websocket_rejection(port, path, headers):
    # urllib forces Connection: close, which invalidates a WebSocket handshake.
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    connection.request('GET', path, headers=headers)
    response = connection.getresponse()
    body = response.read()
    result = {'status': response.status, 'bytes': len(body), 'body_sha256': hashlib.sha256(body).hexdigest()}
    connection.close()
    return result


def main():
    checks = []
    for path, headers in [
        ('/gps-tracker/api/v1/auth/me', {'Authorization': 'Bearer gps114-invalid-not-a-credential'}),
        ('/gps-tracker/ws/realtime?token=gps114-invalid-not-a-credential', {'Connection': 'Upgrade', 'Upgrade': 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ=='}),
    ]:
        direct = websocket_rejection(3040, path, headers) if '/ws/' in path else request('http://127.0.0.1:3040' + path, headers=headers)
        waf = websocket_rejection(3045, path, headers) if '/ws/' in path else request('http://127.0.0.1:3045' + path, headers=headers)
        assert direct['status'] == waf['status'] and direct['body_sha256'] == waf['body_sha256'], (path, direct, waf)
        assert waf['status'] in {400, 401}
        checks.append({'case': 'websocket_unauthenticated' if '/ws/' in path else 'authentication_unauthenticated', 'direct': direct, 'waf': waf})
    # Synthetic JSON on a read-only health endpoint; backend 405, no file is stored.
    data = json.dumps({'photo_data_url': 'data:image/jpeg;base64,' + 'A' * (3 * 1024 * 1024)}).encode()
    # Direct backend rejects the method before draining a multi-MB body; use the
    # small-body rejection as the reference, avoiding a broken-pipe test artifact.
    direct = request('http://127.0.0.1:3040/gps-tracker/health', body=b'{}', headers={'Content-Type': 'application/json'})
    waf = request('http://127.0.0.1:3045/gps-tracker/health', body=data, headers={'Content-Type': 'application/json'})
    assert direct['status'] == waf['status'] == 405
    checks.append({'case': 'large_json_health_rejection_passthrough', 'body_bytes': len(data), 'direct': direct, 'waf': waf})
    report = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'checks': checks, 'note': 'No real login, authenticated upload or established WebSocket session was exercised.'}
    Path('/var/lib/gps-waf-install114/compatibility.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
