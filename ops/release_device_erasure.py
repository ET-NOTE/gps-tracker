"""One release only: preserve legacy summaries, deploy scoped erasure support.

No account-closure UI/API rollout. No automatic data erasure in this command.
DDL and the migration ledger commit together; data equivalence is checked before
commit. Before commit, failure restores the previous executable. After commit,
keep schema 85 and repair forward rather than recomputing retained summaries.
"""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tarfile
import time
import urllib.request

import psycopg2
from release_assets import inherit_immutable_assets

stage = pathlib.Path('/home/mmm/gps-artifacts/location-erasure-20261105-r1')
api = pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
web = pathlib.Path('/home/mmm/gps-tracker-web/dist-root')
env = pathlib.Path('/home/mmm/projects/gps-tracker-api/.env')
nginx = pathlib.Path('/etc/nginx/sites-available/gps.serial.kr')
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
manifest = json.loads((stage/'manifest.json').read_text())
assert sha(api) == '25d9635292e6c8aab3a686e81a165a9d03e8984f8776234fa531902c9b108997'
for file, key in [('gps-tracker-api', 'api_sha256'), ('web.tar.gz', 'archive_sha256'), ('focused-source.tar.gz', 'source_sha256')]:
    assert sha(stage/file) == manifest[key]
assert json.loads((stage/'validation.json').read_text())['api_sha256'] == manifest['api_sha256']
assert shutil.disk_usage(stage).free > 1024**3
os.umask(0o077)
cfg = dict(line.split('=', 1) for line in env.read_text().splitlines() if '=' in line and not line.startswith('#'))
dsn = cfg['DATABASE_URL'].strip().strip('"').strip("'")


def neighbors():
    return {'dev_api': sha(pathlib.Path('/home/gps-dev/projects/gps-tracker-api/bin/gps-tracker-api-dev')),
            'dev_web': str(pathlib.Path('/home/gps-dev/gps-tracker-web-dev/dist').resolve()),
            'shield': str(pathlib.Path('/srv/shield/current').resolve()),
            'processes': subprocess.check_output(['systemctl', 'show', 'gps-tracker-api-dev', 'shield-api', '-p', 'MainPID', '-p', 'ActiveEnterTimestamp']).decode()}


def get(path):
    with urllib.request.urlopen('https://gps.serial.kr'+path, timeout=10) as r:
        return r.read()


def health(expected):
    for _ in range(30):
        try:
            h = json.loads(get('/health'))
            if h['ok'] and h['db'] and h['release'] == expected:
                return h
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError('Health check failed; keep schema and repair forward')


def summaries(q):
    result = {}
    for name in ('location_1min', 'location_5min', 'location_1hour'):
        q.execute(f"SELECT device_id,count(*),md5(string_agg(to_jsonb(r)::text,',' ORDER BY bucket)) FROM {name} r GROUP BY device_id ORDER BY device_id")
        result[name] = q.fetchall()
    return result


source = {}
with tarfile.open(stage/'focused-source.tar.gz') as archive:
    for member in archive.getmembers():
        if member.isfile() and member.name.startswith('gps-tracker-api/migrations/'):
            version = int(pathlib.PurePosixPath(member.name).name.split('_')[0])
            source[version] = archive.extractfile(member).read()
expected = {v: hashlib.sha384(s).hexdigest() for v, s in source.items()}
with psycopg2.connect(dsn) as db:
    with db.cursor() as q:
        q.execute("SELECT version,encode(checksum,'hex') FROM _sqlx_migrations WHERE success ORDER BY version")
        assert dict(q.fetchall()) == {v: h for v, h in expected.items() if v <= 82}

backup = pathlib.Path('/home/mmm/backups/location-erasure-20261105-r1')
backup.mkdir(exist_ok=True)
if (backup/'api.previous').exists():
    assert sha(backup/'api.previous') == sha(api)
baseline = {'api': sha(api), 'web': str(web.resolve()), 'env': sha(env), 'nginx': sha(nginx), 'neighbors': neighbors()}
(backup/'baseline.json').write_text(json.dumps(baseline, indent=2))
shutil.copy2(api, backup/'api.previous')
release = pathlib.Path('/home/mmm/releases/location-erasure-20261105-r1')
release.mkdir()
destination = release/'web'
destination.mkdir()
with tarfile.open(stage/'web.tar.gz') as archive:
    for item in archive.getmembers():
        assert (destination/item.name).resolve().is_relative_to(destination) and (item.isfile() or item.isdir())
    archive.extractall(destination)
for name, digest in manifest['web_files'].items():
    assert sha(destination/name) == digest
assert b'"/assets/' in (destination/'index.html').read_bytes()
reuse = inherit_immutable_assets(web/'assets', destination/'assets')
if (web/'uploads').is_symlink():
    (destination/'uploads').symlink_to((web/'uploads').resolve(), target_is_directory=True)
(destination/'version.json').write_text(json.dumps(dict(manifest, target='production'), indent=2))
for root, dirs, files in os.walk(release):
    pathlib.Path(root).chmod(0o755)
    for name in files:
        p = pathlib.Path(root)/name
        if not p.is_symlink():
            p.chmod(0o644)

next_api = api.with_name('gps-tracker-api.next-erasure')
assert not next_api.exists()
shutil.copy2(stage/'gps-tracker-api', next_api)
next_api.chmod(0o755)
committed = False
subprocess.run(['sudo', '-n', 'systemctl', 'stop', 'gps-tracker-api'], check=True)
try:
    with psycopg2.connect(dsn) as db:
        with db.cursor() as q:
            q.execute("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'")
            q.execute('LOCK TABLE location_1min,location_5min,location_1hour IN ACCESS EXCLUSIVE MODE')
            before = summaries(q)
            q.execute('SELECT count(*) FROM location_records'); raw_before = q.fetchone()[0]
            for version in (83, 84, 85):
                q.execute(source[version].decode())
                q.execute('INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(%s,%s,true,%s,0)',
                          (version, {83:'privacy requests',84:'device data erasure',85:'preserve legacy aggregates'}[version], hashlib.sha384(source[version]).digest()))
            assert summaries(q) == before
            q.execute('SELECT count(*) FROM location_records'); assert q.fetchone()[0] == raw_before
            q.execute('SELECT count(*) FROM timescaledb_information.continuous_aggregates'); assert q.fetchone()[0] == 0
            q.execute("SELECT count(*) FROM timescaledb_information.jobs WHERE proc_name='policy_refresh_continuous_aggregate'"); assert q.fetchone()[0] == 0
        db.commit()
    committed = True
    (stage/'aggregate-preservation.json').write_text(json.dumps({'all_sim_hashes': before, 'raw_rows_unchanged': raw_before, 'exact_equivalence': True}, indent=2))
    os.replace(next_api, api)
finally:
    # Before commit, the transaction and DDL roll back and the old API is still
    # installed. After commit, always install the schema-compatible new binary.
    if committed and next_api.exists():
        os.replace(next_api, api)
    subprocess.run(['sudo', '-n', 'systemctl', 'start', 'gps-tracker-api'], check=True)

health(manifest['api_release'])
next_web = web.with_name('dist-root.next-erasure')
assert not next_web.exists() and not next_web.is_symlink()
next_web.symlink_to(destination, target_is_directory=True)
os.replace(next_web, web)
assert json.loads(get('/version.json'))['release'] == manifest['release']
for path in ('/', '/devices', '/profile', '/corporate', '/rentcar'):
    assert hashlib.sha256(get(path)).hexdigest() == sha(destination/'index.html')
assert sha(env) == baseline['env'] and sha(nginx) == baseline['nginx'] and neighbors() == baseline['neighbors']
result = {'release': manifest['release'], 'api_sha256': sha(api), 'schema': 85,
          'legacy_summaries_preserved': True, 'raw_rows_unchanged': True, 'neighbors_unchanged': True,
          'erasure_executed': False, 'asset_reuse': reuse}
(stage/'deployment.json').write_text(json.dumps(result, indent=2))
(release/'deployment.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))
