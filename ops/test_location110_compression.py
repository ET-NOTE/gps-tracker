"""Real109 compressed chunks ->110, keyed backfill and encrypted write checks."""
import hashlib
import json
import subprocess

import psycopg

from benchmark_location110 import JOB, NET, DB, PRIOR, OUT, connect, info, save
from location_query_bounds import backfill


def main():
    host = info('container', DB)['NetworkSettings']['Networks'][NET]['IPAddress']
    results = []
    for encrypted in (False, True):
        name = 'gps_query110_compressed_' + str(int(encrypted))
        with connect() as db:
            db.execute('CREATE DATABASE ' + name)
        try:
            subprocess.run(['docker', 'run', '--rm', '--network', NET, '--memory=550m', '--cap-drop=ALL',
                '--security-opt=no-new-privileges', '-e', 'APP_ENV=test', '-e', 'GPS_MIGRATE_ONLY=1',
                '-e', f'DATABASE_URL=postgres://postgres:query110-synthetic@query-db/{name}',
                '-e', 'JWT_SECRET=synthetic-query110-migration', '-v', str(PRIOR / 'out/gps-tracker-api') + ':/api:ro',
                'gps-build:rust1.88-node22.22.2', '/api'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            with psycopg.connect(f'postgres://postgres:query110-synthetic@{host}/{name}', autocommit=True) as db:
                db.execute("SET statement_timeout='60s'; SET jit=off")
                db.execute("SELECT set_config('gps.storage_keys',%s,false)", ((JOB / 'test-keys.json').read_text(),))
                db.execute('UPDATE location_storage_policy SET enabled=%s', (encrypted,))
                uid = db.execute("INSERT INTO users(phone,email,password_hash) VALUES('compressed','compressed@example.invalid','') RETURNING id").fetchone()[0]
                did = db.execute("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,'compressed-sim','') RETURNING id", (uid,)).fetchone()[0]
                db.execute("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,fixes_jsonb) SELECT %s,%s,'2026-01-01'::timestamptz+i*interval '1 minute','l80',true,37,127,jsonb_build_array(jsonb_build_object('at_ms',-1000,'lat',37,'lng',127)) FROM generate_series(1,20) i", (did, uid))
                before = db.execute('SELECT count(*) FROM location_history_points_between(%s,%s,NULL,NULL)', (did, uid)).fetchone()[0]
                chunks = db.execute("SELECT compress_chunk(c) FROM show_chunks('location_records') c").fetchall()
                assert chunks
                sql = JOB / 'src/gps-tracker-api/migrations/0110_location_query_decryption.sql'
                with db.transaction():
                    db.execute(sql.read_text())
                    db.execute("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(110,'location query decryption',true,%s,0)", (hashlib.sha384(sql.read_bytes()).digest(),))
                assert db.execute('SELECT count(*) FROM location_history_points_between(%s,%s,NULL,NULL)', (did, uid)).fetchone()[0] == before
                report = backfill(db, True, 7)
                assert report['complete'] and report['updated'] == 20
                assert db.execute('SELECT count(*) FROM location_history_points_between(%s,%s,NULL,NULL)', (did, uid)).fetchone()[0] == before
                db.execute('UPDATE location_storage_policy SET enabled=true')
                db.execute('UPDATE location_records SET lat=lat,lng=lng,raw=raw,fixes_jsonb=fixes_jsonb')
                assert db.execute('SELECT count(*) FROM location_history_points_between(%s,%s,NULL,NULL)', (did, uid)).fetchone()[0] == before
                assert db.execute('SELECT count(*) FROM location_records WHERE lat IS NOT NULL OR lng IS NOT NULL OR fixes_jsonb IS NOT NULL').fetchone() == (0,)
                results.append({'initially_encrypted': encrypted, 'compressed_chunks': len(chunks), 'points_preserved': before, 'backfill': report})
        finally:
            with connect() as db:
                db.execute('DROP DATABASE ' + name + ' WITH (FORCE)')
    save('compression110.json', {'passed': True, 'cases': results, 'synthetic_databases_removed': True, 'production_modified': False})
    print('COMPRESSED CHUNK PASS: plaintext and encrypted109 ->110 with backfill', flush=True)


if __name__ == '__main__':
    main()
