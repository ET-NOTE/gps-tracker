"""Pinned additive production release. No account, SIM or historical-data erasure.

Run as root on seriallog after isolated validation. Only GPS API/schema, its
private-upload nginx guards and its local cleanup timer are changed. The web,
firmware, APK, dev and Shield releases are not promoted by this command.
"""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request

import psycopg2
from privacy_file_cleanup import config

STAGE = pathlib.Path('/home/mmm/gps-artifacts/location-files-20261105-r1')
API = pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
ENV = pathlib.Path('/home/mmm/projects/gps-tracker-api/.env')
NGINX = pathlib.Path('/etc/nginx/sites-available/gps.serial.kr')
BACKUP = pathlib.Path('/home/mmm/backups/location-files-20261105-r1')
OPS = pathlib.Path('/home/mmm/gps-ops')
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
run = lambda a: subprocess.run(a, check=True, capture_output=True)


def neighbors():
    return {'dev_api': sha(pathlib.Path('/home/gps-dev/projects/gps-tracker-api/bin/gps-tracker-api-dev')),
        'dev_web': str(pathlib.Path('/home/gps-dev/gps-tracker-web-dev/dist').resolve()),
        'shield': str(pathlib.Path('/srv/shield/current').resolve()),
        'web': str(pathlib.Path('/home/mmm/gps-tracker-web/dist-root').resolve()),
        'processes': run(['systemctl', 'show', 'gps-tracker-api-dev', 'shield-api', '-p', 'MainPID', '-p', 'ActiveEnterTimestamp']).stdout.decode()}


def files_digest(q):
    result = {}
    for table in ('device_documents', 'rental_photos', 'fleet_expense_receipts'):
        q.execute(f"SELECT count(*),md5(string_agg(md5(to_jsonb(t)::text),',' ORDER BY id)) FROM {table} t")
        result[table] = q.fetchone()
    q.execute('SELECT count(*) FROM privacy_file_cleanup')
    result['queue_count'] = q.fetchone()[0]
    return result


def main():
    os.umask(0o077)
    assert os.geteuid() == 0
    assert sys.argv[1:] in ([], ['--resume'])
    resume = sys.argv[1:] == ['--resume']
    manifest = json.loads((STAGE/'manifest.json').read_text())
    assert sha(API) == (manifest['api_sha256'] if resume else '8195421e0bc0463b1777e58db25aa5c34353c0e944b6fb633ad3791d6ba01e6f')
    validation = json.loads((STAGE/'validation.json').read_text())
    assert validation['api_sha256'] == manifest['api_sha256'] == sha(STAGE/'gps-tracker-api')
    assert validation['integration_groups'] == 9 and validation['schema'] == 86
    assert sha(STAGE/'focused-source.tar.gz') == manifest['source_sha256']
    for name, digest in manifest['ops_files'].items():
        assert sha(STAGE/name) == digest
    assert shutil.disk_usage(STAGE).free > 1024**3
    cfg = config(ENV)
    assert cfg.get('UPLOAD_DIR', '/home/mmm/uploads') == '/home/mmm/uploads'
    assert cfg.get('PRIVATE_UPLOAD_DIR', '/home/mmm/gps-private-uploads') == '/home/mmm/gps-private-uploads'
    old_nginx = (BACKUP/'nginx.previous').read_text() if resume else NGINX.read_text()
    marker = '    location ^~ /uploads/car-images/ { return 404; }'
    assert old_nginx.count(marker) == 1 and '/uploads/device_documents/' not in old_nginx
    new_nginx = old_nginx.replace(marker, marker+'\n    location ^~ /uploads/device_documents/ { return 404; }\n    location ^~ /uploads/fleet_documents/ { return 404; }')
    migrations = {}
    with tarfile.open(STAGE/'focused-source.tar.gz') as archive:
        for member in archive.getmembers():
            if member.isfile():
                data = archive.extractfile(member).read()
                assert hashlib.sha256(data).hexdigest() == manifest['source_files'][member.name]
                if member.name.startswith('gps-tracker-api/migrations/'):
                    migrations[int(pathlib.PurePosixPath(member.name).name.split('_')[0])] = data
    assert set(migrations) == set(range(1, 87))
    if resume:
        baseline = json.loads((BACKUP/'baseline.json').read_text())
        assert sha(BACKUP/'api.previous') == baseline['api']
        assert neighbors() == baseline['neighbors'] and sha(ENV) == baseline['env']
        assert NGINX.read_text() in (old_nginx, new_nginx)
    else:
        baseline = {'api': sha(API), 'env': sha(ENV), 'nginx': sha(NGINX), 'neighbors': neighbors()}
        BACKUP.mkdir()
        shutil.copy2(API, BACKUP/'api.previous'); shutil.copy2(NGINX, BACKUP/'nginx.previous')
        (BACKUP/'baseline.json').write_text(json.dumps(baseline, indent=2))
    next_api = API.with_name('gps-tracker-api.next-files')
    assert not next_api.exists()
    if not resume:
        shutil.copy2(STAGE/'gps-tracker-api', next_api); next_api.chmod(0o755)
    with psycopg2.connect(cfg['DATABASE_URL']) as db:
        with db.cursor() as q:
            q.execute("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'")
            q.execute("SELECT version,encode(checksum,'hex') FROM _sqlx_migrations WHERE success ORDER BY version")
            assert dict(q.fetchall()) == {v: hashlib.sha384(data).hexdigest() for v, data in migrations.items() if v <= (86 if resume else 85)}
            if not resume:
                q.execute(migrations[86].decode())
                q.execute("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(86,'file cleanup outbox',true,%s,0)", (hashlib.sha384(migrations[86]).digest(),))
            file_baseline = files_digest(q)
            assert file_baseline['queue_count'] == 0  # No backfill or historical erasure.
            (BACKUP/'files-checkpoint.json').write_text(json.dumps({'resumed': resume, 'files': file_baseline}))
        db.commit()
    # Additive schema remains after deployment; repair forward on post-commit
    # failures. A pre-86 SQLx binary must not be blindly restored.
    if not resume:
        os.replace(next_api, API)
        run(['systemctl', 'restart', 'gps-tracker-api'])
    for _ in range(30):
        try:
            with urllib.request.urlopen('https://gps.serial.kr/health', timeout=5) as r:
                health = json.load(r)
            if health['ok'] and health['db'] and health['release'] == manifest['release']:
                break
        except Exception:
            pass
        time.sleep(1)
    else:
        raise RuntimeError('API health failed; keep schema and repair forward')
    NGINX.write_text(new_nginx)
    try:
        run(['nginx', '-t'])
    except subprocess.CalledProcessError:
        NGINX.write_text(old_nginx)
        raise RuntimeError('nginx validation failed; previous config restored') from None
    run(['systemctl', 'reload', 'nginx'])
    for kind in ('car-images', 'device_documents', 'fleet_documents'):
        # nginx reload acknowledges before every old worker has drained.
        for _ in range(10):
            try:
                with urllib.request.urlopen('https://gps.serial.kr/uploads/'+kind+'/privacy-path-probe', timeout=10):
                    pass
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    break
            time.sleep(.5)
        else:
            raise AssertionError('Static private upload guard did not become active')
    OPS.mkdir(mode=0o755, exist_ok=True)
    OPS.chmod(0o755)
    for name in ('privacy_file_cleanup.py', 'privacy_scope_inventory.py'):
        shutil.copy2(STAGE/name, OPS/name); (OPS/name).chmod(0o644)
    service = '''[Unit]
Description=GPS local private-file cleanup outbox
After=postgresql.service

[Service]
Type=oneshot
User=mmm
Group=mmm
ExecStart=/usr/bin/python3 /home/mmm/gps-ops/privacy_file_cleanup.py --env-file /home/mmm/projects/gps-tracker-api/.env --execute --limit 20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/mmm/uploads /home/mmm/gps-private-uploads
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
UMask=0077
MemoryMax=128M
TimeoutStartSec=90
'''
    timer = '''[Unit]
Description=Retry GPS local private-file cleanup
[Timer]
OnBootSec=2min
OnUnitInactiveSec=2min
Unit=gps-privacy-files.service
[Install]
WantedBy=timers.target
'''
    for suffix, content in (('service', service), ('timer', timer)):
        dest = pathlib.Path('/etc/systemd/system/gps-privacy-files.'+suffix)
        assert not dest.exists() or (resume and dest.read_text() == content)
        dest.write_text(content); dest.chmod(0o644)
    run(['systemd-analyze', 'verify', '/etc/systemd/system/gps-privacy-files.service', '/etc/systemd/system/gps-privacy-files.timer'])
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', '--now', 'gps-privacy-files.timer'])
    run(['systemctl', 'start', 'gps-privacy-files.service'])
    assert run(['systemctl', 'show', 'gps-privacy-files.service', '-p', 'Result', '--value']).stdout.strip() == b'success'
    with psycopg2.connect(cfg['DATABASE_URL']) as db:
        with db.cursor() as q:
            assert files_digest(q) == file_baseline
    assert neighbors() == baseline['neighbors'] and sha(ENV) == baseline['env']
    result = {'release': manifest['release'], 'api_sha256': sha(API), 'schema': 86,
        'resumed_after_nginx_reload_check': resume,
        'files_unchanged': file_baseline, 'neighbors_web_and_configuration_unchanged': True,
        'nginx_private_paths_404': True, 'cleanup_timer_active': True,
        'account_or_historical_erasure_executed': False, 'external_copies_verified': False}
    (STAGE/'deployment.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == '__main__':
    main()
