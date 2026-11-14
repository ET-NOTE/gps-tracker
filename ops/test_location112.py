"""Disk-backed isolated oracle, write, ownership and resumable backfill checks."""
import datetime as dt
import hashlib
import json
import re

import psycopg
from psycopg.types.json import Jsonb

from benchmark_location112 import JOB, OUT, connect, save
from location_query_bounds import backfill


def main():
    checks = 0
    definitions = json.loads((OUT / 'baseline-functions.json').read_text())
    with connect() as db, db.transaction(force_rollback=True):
        for name, definition in definitions.items():
            db.execute(definition.replace('FUNCTION public.' + name, 'FUNCTION pg_temp.before_' + name))
        ids = [r[0] for r in db.execute("INSERT INTO users(phone,email,password_hash) VALUES('q110a','q110a@example.invalid',''),('q110b','q110b@example.invalid','') RETURNING id")]
        a, b = ids
        did = db.execute("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,'q110-edge','') RETURNING id", (a,)).fetchone()[0]
        start = dt.datetime(2026, 10, 19, 15, tzinfo=dt.timezone.utc)
        for i in range(30):
            fixes = [{'at_ms': -60000 + k * 5000, 'up_ms': i * 60000 + k * 5000,
                      'lat': 35 + i * .0001 + k * .00001, 'lng': 127, 'sat': 12} for k in range(12)]
            db.execute('INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,sat,raw,fixes_jsonb) VALUES(%s,%s,%s,\'l80\',true,35,127,12,%s,%s)',
                       (did, a, start + dt.timedelta(minutes=i), Jsonb({'boot_id': str(i // 15), 'cbc_mv': 4132, 'padding': 'x' * 5000}), Jsonb(fixes)))
        extras = [(-5, 'l80', a, None), (0, 'phone', a, None), (7, 'l80', b, None),
                  (-40 * 86400, 'lte_gnss', a, [{'at_ms': 40 * 86400000 + 15000, 'lat': 36, 'lng': 128}]),
                  (40 * 86400, 'lte_gnss', a, [{'at_ms': -40 * 86400000 + 20000, 'lat': 36, 'lng': 128}]),
                  (30, 'empty', a, []), (31, 'empty', a, {}), (32, 'empty', a, Jsonb(None))]
        for seconds, source, user, fixes in extras:
            db.execute('INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,sat,raw,fixes_jsonb) VALUES(%s,%s,%s,%s,true,31,120,12,\'{}\',%s)',
                       (did, user, start + dt.timedelta(seconds=seconds), source, fixes if fixes is None or isinstance(fixes, Jsonb) else Jsonb(fixes)))
        windows = [(None, None), (start, start), (start, start + dt.timedelta(hours=1)), (None, start), (start, None),
                   (start - dt.timedelta(seconds=12), start + dt.timedelta(seconds=17)),
                   (start + dt.timedelta(days=2), start + dt.timedelta(days=3)),
                   (start + dt.timedelta(seconds=20), start + dt.timedelta(seconds=15))]

        def compare():
            nonlocal checks
            for user in ids:
                for lo, hi in windows:
                    for name in definitions:
                        def rows(fn):
                            return db.execute('SELECT to_jsonb(p) FROM ' + fn + '(%s,%s,%s,%s) p ORDER BY recorded_at,source', (did, user, lo, hi)).fetchall()
                        assert rows('pg_temp.before_' + name) == rows(name), (name, user == a, str(lo), str(hi))
                        checks += 1
                expected = db.execute('SELECT max(location_point_bound(recorded_at,fixes_jsonb,true)) FROM gps_read_location_records WHERE device_id=%s AND user_id=%s', (did, user)).fetchone()
                assert expected == db.execute('SELECT location_latest_sample_at(%s,%s)', (did, user)).fetchone()
                checks += 1

        def legacy_rows():
            # Test-only simulation of pre-110 encrypted rows; entire fixture rolls back.
            db.execute("SET LOCAL session_replication_role='replica'")
            db.execute('UPDATE location_records SET query_bounds_ready=false,query_first_at=NULL,query_last_at=NULL WHERE device_id=%s', (did,))
            db.execute("SET LOCAL session_replication_role='origin'")

        def ciphertext_hash():
            return db.execute("SELECT md5(string_agg(concat(lat_sealed,lng_sealed,raw_sealed,fixes_jsonb_sealed),'|' ORDER BY recorded_at,source)) FROM location_records WHERE device_id=%s", (did,)).fetchone()[0]

        compare()
        legacy_rows()
        compare()
        before = ciphertext_hash()
        report = backfill(db)
        assert report['updated'] == 0 and report['pending_after'] == len(extras) + 30
        report = backfill(db, True, 7, 1)
        assert report['updated'] == 7 and not report['complete']
        compare()  # Mixed ready/pending representation must have identical results.
        assert backfill(db, True, 7)['complete']
        assert backfill(db, True)['updated'] == 0
        assert ciphertext_hash() == before
        checks += 5
        # Index metadata cannot be changed through ordinary runtime UPDATEs.
        before_bounds = db.execute('SELECT query_first_at,query_last_at FROM location_records WHERE device_id=%s ORDER BY recorded_at,source', (did,)).fetchall()
        db.execute("UPDATE location_records SET query_first_at='2000-01-01',query_last_at='2099-01-01',query_bounds_ready=false WHERE device_id=%s", (did,))
        assert before_bounds == db.execute('SELECT query_first_at,query_last_at FROM location_records WHERE device_id=%s ORDER BY recorded_at,source', (did,)).fetchall()
        assert db.execute('SELECT bool_and(query_bounds_ready) FROM location_records WHERE device_id=%s', (did,)).fetchone()[0]
        checks += 2
        # Late insert/delete, fixing a batch and removing its JSON all recompute bounds.
        db.execute("UPDATE location_records SET fixes_jsonb=%s WHERE device_id=%s AND recorded_at=%s AND source='l80'", (Jsonb([{'at_ms': 100000, 'lat': 34, 'lng': 128}]), did, start))
        compare()
        db.execute("UPDATE location_records SET fixes_jsonb=NULL WHERE device_id=%s AND recorded_at=%s AND source='l80'", (did, start))
        db.execute("DELETE FROM location_records WHERE device_id=%s AND recorded_at=%s AND source='l80'", (did, start + dt.timedelta(minutes=1)))
        db.execute("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng) VALUES(%s,%s,%s,'l80',true,35.0001,127)", (did, a, start + dt.timedelta(seconds=22)))
        compare()
        db.execute('UPDATE devices SET owner_id=%s WHERE id=%s', (b, did))
        compare()  # Historical row ownership stays scoped even after SIM transfer.
        db.execute("SET TIME ZONE 'Asia/Seoul'")
        compare()
        db.execute("SET TIME ZONE 'UTC'")
        assert db.execute('SELECT count(*) FROM location_records WHERE device_id=%s AND (lat IS NOT NULL OR lng IS NOT NULL OR raw IS NOT NULL OR fixes_jsonb IS NOT NULL)', (did,)).fetchone() == (0,)
        for expression in ("fixes_jsonb_sealed=fixes_jsonb_sealed||'broken'", "recorded_at=recorded_at+interval '1 second'"):
            try:
                with db.transaction():
                    db.execute("UPDATE location_records SET " + expression + " WHERE device_id=%s AND recorded_at=%s AND source='l80'", (did, start + dt.timedelta(minutes=2)))
                raise AssertionError('unauthenticated mutation accepted')
            except psycopg.Error:
                checks += 1
        legacy_rows()
        ring = (JOB / 'test-keys.json').read_text()
        db.execute("SELECT set_config('gps.storage_keys','',false)")
        try:
            with db.transaction():
                backfill(db, True)
            raise AssertionError('keyless encrypted backfill accepted')
        except psycopg.Error:
            checks += 1
        finally:
            db.execute("SELECT set_config('gps.storage_keys',%s,false)", (ring,))
        with connect() as blocker:
            blocker.execute("SELECT pg_advisory_lock(hashtextextended('gps-query-bounds-110',0))")
            try:
                backfill(db, True)
                raise AssertionError('concurrent backfill accepted')
            except ValueError as e:
                assert 'active' in str(e)
                checks += 1
        assert backfill(db, True)['complete']
    save('equivalence112.json', {'passed': True, 'checks': checks, 'oracle': 'schema111 complete logical rows',
         'scope': ['five SQL functions', 'latest', 'null/reversed/exact windows', 'far batch anchors', 'duplicates',
                   'source and row owner isolation', 'mixed/backfilled ciphertext', 'late writes/delete', 'Asia/Seoul',
                   'metadata tamper', 'cipher tamper/context', 'keyless rejection', 'resumable backfill'],
         'fixture_rolled_back': True, 'production_modified': False})
    print('EQUIVALENCE PASS', checks, flush=True)


if __name__ == '__main__':
    main()
