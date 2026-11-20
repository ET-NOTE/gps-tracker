"""Stale encrypted restore with actual protected checkpoint unit, synthetic only."""
import json, time, uuid
import psycopg
from runtime121_control import ROOT as HERE,DSN as dsn,stop_api,transition,pg as command,dump,job,drain
DB='native-db'
ring=json.loads((HERE/'test-keys.json').read_text())
cfg={'DATABASE_URL':dsn,'GPS_LOCATION_ENCRYPTION':'pilot','GPS_LOCATION_KEYRING_FILE':str(HERE/'test-keys.json'),'GPS_PRIVACY_CHECKPOINT_MAINTENANCE':'1'}
stop_api()
drain()
transition(dsn,ring,str(HERE/'test-storage/uploads'),str(HERE/'test-storage/private'),'fence')
def con(target=dsn):
    db=psycopg.connect(target,autocommit=True)
    db.execute("SET statement_timeout='60s'; SET jit=off")
    db.execute("SELECT set_config('gps.storage_keys',%s,false)",(json.dumps(ring),))
    return db
# An older full encrypted backup predates the subject's withdrawal and erasure.
with con() as db:
    tag='restore121-'+uuid.uuid4().hex[:10]
    uid = db.execute("INSERT INTO users(phone,email,password_hash) VALUES(%s,%s,'not-login') RETURNING id",(tag,tag+'@example.invalid')).fetchone()[0]
    did = db.execute("INSERT INTO devices(owner_id,device_uid,iccid,api_key_hash) VALUES(%s,%s,%s,'') RETURNING id", (uid,tag+'-sim',tag)).fetchone()[0]
    db.execute("INSERT INTO location_records(device_id,user_id,source,fix,lat,lng,recorded_at) VALUES(%s,%s,'l80',true,37,127,'2025-01-01')", (did, uid))
    assert db.execute('SELECT count(*) FROM location_records WHERE user_id=%s', (uid,)).fetchone() == (1,)
    fixture = json.loads((HERE / 'out/round22-encrypted-integration.json').read_text())['fixture']
    # The stale backup has an older mapping revision. Replaying the newer
    # checkpoint below must not restore consent or duplicate successful notices.
    db.execute("UPDATE location_subject_mappings SET status='confirmed',revision=1 WHERE id=%s", (fixture['mapping'],))
    old_hash = db.execute('SELECT md5(row_to_json(d)::text) FROM devices d WHERE id=%s', (did,)).fetchone()[0]
archive=dump()
with con() as db:
    db.execute("UPDATE location_subject_mappings SET status='revoked',revision=2 WHERE id=%s", (fixture['mapping'],))
    db.execute("UPDATE location_provision_notices SET delivery='provider_accepted',provider_accepted_at=now() WHERE id=%s", (fixture['notice'],))
    db.execute("INSERT INTO privacy_processing_controls(user_id,use_paused,provision_paused,revision) VALUES(%s,true,true,3)", (uid,))
    db.execute("DELETE FROM location_records WHERE user_id=%s", (uid,))
    db.execute("INSERT INTO privacy_retention_runs(user_id,cutoff,counts,review_reasons,device_ids) VALUES(%s,'2026-01-01','{}','[]',%s)", (uid, [did]))
cp=HERE/'recovery/checkpoint.json'
drain()
def rejected(worker, message):
    try:job('checkpoint',action='export',worker=worker)
    except RuntimeError as exc:assert message in str(exc)
    else:raise AssertionError('unsafe checkpoint export accepted')
rejected({**cfg,'GPS_PRIVACY_CHECKPOINT_MAINTENANCE':'0'},'maintenance; worker stopped')
credential=json.loads((HERE/'test-runtime.json').read_text())
runtime_dsn=dsn.replace('postgres:closure-test-only',credential['user']+':'+credential['password'])
rejected({**cfg,'DATABASE_URL':runtime_dsn},'maintenance owner required')
rejected({**cfg,'GPS_LOCATION_ENCRYPTION':'off'},'storage policy mismatch')
with con() as other:
    rejected(cfg,'stop all API/worker/client sessions')
drain()
proof=job('checkpoint',action='export',worker=cfg)
command('docker', 'exec', DB, 'createdb', '-U', 'postgres', 'gps_cumulative_stale')
command('docker', 'exec', DB, 'psql', '-U', 'postgres', '-d', 'gps_cumulative_stale', '-v', 'ON_ERROR_STOP=1', '-c',
        'CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();')
command('docker', 'exec', '-i', DB, 'pg_restore', '-U', 'postgres', '-d', 'gps_cumulative_stale', '--exit-on-error', input=archive)
command('docker', 'exec', DB, 'psql', '-U', 'postgres', '-d', 'gps_cumulative_stale', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT timescaledb_post_restore();')
target = dsn.rsplit('/', 1)[0] + '/gps_cumulative_stale'
with con(target) as db:
    assert db.execute('SELECT maintenance FROM location_storage_policy').fetchone()==(True,)
    assert db.execute('SELECT count(*) FROM location_records WHERE user_id=%s', (uid,)).fetchone() == (1,)
    assert db.execute('SELECT status FROM location_subject_mappings WHERE id=%s', (fixture['mapping'],)).fetchone() == ('confirmed',)
bad_rejected = False
try:
    job('checkpoint',action='restore',worker={**cfg,'DATABASE_URL':target},sha256='0'*64)
except RuntimeError:
    bad_rejected = True
assert bad_rejected
replay=job('checkpoint',action='restore',worker={**cfg,'DATABASE_URL':target},sha256=proof['sha256'])
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
(HERE / 'out/protected-restore121.json').write_text(json.dumps({'stale_full_backup_bytes': len(archive),
    'checkpoint_hash_checked': True, 'old_erased_rows_removed': True, 'old_consent_not_revived': True,
    'pause_reapplied': True, 'accepted_notice_not_resent': True, 'sim_identity_preserved': True,
    'old_resend_denied': True, 'replay': replay, 'external_checkpoint_custody_verified': False,
    'maintenance_kept':True,'checkpoint_requires_opt_in':True,'checkpoint_rejects_runtime_role':True,
    'checkpoint_rejects_other_clients':True,'checkpoint_rejects_mode_mismatch':True}, indent=2))
command('docker', 'exec', DB, 'dropdb', '-U', 'postgres', '--force', 'gps_cumulative_stale')
cp.unlink()
print('PASS stale full encrypted restore plus latest checkpoint before any API is started', flush=True)

# Synthetic future history: 1,000 independent 32-deep chains. No inference of consent.
# All rows are synthetic; production mapping table does not exist at schema99.
with con() as db:
    tag = 'mapping-load108-' + uuid.uuid4().hex[:8]
    owner = db.execute("INSERT INTO users(phone,email,password_hash) VALUES(%s,%s,'no-login') RETURNING id", (tag, tag + '@example.invalid')).fetchone()[0]
    subject = db.execute("INSERT INTO users(phone,email,password_hash) VALUES(%s,%s,'no-login') RETURNING id", (tag + '-staff', tag + '-staff@example.invalid')).fetchone()[0]
    staff = db.execute("INSERT INTO staff(user_id,name,active,access_role) VALUES(%s,'Synthetic history',true,'member') RETURNING id", (owner,)).fetchone()[0]
    db.execute('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)', (owner, staff, subject))
    first = db.execute('SELECT coalesce(max(id),0)+1 FROM location_subject_mappings').fetchone()[0]
    started = time.monotonic()
    # Reserve explicit IDs in a test with every writer stopped.
    db.execute("""INSERT INTO location_subject_mappings(id,request_key,owner_id,subject_id,proposed_by,staff_id,vehicle_id,binding_id,device_id,
      starts_at,ends_at,status,revision,replaces_id,replaces_revision,change_kind)
      SELECT %s+i,gen_random_uuid(),%s,%s,%s,%s,900000+i/32,900000+i/32,900000+i/32,
       '2026-11-01','2026-11-02',CASE WHEN i%%32=31 THEN 'confirmed' WHEN i%%32=0 THEN 'revoked' ELSE 'superseded' END,CASE WHEN i%%32=0 THEN 2 ELSE 1 END,
       CASE WHEN i%%32>0 THEN %s+i-1 END,CASE WHEN i%%32=1 THEN 2 WHEN i%%32>0 THEN 1 END,CASE WHEN i%%32=1 THEN 'reconsent' WHEN i%%32>0 THEN 'correction' END
      FROM generate_series(0,31999) i ORDER BY i""", (first, owner, subject, owner, staff, first))
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
              'point_query_execution_ms': plan[0]['Execution Time'], 'db_cpu_limit': None,
              'production_distribution_reproduced': False}
    (HERE / 'out/mapping-history121.json').write_text(json.dumps(result, indent=2))
    assert max(samples) < 5, 'mapping history count exceeds isolated 5-second acceptance budget'
    assert plan[0]['Execution Time'] < 2000, 'mapping point query exceeds isolated 2-second acceptance budget'
print('PASS mapping-history workload', flush=True)
