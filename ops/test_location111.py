"""Page-window equivalence against the unchanged110 selector, on synthetic data."""
import datetime as dt
import hashlib
import json
import time

import psycopg
from psycopg.types.json import Jsonb

from benchmark_location111 import OUT, connect, save

OLD = '''SELECT recorded_at,source FROM location_sample_keys_between(%s,%s,%s,LEAST(%s,COALESCE(%s,%s)))
 WHERE recorded_at<%s AND (%s::text IS NULL OR source=%s)
 AND (%s::boolean IS NULL OR fix=%s)
 AND (%s::timestamptz IS NULL OR (recorded_at,source)<(%s,%s))
 ORDER BY recorded_at DESC,source DESC LIMIT %s'''
NEW = 'SELECT * FROM location_page_sample_keys(%s,%s,%s,%s,%s,%s,%s,%s,%s) ORDER BY recorded_at DESC,source DESC'


def old_args(did, uid, lo, hi, source, fix, before, before_source, count):
    return (did, uid, lo, hi, before, hi, hi, source, source, fix, fix, before, before, before_source, count)


def selector(db, args, old=False):
    return db.execute(OLD if old else NEW, old_args(*args) if old else args).fetchall()


def projection(db, args, old=False):
    selected = OLD if old else NEW
    params = old_args(*args) if old else args
    return db.execute('''WITH selected AS MATERIALIZED (''' + selected + '''),
     bounds AS (SELECT min(recorded_at) first,max(recorded_at) last FROM selected)
     SELECT to_jsonb(p) FROM bounds b CROSS JOIN LATERAL
      location_history_points_between(%s,%s,b.first,b.last) p
     JOIN selected s USING(recorded_at,source) WHERE b.first IS NOT NULL
     ORDER BY p.recorded_at DESC,p.source DESC''', (*params, args[0], args[1])).fetchall()


def main():
    checks = 0
    with connect() as db, db.transaction(force_rollback=True):
        uid, other = [r[0] for r in db.execute("INSERT INTO users(phone,email,password_hash) VALUES('p111a','p111a@example.invalid',''),('p111b','p111b@example.invalid','') RETURNING id")]
        did = db.execute("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,'p111-edge','') RETURNING id", (uid,)).fetchone()[0]
        lo = dt.datetime(2026, 10, 1, tzinfo=dt.timezone.utc)
        hi = lo + dt.timedelta(days=31)
        # Boundaries of the adaptive windows and cursor ties, with competing
        # transmissions whose anchors lie well outside the requested month.
        for hours in [0, .001, 3, 6, 12, 18, 24, 42, 48, 90, 186, 354, 522, 700, 744]:
            at = hi - dt.timedelta(hours=hours)
            for idx, source in enumerate(['l80', 'phone', 'lte_gnss', 'z-source']):
                for user in [uid, other]:
                    db.execute('''INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,sat,fixes_jsonb)
                      VALUES(%s,%s,%s,%s,%s,35,127,12,%s)''',
                      (did, user, at + dt.timedelta(microseconds=0 if user == uid else 1), source, idx % 2 == 0,
                       Jsonb([{'at_ms': -1000 * k, 'lat': 35 + k * .00001, 'lng': 127, 'sat': 12} for k in range(10)]) if idx == 0 else None))
        for offset in [-40, 40]:
            db.execute('''INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,fixes_jsonb)
              VALUES(%s,%s,%s,'l80',true,36,128,%s)''', (did, uid, hi + dt.timedelta(days=offset),
              Jsonb([{'at_ms': -offset * 86400000 - 6 * 3600000, 'lat': 36, 'lng': 128}])))
        # NULL/empty/non-array payloads follow the existing110 semantics.
        for i, payload in enumerate([None, [], {}, Jsonb(None)]):
            db.execute("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,fixes_jsonb) VALUES(%s,%s,%s,'empty',false,35,127,%s)",
                       (did, uid, lo + dt.timedelta(seconds=i), payload if payload is None or isinstance(payload, Jsonb) else Jsonb(payload)))

        def compare():
            nonlocal checks
            for user in [uid, other, other + 99999]:
                for source in [None, 'l80', 'phone', 'missing']:
                    for fix in [None, True, False]:
                        for before, before_source in [(None, None), (hi - dt.timedelta(hours=6), 'phone'), (lo, 'z-source'), (lo-dt.timedelta(seconds=1), '')]:
                            for count in [1, 7, 5001]:
                                args = (did, user, lo, hi, source, fix, before, before_source, count)
                                assert selector(db, args) == selector(db, args, True), (source, fix, before, count)
                                checks += 1
            for source in [None, 'l80', 'phone', 'missing']:
                for fix in [None, True, False]:
                    args = (did, uid, lo, hi, source, fix, None, None, 35)
                    assert projection(db, args) == projection(db, args, True), (source, fix)
                    checks += 1

        compare()
        # Legacy110 encrypted rows, then mixed pending/bounded rows, must remain exact.
        db.execute("SET LOCAL session_replication_role='replica'")
        db.execute('UPDATE location_records SET query_bounds_ready=false,query_first_at=NULL,query_last_at=NULL WHERE device_id=%s', (did,))
        db.execute("SET LOCAL session_replication_role='origin'")
        compare()
        db.execute('UPDATE location_records SET query_bounds_ready=true WHERE device_id=%s AND source=\'phone\'', (did,))
        compare()
        db.execute('UPDATE location_records SET query_bounds_ready=true WHERE device_id=%s', (did,))
        db.execute("SET TIME ZONE 'America/New_York'")
        compare()
        db.execute("SET TIME ZONE 'UTC'")
        # Follow every cursor with tiny pages; timestamps tied across sources
        # cannot disappear at either the cursor or adaptive-window boundary.
        for size in [1, 7, 31]:
            all_rows, before, src = [], None, None
            while True:
                rows = selector(db, (did, uid, lo, hi, None, None, before, src, size))
                if not rows:
                    break
                all_rows.extend(rows); before, src = rows[-1]
            assert all_rows == selector(db, (did, uid, lo, hi, None, None, None, None, 5001), True)
            assert len(all_rows) == len(set(all_rows))
            checks += 1
        # Source owner change, late correction and deletion stay uncached.
        db.execute('UPDATE devices SET owner_id=%s WHERE id=%s', (other, did))
        db.execute("UPDATE location_records SET fix=NOT fix WHERE device_id=%s AND source='phone'", (did,))
        db.execute("DELETE FROM location_records WHERE device_id=%s AND source='z-source'", (did,))
        compare()
        assert db.execute("SELECT provolatile,prosecdef FROM pg_proc WHERE proname='location_page_sample_keys'").fetchone() == ('s', False)
        checks += 1
        for lo_bad, hi_bad, size in [(None,hi,10),(lo,lo,10),(hi,lo,10),(lo,hi+dt.timedelta(seconds=1),10),(lo,hi,0),(lo,hi,5002)]:
            try:
                with db.transaction():
                    selector(db, (did,uid,lo_bad,hi_bad,None,None,None,None,size))
                raise AssertionError('invalid SQL bounds accepted')
            except psycopg.errors.InvalidParameterValue:
                checks += 1
    save('page-equivalence111.json', {'passed': True, 'comparisons': checks, 'fixture_rolled_back': True,
        'oracle': 'unchanged110 full-range page selector and all projected fields',
        'scope': ['source/fix/cursor/window ties', 'far batch anchors', 'unbackfilled/mixed ciphertext',
                  'row owners/SIM transfer', 'late update/delete', 'all cursor pages', 'timezone', 'input bounds'],
        'production_modified': False})
    print('PAGE EQUIVALENCE PASS', checks, flush=True)


if __name__ == '__main__':
    main()
