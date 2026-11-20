"""Migration 85 regression on the disposable PostgreSQL14/Timescale2.19.3 DB.

Run before starting an API binary which embeds migration 85.
"""
import concurrent.futures
import hashlib
import json
import pathlib
import subprocess
import sys
import uuid
import psycopg2

net = 'gps-rights-test-20261105'
info = lambda kind, name: json.loads(subprocess.check_output(['docker', kind, 'inspect', name]))[0]
assert info('network', net)['Internal']
box = info('container', 'gps-rights-db-20261105')
assert box['Config']['Image'] == 'timescale/timescaledb:2.19.3-pg14'
dsn = f"postgres://postgres:rights-test-only@{box['NetworkSettings']['Networks'][net]['IPAddress']}/gps_rights_test"
db = psycopg2.connect(dsn); db.autocommit = True
q = db.cursor()
views = ['location_1min', 'location_5min', 'location_1hour']
migration = pathlib.Path(sys.argv[1]).read_bytes()
q.execute('SELECT max(version) FROM _sqlx_migrations'); assert q.fetchone()[0] == 84
tag = uuid.uuid4().hex
q.execute("INSERT INTO users(email,password_hash,phone) VALUES(%s,'fixture','000') RETURNING id", (tag+'@example.invalid',))
owner = q.fetchone()[0]
devices = []
for i in range(2):
    q.execute("INSERT INTO devices(device_uid,api_key_hash,owner_id) VALUES(%s,'',%s) RETURNING id", (tag+str(i), owner))
    devices.append(q.fetchone()[0])
    q.execute("INSERT INTO location_records(device_id,recorded_at,source,fix,lat,lng,sat) VALUES(%s,date_trunc('day',now())-interval '90 days','l80',true,37.1,127.1,8)", (devices[-1],))
for view in views:
    q.execute("CALL refresh_continuous_aggregate(%s,now()-interval '91 days',now()-interval '89 days')", (view,))
q.execute('DELETE FROM location_records WHERE device_id=ANY(%s)', (devices,))


def snapshot():
    result = {}
    for view in views:
        q.execute('SELECT * FROM '+view+' ORDER BY device_id,bucket')
        result[view] = q.fetchall()
    return result


before = snapshot()
q.execute("SELECT job_id FROM timescaledb_information.jobs WHERE proc_name='policy_refresh_continuous_aggregate'")
jobs = q.fetchall()
assert len(jobs) == 3 and all(len(v) == 2 for v in before.values())

# The public view LOCK must also block a concurrent refresher on its backing
# materialization; otherwise a snapshot could lose updates between copy/drop.
db.autocommit = False
q.execute('LOCK TABLE location_1min IN ACCESS EXCLUSIVE MODE')
def refresh():
    c = psycopg2.connect(dsn); c.autocommit = True
    try:
        with c.cursor() as x:
            x.execute("SET lock_timeout='300ms'")
            x.execute("CALL refresh_continuous_aggregate('location_1min',now()-interval '91 days',now()-interval '89 days')")
    except psycopg2.errors.LockNotAvailable:
        return True
    finally:
        c.close()
    return False
with concurrent.futures.ThreadPoolExecutor() as pool:
    assert pool.submit(refresh).result(timeout=5), 'Public lock failed to fence refresh'
db.rollback(); db.autocommit = True
print('PASS public aggregate lock fences concurrent refresh', flush=True)

q.execute('CREATE VIEW fixture_dependency AS SELECT * FROM location_5min')
db.autocommit = False
try:
    q.execute(migration.decode())
    raise AssertionError('Unexpected dependency was dropped')
except psycopg2.errors.DependentObjectsStillExist:
    db.rollback()
db.autocommit = True
assert snapshot() == before
q.execute("SELECT job_id FROM timescaledb_information.jobs WHERE proc_name='policy_refresh_continuous_aggregate'")
assert q.fetchall() == jobs
q.execute('DROP VIEW fixture_dependency')
print('PASS dependency failure rolls back copies, DDL and refresh jobs', flush=True)

db.autocommit = False
q.execute(migration.decode())
assert snapshot() == before
q.execute("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(85,'preserve legacy aggregates',true,%s,0)", (hashlib.sha384(migration).digest(),))
db.commit(); db.autocommit = True
assert snapshot() == before
q.execute("SELECT count(*) FROM timescaledb_information.continuous_aggregates WHERE view_name=ANY(%s)", (views,)); assert q.fetchone()[0] == 0
q.execute("SELECT count(*) FROM timescaledb_information.jobs WHERE job_id=ANY(%s)", ([j[0] for j in jobs],)); assert q.fetchone()[0] == 0
q.execute("SELECT count(*) FROM pg_class WHERE relname=ANY(%s) AND relkind='r'", (views,)); assert q.fetchone()[0] == 3
q.execute('SELECT sum(initial_rows) FROM location_aggregate_archives'); assert q.fetchone()[0] == 6
print('PASS exact row preservation including raw-less history, supported drop and refresh-job removal', flush=True)
db.close()
