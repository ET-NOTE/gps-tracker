"""Final check, bounded cleanup and evidence export for the fixed round116 fixture."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request

import psycopg

JOB = Path('/home/etcom-hub/build/gps-provision22-20261111cumulative116')
NET = 'gps-provision22-test-20261111cumulative116'
DB = 'gps-provision22-db-20261111cumulative116'
API = 'gps-provision22-api-20261111cumulative116'
SHA = 'a433b9a114131e235068cc0359b8535aaf9529d396b47785c8eb6c4c6ca17d10'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
inspect = lambda kind, name: json.loads(subprocess.check_output(['docker', kind, 'inspect', name]))[0]


def check():
    assert inspect('network', NET)['Internal']
    info = inspect('container', DB)
    assert '/var/lib/postgresql/data' in info['HostConfig']['Tmpfs'] and not info['HostConfig']['PortBindings']
    tests = json.loads((JOB / 'out/additional116-tests.json').read_text())
    assert len(tests) == 4 and all(r['exit'] == 0 for r in tests)
    source = json.loads((JOB / 'src/input-manifest.json').read_text())
    assert all(sha(JOB / 'src' / p) == h for p, h in source['files'].items())
    dsn = 'postgres://postgres:closure-test-only@' + info['NetworkSettings']['Networks'][NET]['IPAddress'] + '/gps_closure_test'
    cred = json.loads((JOB / 'test-runtime.json').read_text())
    runtime = dsn.replace('postgres:closure-test-only', cred['user'] + ':' + cred['password'])
    env = dict(os.environ, STORAGE='pilot', RUNTIME_DSN=runtime, LEDGER='off', SUBJECTS='off')
    with (JOB / 'out/final-api-start.log').open('w') as log:
        subprocess.run(['bash', str(JOB / 'dev22.sh'), 'api'], env=env, check=True, stdout=log, stderr=subprocess.STDOUT)
    ai = inspect('container', API)
    assert subprocess.check_output(['docker', 'exec', API, 'sha256sum', '/proc/1/exe']).decode().split()[0] == SHA
    host = ai['NetworkSettings']['Networks'][NET]['IPAddress']
    with urllib.request.urlopen('http://' + host + ':3043/gps-tracker/health', timeout=5) as r:
        assert json.load(r)['db']
    with psycopg.connect(dsn, autocommit=True) as db:
        schema = db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone()[0]
        count, plain, pending = db.execute('''SELECT count(*),count(*) FILTER (WHERE lat IS NOT NULL OR lng IS NOT NULL OR fixes_jsonb IS NOT NULL),
            count(*) FILTER (WHERE NOT query_bounds_ready) FROM location_records''').fetchone()
        assert schema == 112 and count >= 130000 and plain == 0 and pending == 0
        enabled, maintenance = db.execute('SELECT enabled,maintenance FROM location_storage_policy').fetchone()
        assert enabled and not maintenance
        assert db.execute("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'gps-read-%' OR state LIKE 'idle in transaction%'").fetchone()[0] == 0
    result = dict(at=datetime.datetime.now(datetime.timezone.utc).isoformat(), production_modified=False,
                  source_commit=source['commit'], source_files_verified=len(source['files']), api_sha256=SHA,
                  schema=schema, raw_rows=count, plaintext_location_rows=plain, query_bounds_pending=pending,
                  encrypted_api_restart=True, api_db_health=True, residual_queries_or_transactions=0)
    (JOB / 'out/final-state116.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)


def cleanup():
    assert (JOB / 'out/final-state116.json').is_file() and (JOB / 'out/package-verification.json').is_file()
    import prepare_cumulative108 as prior
    prior.JOB = JOB; prior.NET = NET; prior.NAMES = [API, DB]
    prior.cleanup()
    path = JOB / 'release-fixture'
    assert not path.is_symlink() and path.resolve().parent == JOB
    shutil.rmtree(path)
    result = json.loads((JOB / 'out/cleanup108.json').read_text())
    result.update(release_fixture_removed=not path.exists(), build_host_free_bytes=shutil.disk_usage(JOB).free)
    (JOB / 'out/cleanup116.json').write_text(json.dumps(result, indent=2) + '\n')
    (JOB / 'out/cleanup108.json').unlink()
    print(json.dumps(result), flush=True)


def export():
    assert json.loads((JOB / 'out/cleanup116.json').read_text())['private_fixture_paths_absent']
    paths = [p for p in sorted((JOB / 'out').iterdir()) if p.is_file() and p.suffix in ('.json', '.log') and p.name != 'evidence-manifest.json']
    paths += [JOB / name for name in ('rehearse_cumulative116.py', 'check_cumulative116.py',
              'run_regressions116.py', 'test_transition_file_owner.py', 'rehearse_release116.py', 'dev22.sh')]
    archive = JOB / 'cumulative116-evidence.tar.gz'
    hashes = {}
    with tarfile.open(archive, 'w:gz') as tar:
        for p in paths:
            data = p.read_bytes()
            assert b'-----BEGIN PRIVATE KEY-----' not in data and b'-----BEGIN RSA PRIVATE KEY-----' not in data
            assert b'"password":' not in data and b'"access_token":' not in data
            hashes[p.name] = sha(p)
            tar.add(p, arcname=p.name)
    manifest = dict(environment='isolated synthetic; not production capture', files=hashes,
                    archive_sha256=sha(archive), production_modified=False)
    (JOB / 'out/evidence-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('EVIDENCE', len(hashes), sha(archive), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'cleanup', 'export'])
    globals()[parser.parse_args().action]()
