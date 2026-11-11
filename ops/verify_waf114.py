#!/usr/bin/env python3
"""Harmless health-route probes: never writes accounts, locations or documents."""
import argparse
import concurrent.futures
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request


def request(base, path='', body=None, headers=None):
    req = urllib.request.Request(base + path, data=body, headers={'User-Agent': 'GPS-Security-Verification/114', **(headers or {})})
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            status, data = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, data = e.code, e.read()
    return {'status': status, 'bytes': len(data), 'body_sha256': hashlib.sha256(data).hexdigest(), 'ms': round((time.monotonic() - start) * 1000, 3)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--public', action='store_true')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    direct = 'http://127.0.0.1:3040/gps-tracker/health'
    protected = 'https://gps.serial.kr/health' if args.public else 'http://127.0.0.1:3045/gps-tracker/health'
    tests = []
    for kind, value in [('normal', 'status'), ('sqli', "1' OR '1'='1"), ('xss', '<script>alert(1)</script>'), ('path_traversal', '../../etc/passwd')]:
        path = '?probe=' + urllib.parse.quote(value, safe='')
        a, b = request(direct, path), request(protected, path)
        assert a['status'] == 200
        expected = 200 if kind == 'normal' else 403
        assert b['status'] == expected, (kind, a, b)
        tests.append({'case': kind, 'direct': a, 'waf': b, 'passed': True})
    if not args.public:
        for kind, payload, content_type in [
            ('json', b'{"latitude":37.5,"longitude":127.1,"name":"test","signature":"abcdef123456"}', 'application/json'),
            ('form', b'latitude=37.5&longitude=127.1', 'application/x-www-form-urlencoded'),
            ('multipart', b'--gps114\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--gps114--\r\n', 'multipart/form-data; boundary=gps114')]:
            a = request(direct, body=payload, headers={'Content-Type': content_type})
            b = request(protected, body=payload, headers={'Content-Type': content_type})
            assert b['status'] == a['status'] and b['body_sha256'] == a['body_sha256'], (kind, a, b)
            tests.append({'case': kind + '_health_rejection_passthrough', 'direct': a, 'waf': b, 'passed': True})
        marker = 'GPS114_PRIVACY_CANARY_NEVER_STORE'
        request(protected, '?probe=' + urllib.parse.quote('<script>' + marker + '</script>'), headers={'Authorization': 'Bearer ' + marker, 'Cookie': 'session=' + marker})
        for directory in ['/var/log/gps-waf', '/var/log/gps-nginx']:
            for file in Path(directory).glob('*.log'):
                assert marker.encode() not in file.read_bytes(), 'Raw canary persisted: ' + str(file)
    # Bounded smoke load, not a throughput/capacity certification.
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        load = list(pool.map(lambda _: request(protected), range(40)))
    assert all(x['status'] == 200 for x in load)
    times = sorted(x['ms'] for x in load)
    report = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'scope': 'public' if args.public else 'loopback', 'tests': tests, 'health_load': {'requests': 40, 'concurrency': 4, 'failures': 0, 'p95_ms': times[37], 'maximum_ms': times[-1]}, 'logs_omit_canary': None if args.public else True}
    Path(args.output).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
