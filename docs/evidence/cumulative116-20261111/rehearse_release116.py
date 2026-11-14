"""API/web switch and compatible recovery, only in the fixed round116 fixture.

No production inputs. A schema99 binary is never a recovery target for112 or
encrypted data. HTTP assets are served on loopback; production Nginx/WAF is not
simulated by this test. Real API processes and encrypted data are checked.
"""
import base64
import hashlib
import hmac
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
import urllib.request

import psycopg

JOB = Path('/home/etcom-hub/build/gps-provision22-20261111cumulative116')
assert Path(__file__).resolve().parent == JOB
NET = 'gps-provision22-test-20261111cumulative116'
DB = 'gps-provision22-db-20261111cumulative116'
API = 'gps-provision22-api-20261111cumulative116'
BASE = JOB.parent / 'gps-provision22-20261111cumulative112/candidate-cumulative112-20261111-r1'
SHA = 'a433b9a114131e235068cc0359b8535aaf9529d396b47785c8eb6c4c6ca17d10'
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
inspect = lambda kind, name: json.loads(subprocess.check_output(['docker', kind, 'inspect', name]))[0]
assert inspect('network', NET)['Internal']
di = inspect('container', DB)
assert '/var/lib/postgresql/data' in di['HostConfig']['Tmpfs'] and not di['HostConfig']['PortBindings']
DSN = 'postgres://postgres:closure-test-only@' + di['NetworkSettings']['Networks'][NET]['IPAddress'] + '/gps_closure_test'
cred = json.loads((JOB / 'test-runtime.json').read_text())
runtime = DSN.replace('postgres:closure-test-only', cred['user'] + ':' + cred['password'])
env = dict(os.environ, STORAGE='pilot', RUNTIME_DSN=runtime, LEDGER='off', SUBJECTS='off')
active = JOB / 'out/gps-tracker-api'
assert digest(active) == SHA
ROOT = JOB / 'release-fixture'
assert not ROOT.exists()
ROOT.mkdir()
old = ROOT / 'compatible112'; new = ROOT / 'candidate115'
shutil.copytree(BASE, old)
new.mkdir()
shutil.copy2(active, new / 'gps-tracker-api')
shutil.copytree(JOB / 'out/web-root', new / 'web')
for p in (old, new):
    manifest = {'schema': 112, 'api_sha256': digest(p / 'gps-tracker-api'),
                'files': {str(f.relative_to(p)): digest(f) for f in p.rglob('*') if f.is_file() and f.name != 'manifest.json'}}
    (p / 'manifest.json').write_text(json.dumps(manifest))
report = dict(environment='isolated encrypted synthetic DB and loopback static server',
              production_modified=False, schema=112, checks=[], external_messages=0)


def check_release(path):
    assert path.resolve().parent == ROOT
    m = json.loads((path / 'manifest.json').read_text())
    assert m['schema'] == 112, 'incompatible recovery schema'
    assert all(digest(path / p) == h for p, h in m['files'].items()), 'artifact hash mismatch'
    return m


def atomic_link(target):
    stage = ROOT / 'web-next'
    assert not stage.exists() and not stage.is_symlink()
    stage.symlink_to(target / 'web', target_is_directory=True)
    stage.replace(ROOT / 'web-current')


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / 'web-current'), **kwargs)

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = 'http://127.0.0.1:' + str(server.server_port)


def token(uid):
    enc = lambda v: base64.urlsafe_b64encode(json.dumps(v, separators=(',', ':')).encode()).rstrip(b'=')
    now = int(time.time())
    raw = enc({'alg': 'HS256', 'typ': 'JWT'}) + b'.' + enc({'sub': str(uid), 'typ': 'access', 'iat': now, 'exp': now + 3600})
    return (raw + b'.' + base64.urlsafe_b64encode(hmac.new(b'closure-test-only-jwt-key-32-characters', raw, hashlib.sha256).digest()).rstrip(b'=')).decode()


def state():
    with psycopg.connect(DSN, autocommit=True) as db:
        schema = db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone()[0]
        assert schema == 112
        rows, physical = db.execute("SELECT count(*),md5(string_agg(md5(to_jsonb(r)::text),'' ORDER BY device_id,recorded_at,source)) FROM location_records r").fetchone()
        assert db.execute('SELECT count(*) FROM location_records WHERE lat IS NOT NULL OR lng IS NOT NULL OR fixes_jsonb IS NOT NULL').fetchone()[0] == 0
        identity = db.execute("SELECT md5(string_agg(jsonb_build_array(id,owner_id,iccid,device_uid)::text,',' ORDER BY id)) FROM devices").fetchone()[0]
        return rows, physical, identity


with psycopg.connect(DSN, autocommit=True) as db:
    did, uid = db.execute("SELECT id,owner_id FROM devices WHERE device_uid='cumulative116-sim'").fetchone()
original = state()


def verify(path):
    assert subprocess.check_output(['docker', 'exec', API, 'sha256sum', '/proc/1/exe']).decode().split()[0] == digest(path / 'gps-tracker-api')
    host = inspect('container', API)['NetworkSettings']['Networks'][NET]['IPAddress']
    with urllib.request.urlopen('http://' + host + ':3043/gps-tracker/health', timeout=5) as r:
        assert json.load(r)['db']
    request = urllib.request.Request('http://' + host + f':3043/gps-tracker/api/v1/devices/{did}/locations/latest', headers={'Authorization': 'Bearer ' + token(uid)})
    with urllib.request.urlopen(request, timeout=30) as r:
        position = json.load(r)
        assert position['lat'] == 37.1 and position['lng'] == 127.1
    with urllib.request.urlopen(origin + '/index.html', timeout=5) as r:
        html = r.read()
    assert html == (path / 'web/index.html').read_bytes()
    count = 0
    for asset in re.findall(r'(?:src|href)="([^"]+)"', html.decode()):
        if not asset.startswith('/assets/'):
            continue
        with urllib.request.urlopen(origin + asset, timeout=5) as r:
            assert r.read() == (path / 'web' / asset.lstrip('/')).read_bytes()
        count += 1
    assert count > 0 and state() == original
    return count


def install_api(path, broken=False):
    check_release(path)
    subprocess.run(['docker', 'rm', '-f', API], check=True, stdout=subprocess.DEVNULL)
    stage = active.with_suffix('.next')
    if broken:
        stage.write_text('#!/bin/sh\nexit 73\n'); stage.chmod(0o755)
    else:
        shutil.copy2(path / 'gps-tracker-api', stage)
    stage.replace(active)
    p = subprocess.run(['bash', str(JOB / 'dev22.sh'), 'api'], env=env, capture_output=True, text=True)
    if broken:
        assert p.returncode != 0 and not inspect('container', API)['State']['Running']
        raise RuntimeError('injected startup failure')
    assert p.returncode == 0, p.stdout[-600:] + p.stderr[-600:]


def record(label, **kw):
    report['checks'].append(dict(check=label, **kw))
    (JOB / 'out/release116.json').write_text(json.dumps(report, indent=2))
    print('PASS ' + label, flush=True)


try:
    # Reject damage and schema99 BEFORE stopping a healthy service.
    atomic_link(new)
    verify(new)
    pid = inspect('container', API)['State']['Pid']
    invalid = ROOT / 'invalid'; invalid.mkdir()
    (invalid / 'manifest.json').write_text(json.dumps({'schema': 99, 'files': {}}))
    try:
        check_release(invalid)
    except AssertionError as e:
        assert 'schema' in str(e)
    else:
        raise AssertionError('schema99 recovery accepted')
    (invalid / 'manifest.json').write_text(json.dumps({'schema': 112, 'files': {'api': '0' * 64}}))
    (invalid / 'api').write_bytes(b'corrupt')
    try:
        check_release(invalid)
    except AssertionError as e:
        assert 'hash' in str(e)
    else:
        raise AssertionError('damaged release accepted')
    assert inspect('container', API)['State']['Pid'] == pid
    record('schema99 recovery and artifact corruption rejected before service mutation')
    install_api(old); atomic_link(old); verify(old)
    for phase in ('startup', 'after-api', 'after-web'):
        began = time.monotonic()
        try:
            install_api(new, broken=phase == 'startup')
            if phase == 'after-api':
                raise RuntimeError('injected after API readiness')
            atomic_link(new)
            verify(new)
            raise RuntimeError('injected after web switch')
        except RuntimeError:
            install_api(old); atomic_link(old)
            assets = verify(old)
        record('compatible112 recovery after ' + phase, seconds=round(time.monotonic()-began, 3),
               encrypted_rows=original[0], web_assets_checked=assets, raw_rows_and_sim_identity_unchanged=True)
    install_api(new); atomic_link(new)
    assets = verify(new)
    record('final115 API/web and encrypted location read restored', api_sha256=SHA, web_assets_checked=assets)
    with psycopg.connect(DSN, autocommit=True) as db:
        assert db.execute("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'gps-read-%' OR state LIKE 'idle in transaction%'").fetchone()[0] == 0
    record('no residual location queries or idle transactions')
finally:
    server.shutdown(); server.server_close()
