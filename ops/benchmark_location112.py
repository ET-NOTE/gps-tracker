"""Isolated synthetic location-query benchmark; never accepts a production DSN.

Uses an internal Docker network, pinned schema111 binary and disposable disk volume.
No external messages, production data, credentials or deployment operations.
"""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import time

import psycopg

JOB = pathlib.Path('/home/etcom-hub/build/gps-provision22-20261111query112')
PRIOR = pathlib.Path('/home/etcom-hub/build/gps-provision22-20261111query111')
DB = 'gps-query112-db'
NET = 'gps-query112-test'
VOL = 'gps-query112-data'
NAME = 'gps_query112_test'
BASE_SHA = '37de345292ebb75e8ef733192155dad1cec0b0744cbbd59dc12fe432b720b3e9'
OUT = JOB / 'out'


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def info(kind, name):
    return json.loads(subprocess.check_output(['docker', kind, 'inspect', name]))[0]


def connect():
    assert info('network', NET)['Internal']
    container = info('container', DB)
    assert not container['HostConfig']['PortBindings']
    assert any(m.get('Name') == VOL for m in container['Mounts'])
    host = container['NetworkSettings']['Networks'][NET]['IPAddress']
    db = psycopg.connect(f'postgres://postgres:query112-synthetic@{host}/{NAME}', autocommit=True)
    db.execute("SET statement_timeout='120s'; SET lock_timeout='5s'; SET jit=off")
    ring = JOB / 'test-keys.json'
    if ring.exists():
        db.execute("SELECT set_config('gps.storage_keys',%s,false)", (ring.read_text(),))
    return db


def save(name, data):
    OUT.mkdir(exist_ok=True)
    (OUT / name).write_text(json.dumps(data, indent=2, default=str) + '\n')


def setup():
    assert pathlib.Path(__file__).resolve().parent == JOB
    assert shutil.disk_usage(JOB).free > 2 * 1024**3, 'at least 2GiB free required'
    binary = PRIOR / 'out/gps-tracker-api'
    assert hashlib.sha256(binary.read_bytes()).hexdigest() == BASE_SHA
    run('docker', 'network', 'create', '--internal', NET)
    run('docker', 'volume', 'create', '--label', 'gps.query112=synthetic', VOL)
    run('docker', 'run', '-d', '--name', DB, '--network', NET, '--network-alias', 'query-db',
        '--cpus=2', '--memory=1500m', '--pids-limit=256', '--mount', f'type=volume,src={VOL},dst=/var/lib/postgresql/data',
        '-e', 'POSTGRES_PASSWORD=query112-synthetic', '-e', 'POSTGRES_DB=' + NAME,
        'timescale/timescaledb:2.19.3-pg14', '-c', 'log_parameter_max_length=0',
        '-c', 'log_parameter_max_length_on_error=0', '-c', 'track_io_timing=on',
        '-c', 'max_connections=50', '-c', 'shared_buffers=742MB',
        '-c', 'effective_cache_size=2225MB', '-c', 'work_mem=2532kB',
        '-c', 'jit=off', '-c', 'max_parallel_workers_per_gather=3')
    for _ in range(60):
        if subprocess.run(['docker', 'exec', DB, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], capture_output=True).returncode == 0:
            time.sleep(2)
            break
        time.sleep(1)
    seed()


def seed():
    binary = PRIOR / 'out/gps-tracker-api'
    assert hashlib.sha256(binary.read_bytes()).hexdigest() == BASE_SHA
    run('docker', 'run', '--rm', '--network', NET, '--memory=550m', '--cap-drop=ALL',
        '--security-opt=no-new-privileges', '-e', 'APP_ENV=test', '-e', 'GPS_MIGRATE_ONLY=1',
        '-e', f'DATABASE_URL=postgres://postgres:query112-synthetic@query-db/{NAME}',
        '-e', 'JWT_SECRET=synthetic-query112-migration', '-v', str(binary) + ':/api:ro',
        'gps-build:rust1.88-node22.22.2', '/api', stdout=subprocess.DEVNULL)
    from location_storage import create_keyring
    create_keyring(JOB / 'test-keys.json')
    with connect() as db:
        assert db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone() == (111,)
        uid = db.execute("INSERT INTO users(phone,email,password_hash,display_name) VALUES('query112','query112@example.invalid','no-login','Synthetic') RETURNING id").fetchone()[0]
        did = db.execute("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,'query112-sim','') RETURNING id", (uid,)).fetchone()[0]
        db.execute("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,sat,fixes_jsonb) SELECT %s,%s,'2026-10-01'::timestamptz+i*interval '10 seconds','l80',true,37.1,127.1,12, CASE WHEN i<=17000 THEN (SELECT jsonb_agg(jsonb_build_object('at_ms',j*1000,'lat',37.1+j*0.00001,'lng',127.1+j*0.00001,'up_ms',i*30000+j*1000)) FROM generate_series(-29,0) j) END FROM generate_series(1,130000) i", (did, uid))
        db.execute('UPDATE location_storage_policy SET enabled=true')
        db.execute("SET statement_timeout='600s'")
        db.execute('UPDATE location_records SET lat=lat,lng=lng,raw=raw,fixes_jsonb=fixes_jsonb')
        db.execute('VACUUM ANALYZE location_records')
        save('fixture.json', {'user_id': uid, 'device_id': did, 'rows': 130000, 'unique_points': 283001, 'source_api': BASE_SHA,
                             'storage': 'Docker named volume on build-host ext4/NVMe; not production VPS',
                             'cpu_limit': 2, 'memory_limit_mib': 1500,
                             'database_bytes': db.execute('SELECT pg_database_size(current_database())').fetchone()[0]})
    print('SETUP PASS', flush=True)


def probe(label):
    fixture = json.loads((OUT / 'fixture.json').read_text())
    args = (fixture['device_id'], fixture['user_id'])
    report = {'label': label, 'production_modified': False, 'queries': {}}
    with connect() as db:
        queries = {
            'month_history': "SELECT count(*) FROM location_history_points_between(%s,%s,'2026-10-01','2026-11-01')",
            'day_history': "SELECT count(*) FROM location_history_points_between(%s,%s,'2026-10-10','2026-10-11')",
            'month_keys': "SELECT count(*) FROM location_sample_keys_between(%s,%s,'2026-10-01','2026-11-01')",
            'small_history': "SELECT count(*) FROM location_history_points_between(%s,%s,'2026-10-10 12:00','2026-10-10 12:10')",
        }
        for name, query in queries.items():
            start = time.monotonic()
            value = db.execute(query, args).fetchone()[0]
            seconds = time.monotonic() - start
            report['queries'][name] = {'seconds': seconds, 'count': value}
            print(label, name, round(seconds, 3), value, flush=True)
        save(label + '.json', report)


def apply():
    migration = JOB / 'src/gps-tracker-api/migrations/0112_location_window_pipeline.sql'
    with connect() as db:
        if not (OUT / 'baseline-functions.json').exists():
            names = ['location_points_between', 'location_speed_points_between', 'location_speed_metrics_between',
                     'location_history_points_between', 'location_sample_keys_between']
            save('baseline-functions.json', dict(db.execute("SELECT proname,pg_get_functiondef(oid) FROM pg_proc WHERE proname=ANY(%s)", (names,)).fetchall()))
        before = db.execute("SELECT oid,relowner,relacl,pg_get_viewdef(oid) FROM pg_class WHERE oid='gps_read_location_records'::regclass").fetchone()
        if not (OUT / 'baseline-view.json').exists():
            assert db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone()==(111,)
            save('baseline-view.json', {'definition': before[3]})
        try:
            with db.transaction():
                db.execute(migration.read_text())
                db.execute('SELECT 1/0')
        except psycopg.errors.DivisionByZero:
            pass
        assert db.execute("SELECT oid,relowner,relacl,pg_get_viewdef(oid) FROM pg_class WHERE oid='gps_read_location_records'::regclass").fetchone() == before
        with db.transaction():
            db.execute(migration.read_text())
            db.execute("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(112,'location window pipeline',true,%s,0)", (hashlib.sha384(migration.read_bytes()).digest(),))
        assert db.execute("SELECT oid,relowner,relacl FROM pg_class WHERE oid='gps_read_location_records'::regclass").fetchone() == before[:3]
    print('APPLY PASS: failure rollback and projection OID/owner/ACL preserved', flush=True)


def backfill():
    from location_query_bounds import backfill as fill
    with connect() as db:
        start = time.monotonic()
        report = fill(db, True)
        db.execute('VACUUM ANALYZE location_records')
        save('backfill.json', {**report, 'seconds': time.monotonic() - start})
    print('BACKFILL PASS', report['updated'], flush=True)


def cleanup():
    assert JOB.resolve() == JOB and JOB.name == 'gps-provision22-20261111query112'
    network = info('network', NET)
    assert network['Internal']
    names = {v['Name'] for v in network['Containers'].values()}
    assert names <= {DB, 'gps-query112-api', 'gps-query112-proxy'}
    assert info('volume', VOL)['Labels'].get('gps.query112') == 'synthetic'
    for name in sorted(names):
        container = info('container', name)
        assert not container['HostConfig']['PortBindings'] and set(container['NetworkSettings']['Networks']) == {NET}
        run('docker', 'rm', '-f', name, stdout=subprocess.DEVNULL)
    run('docker', 'network', 'rm', NET, stdout=subprocess.DEVNULL)
    run('docker', 'volume', 'rm', VOL, stdout=subprocess.DEVNULL)
    private = ['test-keys.json', 'test-runtime.json', 'load-storage', 'tls-fixture']
    for name in private:
        path = JOB / name
        assert path.parent.resolve() == JOB and not path.is_symlink()
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)
    save('cleanup-query112.json', {'production_modified': False, 'synthetic_volume_removed': True,
                                 'private_paths_absent': all(not (JOB / n).exists() for n in private),
                                 'disk_free_bytes': shutil.disk_usage(JOB).free})
    print('CLEANUP PASS: only fixed synthetic query112 objects removed', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['setup', 'seed', 'probe', 'apply', 'backfill', 'cleanup'])
    parser.add_argument('--label', default='baseline111')
    a = parser.parse_args()
    if a.action == 'setup':
        setup()
    elif a.action == 'seed':
        seed()
    elif a.action == 'apply':
        apply()
    elif a.action == 'backfill':
        backfill()
    elif a.action == 'cleanup':
        cleanup()
    else:
        probe(a.label)
