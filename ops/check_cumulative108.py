"""Run existing business/privacy checks on the cumulatively upgraded encrypted DB.

Adds full stale-backup checkpoint recovery and synthetic mapping-history timing.
All inputs and mutations are confined to the disposable cumulative108 job.
"""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time
import uuid

import psycopg
from privacy_restore_checkpoint import export, restore
from crypto20b_transition import run as transition

HERE = pathlib.Path(__file__).resolve().parent
assert HERE == pathlib.Path('/home/etcom-hub/build/gps-provision22-20261108cumulative')
NET = 'gps-provision22-test-20261108cumulative'
DB = 'gps-provision22-db-20261108cumulative'
API = 'gps-provision22-api-20261108cumulative'
inspect = lambda kind, name: json.loads(subprocess.check_output(['docker', kind, 'inspect', name]))[0]
assert inspect('network', NET)['Internal']
assert '/var/lib/postgresql/data' in inspect('container', DB)['HostConfig']['Tmpfs']
dsn = 'postgres://postgres:closure-test-only@' + inspect('container', DB)['NetworkSettings']['Networks'][NET]['IPAddress'] + '/gps_closure_test'
cred = json.loads((HERE / 'test-runtime.json').read_text())
runtime = dsn.replace('postgres:closure-test-only', cred['user'] + ':' + cred['password'])
ring = json.loads((HERE / 'test-keys.json').read_text())
env = dict(os.environ, STORAGE='pilot', RUNTIME_DSN=runtime, LEDGER='off', SUBJECTS='off')
cfg = {'DATABASE_URL': dsn, 'GPS_LOCATION_ENCRYPTION': 'pilot', 'GPS_LOCATION_KEYRING_FILE': str(HERE / 'test-keys.json')}
results = []


def run(name, *args):
    with (HERE / 'out' / (name + '.log')).open('w') as f:
        p = subprocess.run(['bash', str(HERE / 'dev22.sh'), *args], env=env, stdout=f, stderr=subprocess.STDOUT)
    results.append({'check': name, 'exit': p.returncode})
    (HERE / 'out/regressions108.json').write_text(json.dumps(results, indent=2))
    assert p.returncode == 0, name
    print('PASS ' + name, flush=True)


for name, suffix in [('test_provision22.py', '20261108'), ('test_provision22b.py', '20261108b'),
                     ('test_provision22d.py', '20261108d'), ('run_provision22_regressions.py', '20261108')]:
    (HERE / name).write_text((HERE / 'src/ops' / name).read_text().replace(suffix, '20261108cumulative'))
run('22-integration', 'suite', 'test_provision22.py')
run('reset-before22b', 'api')
run('22b-integration', 'suite', 'test_provision22b.py')
run('reset-before22d', 'api')
run('22d-integration', 'suite', 'test_provision22d.py')
run('reset-before-business', 'api')
run('business-regressions', 'suite', 'run_provision22_regressions.py')
run('stop-before-recovery', 'stop')
# Drain only the removed test API's disposable DB connections.
subprocess.run(['docker', 'rm', API], check=True, stdout=subprocess.DEVNULL)
with psycopg.connect(dsn, autocommit=True) as db:
    db.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")


def con(target=dsn):
    db = psycopg.connect(target, autocommit=True)
    db.execute("SET statement_timeout='60s'; SET jit=off")
    db.execute("SELECT set_config('gps.storage_keys',%s,false)", (json.dumps(ring),))
    return db


def command(*args, **kw):
    return subprocess.run(list(args), check=True, stdout=subprocess.DEVNULL, **kw)


for mode in ('fence',):
    transition(dsn, ring, str(HERE / 'test-storage/uploads'), str(HERE / 'test-storage/private'), mode)
command('docker', 'run', '--rm', '--network', NET, '--cap-drop=ALL',
        '--cap-add=CHOWN', '--cap-add=DAC_OVERRIDE', '--cap-add=SETUID', '--cap-add=SETGID',
        '--security-opt=no-new-privileges', '--memory=256m',
        '-v', str(HERE) + ':' + str(HERE),
        '-v', str((HERE / 'python-deps').resolve()) + ':/deps:ro',
        '-e', 'PYTHONPATH=/deps:' + str(HERE / 'src/ops'), '-w', str(HERE),
        'gps-build:rust1.88-node22.22.2', 'python3', str(HERE / 'test_transition_file_owner.py'))
transition(dsn, ring, str(HERE / 'test-storage/uploads'), str(HERE / 'test-storage/private'), 'resume')
print('PASS different maintenance/API file owners survive encrypted replacement', flush=True)


# An older full encrypted backup predates the subject's withdrawal and erasure.
with con() as db:
    uid = db.execute("INSERT INTO users(phone,email,password_hash) VALUES('restore108','restore108@example.invalid','not-login') RETURNING id").fetchone()[0]
    did = db.execute("INSERT INTO devices(owner_id,device_uid,iccid,api_key_hash) VALUES(%s,'restore108-sim','8988000000000001081','') RETURNING id", (uid,)).fetchone()[0]
    db.execute("INSERT INTO location_records(device_id,user_id,source,fix,lat,lng,recorded_at) VALUES(%s,%s,'l80',true,37,127,'2025-01-01')", (did, uid))
    assert db.execute('SELECT count(*) FROM location_records WHERE user_id=%s', (uid,)).fetchone() == (1,)
    fixture = json.loads((HERE / 'out/round22-encrypted-integration.json').read_text())['fixture']
    # The stale backup has an older mapping revision. Replaying the newer
    # checkpoint below must not restore consent or duplicate successful notices.
    db.execute("UPDATE location_subject_mappings SET status='confirmed',revision=1 WHERE id=%s", (fixture['mapping'],))
    old_hash = db.execute('SELECT md5(row_to_json(d)::text) FROM devices d WHERE id=%s', (did,)).fetchone()[0]
archive = subprocess.check_output(['docker', 'exec', DB, 'pg_dump', '-U', 'postgres', '-d', 'gps_closure_test', '-Fc'])
with con() as db:
    db.execute("UPDATE location_subject_mappings SET status='revoked',revision=2 WHERE id=%s", (fixture['mapping'],))
    db.execute("UPDATE location_provision_notices SET delivery='provider_accepted',provider_accepted_at=now() WHERE id=%s", (fixture['notice'],))
    db.execute("INSERT INTO privacy_processing_controls(user_id,use_paused,provision_paused,revision) VALUES(%s,true,true,3)", (uid,))
    db.execute("DELETE FROM location_records WHERE user_id=%s", (uid,))
    db.execute("INSERT INTO privacy_retention_runs(user_id,cutoff,counts,review_reasons,device_ids) VALUES(%s,'2026-01-01','{}','[]',%s)", (uid, [did]))
cp = HERE / 'test-latest-checkpoint.json'
proof = export(cfg, cp)
command('docker', 'exec', DB, 'createdb', '-U', 'postgres', 'gps_cumulative_stale')
command('docker', 'exec', DB, 'psql', '-U', 'postgres', '-d', 'gps_cumulative_stale', '-v', 'ON_ERROR_STOP=1', '-c',
        'CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();')
command('docker', 'exec', '-i', DB, 'pg_restore', '-U', 'postgres', '-d', 'gps_cumulative_stale', '--exit-on-error', input=archive)
command('docker', 'exec', DB, 'psql', '-U', 'postgres', '-d', 'gps_cumulative_stale', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT timescaledb_post_restore();')
target = dsn.rsplit('/', 1)[0] + '/gps_cumulative_stale'
with con(target) as db:
    assert db.execute('SELECT count(*) FROM location_records WHERE user_id=%s', (uid,)).fetchone() == (1,)
    assert db.execute('SELECT status FROM location_subject_mappings WHERE id=%s', (fixture['mapping'],)).fetchone() == ('confirmed',)
bad_rejected = False
try:
    restore({**cfg, 'DATABASE_URL': target}, cp, '0' * 64)
except ValueError:
    bad_rejected = True
assert bad_rejected
replay = restore({**cfg, 'DATABASE_URL': target}, cp, proof['sha256'])
with con(target) as db:
    assert db.execute('SELECT count(*) FROM location_records WHERE user_id=%s', (uid,)).fetchone() == (0,)
    assert db.execute('SELECT use_paused AND provision_paused FROM privacy_processing_controls WHERE user_id=%s', (uid,)).fetchone() == (True,)
    assert db.execute('SELECT status,revision FROM location_subject_mappings WHERE id=%s', (fixture['mapping'],)).fetchone() == ('revoked', 2)
    assert db.execute('SELECT delivery FROM location_provision_notices WHERE id=%s', (fixture['notice'],)).fetchone() == ('provider_accepted',)
    assert db.execute('SELECT enabled OR push_enabled FROM location_subject_policy').fetchone() == (False,)
    assert db.execute('SELECT md5(row_to_json(d)::text) FROM devices d WHERE id=%s', (did,)).fetchone()[0] == old_hash
    try:
        db.execute("INSERT INTO location_records(device_id,user_id,source,fix,lat,lng,recorded_at) VALUES(%s,%s,'l80',true,37,127,'2025-01-02')", (did, uid))
    except psycopg.Error:
        pass
    else:
        raise AssertionError('erased location resurrected by resend')
(HERE / 'out/protected-restore108.json').write_text(json.dumps({'stale_full_backup_bytes': len(archive),
    'checkpoint_hash_checked': True, 'old_erased_rows_removed': True, 'old_consent_not_revived': True,
    'pause_reapplied': True, 'accepted_notice_not_resent': True, 'sim_identity_preserved': True,
    'old_resend_denied': True, 'replay': replay, 'external_checkpoint_custody_verified': False}, indent=2))
command('docker', 'exec', DB, 'dropdb', '-U', 'postgres', '--force', 'gps_cumulative_stale')
cp.unlink()
print('PASS stale full encrypted restore plus latest checkpoint before any API is started', flush=True)

# Synthetic future history: 1,000 independent 32-deep chains. No inference of consent.
# All rows are synthetic; production mapping table does not exist at schema99.
with con() as db:
    owner = db.execute("INSERT INTO users(phone,email,password_hash) VALUES('mapping-load108','mapping-load108@example.invalid','no-login') RETURNING id").fetchone()[0]
    staff = db.execute("INSERT INTO staff(user_id,name,active,access_role) VALUES(%s,'Synthetic history',true,'member') RETURNING id", (owner,)).fetchone()[0]
    db.execute('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)', (owner, staff, owner))
    first = db.execute('SELECT coalesce(max(id),0)+1 FROM location_subject_mappings').fetchone()[0]
    started = time.monotonic()
    # Reserve explicit IDs in a test with every writer stopped.
    db.execute("""INSERT INTO location_subject_mappings(id,request_key,owner_id,subject_id,proposed_by,staff_id,vehicle_id,binding_id,device_id,
      starts_at,ends_at,status,revision,replaces_id,replaces_revision,change_kind)
      SELECT %s+i,gen_random_uuid(),%s,%s,%s,%s,900000+i/32,900000+i/32,900000+i/32,
       '2026-11-01','2026-11-02',CASE WHEN i%%32=31 THEN 'confirmed' WHEN i%%32=0 THEN 'revoked' ELSE 'superseded' END,CASE WHEN i%%32=0 THEN 2 ELSE 1 END,
       CASE WHEN i%%32>0 THEN %s+i-1 END,CASE WHEN i%%32=1 THEN 2 WHEN i%%32>0 THEN 1 END,CASE WHEN i%%32=1 THEN 'reconsent' WHEN i%%32>0 THEN 'correction' END
      FROM generate_series(0,31999) i ORDER BY i""", (first, owner, owner, owner, staff, first))
    db.execute("SELECT setval(pg_get_serial_sequence('location_subject_mappings','id'),(SELECT max(id) FROM location_subject_mappings))")
    db.execute('ANALYZE location_subject_mappings')
    samples = []
    for _ in range(3):
        t = time.monotonic()
        count = db.execute('SELECT count(*) FROM location_subject_effective WHERE owner_id=%s', (owner,)).fetchone()[0]
        assert count == 1000, count
        samples.append(round(time.monotonic() - t, 4))
    plan = db.execute('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM location_subject_effective WHERE owner_id=%s AND device_id=900000', (owner,)).fetchone()[0]
    (HERE / 'out/mapping-history-plan.json').write_text(json.dumps(plan, indent=2))
    result = {'synthetic_rows': 32000, 'independent_chains': 1000, 'max_depth': 32,
              'confirmed_leaves': 1000, 'owner_count_seconds': samples,
              'point_query_execution_ms': plan[0]['Execution Time'], 'db_cpu_limit': 2,
              'production_distribution_reproduced': False}
    (HERE / 'out/mapping-history108.json').write_text(json.dumps(result, indent=2))
    assert max(samples) < 5, 'mapping history count exceeds isolated 5-second acceptance budget'
    assert plan[0]['Execution Time'] < 2000, 'mapping point query exceeds isolated 2-second acceptance budget'
print('PASS mapping-history workload', flush=True)
