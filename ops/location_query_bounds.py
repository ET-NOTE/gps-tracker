"""Check/backfill query time envelopes without changing encrypted location cells.

Default is read-only. Apply is resumable and bounded; use the dedicated GPS
maintenance connection, and supply the private keyring when encryption is on.
"""
import argparse
import json
import os
import pathlib
from contextlib import contextmanager

import psycopg


MAX_DECOMPRESSED_TUPLES = 5000


def _bounded_settings(db, decompression_limit):
    # Constants for the segment-by/time columns must reach Timescale's DML
    # planner even after psycopg starts preparing this frequently used UPDATE.
    # SET LOCAL stays inside our transaction/savepoint, including on failure.
    db.execute("SET LOCAL plan_cache_mode='force_custom_plan'")
    for name, ceiling in (('statement_timeout', 60000), ('lock_timeout', 5000)):
        current = int(db.execute('SELECT setting FROM pg_settings WHERE name=%s', (name,)).fetchone()[0])
        db.execute('SELECT set_config(%s,%s,true)', (name, str(min(current, ceiling) if current else ceiling)))
    db.execute("SELECT set_config('timescaledb.max_tuples_decompressed_per_dml_transaction',%s,true)",
               (str(decompression_limit),))


@contextmanager
def _bounded_transaction(db, decompression_limit):
    with db.transaction():
        previous = db.execute("""SELECT name,setting FROM pg_settings WHERE name IN
          ('plan_cache_mode','statement_timeout','lock_timeout',
           'timescaledb.max_tuples_decompressed_per_dml_transaction')""").fetchall()
        _bounded_settings(db, decompression_limit)
        yield
        # RELEASE SAVEPOINT does not restore SET LOCAL on a successful nested
        # transaction. Restore explicitly; SQL failures instead roll back the
        # savepoint (including these settings) before the caller catches them.
        for name, value in previous:
            db.execute('SELECT set_config(%s,%s,true)', (name, value))


def _write_one(db, key, decompression_limit):
    # A concrete segment/time/PK predicate excludes unrelated compressed
    # batches. Do not UPDATE ... FROM a selected-key CTE: that join can make
    # Timescale decompress every chunk before testing the join keys.
    # Autocommit callers commit one key at a time; callers already inside a
    # transaction get a savepoint and retain control of their outer commit.
    with _bounded_transaction(db, decompression_limit):
        return db.execute('''UPDATE location_records SET query_bounds_ready=true
          WHERE device_id=%s AND recorded_at=%s AND source=%s
            AND NOT query_bounds_ready''', key).rowcount


def private_text(path):
    path = pathlib.Path(path)
    meta = path.lstat()
    if not path.is_file() or path.is_symlink() or meta.st_size > 16384:
        raise ValueError('small regular private file required')
    if os.name != 'nt' and meta.st_mode & 0o077:
        raise ValueError('private file permissions must be 0600 or stricter')
    return path.read_text().strip()


def backfill(db, apply=False, batch_size=2000, max_batches=0):
    if not 1 <= batch_size <= 5000 or max_batches < 0:
        raise ValueError('invalid batch limit')
    name, version = db.execute('SELECT current_database(),max(version) FROM _sqlx_migrations WHERE success').fetchone()
    if not name.startswith('gps_') or version not in (110, 111, 112, 113, 114):
        raise ValueError('reviewed GPS schema110/111/112/113/114 required')
    enabled, maintenance = db.execute('SELECT enabled,maintenance FROM location_storage_policy WHERE singleton').fetchone()
    report = {'schema': version, 'apply': apply, 'encrypted': enabled, 'updated': 0, 'batches': 0}
    report['pending_before'] = db.execute('SELECT count(*) FROM location_records WHERE NOT query_bounds_ready').fetchone()[0]
    if apply:
        if maintenance:
            raise ValueError('storage transition in progress; finish it before query backfill')
        if enabled:
            safe = db.execute("SELECT current_setting('log_parameter_max_length')='0' AND current_setting('log_parameter_max_length_on_error')='0'").fetchone()[0]
            if not safe:
                raise ValueError('disable parameter logging before loading keys')
            db.execute("SELECT gps_open_cell(gps_seal_cell('true'::jsonb,'query-backfill'),'query-backfill')")
        locked = db.execute("SELECT pg_try_advisory_lock(hashtextextended('gps-query-bounds-110',0))").fetchone()[0]
        if not locked:
            raise ValueError('another query backfill is active')
        try:
            # Never raise an operator's lower limit. Also bound an unlimited
            # session rather than silently inheriting unbounded decompression.
            with db.transaction():
                current = int(db.execute("SELECT current_setting('timescaledb.max_tuples_decompressed_per_dml_transaction')").fetchone()[0])
            limit = min(current, MAX_DECOMPRESSED_TUPLES) if current > 0 else MAX_DECOMPRESSED_TUPLES
            report.update(decompressed_tuple_limit_per_statement=limit, statements=0)
            while not max_batches or report['batches'] < max_batches:
                with _bounded_transaction(db, limit):
                    keys = db.execute('''SELECT device_id,recorded_at,source FROM location_records
                      WHERE NOT query_bounds_ready ORDER BY device_id,recorded_at,source LIMIT %s''',
                                      (batch_size,)).fetchall()
                if not keys:
                    break
                changed = 0
                for key in keys:
                    count = _write_one(db, key, limit)
                    changed += count
                    report['updated'] += count
                    report['statements'] += 1
                report['batches'] += 1
                if not changed:
                    raise RuntimeError('selected pending rows changed concurrently; retry backfill')
        finally:
            # SQL failures inside the savepoints above have already rolled back,
            # so unlocking cannot mask them with InFailedSqlTransaction.
            db.execute("SELECT pg_advisory_unlock(hashtextextended('gps-query-bounds-110',0))")
    report['pending_after'] = db.execute('SELECT count(*) FROM location_records WHERE NOT query_bounds_ready').fetchone()[0]
    report['complete'] = report['pending_after'] == 0
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dsn-file', required=True, type=pathlib.Path)
    parser.add_argument('--keyring-file', type=pathlib.Path)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--batch-size', type=int, default=2000)
    parser.add_argument('--max-batches', type=int, default=0)
    args = parser.parse_args()
    with psycopg.connect(private_text(args.dsn_file), autocommit=True) as connection:
        connection.execute("SET statement_timeout='60s'; SET lock_timeout='5s'; SET jit=off")
        if args.keyring_file:
            safe = connection.execute("SELECT current_setting('log_parameter_max_length')='0' AND current_setting('log_parameter_max_length_on_error')='0' AND coalesce(current_setting('pgaudit.log_parameter',true),'off') IN ('off','false','0')").fetchone()[0]
            if not safe:
                raise ValueError('disable parameter logging before loading keys')
            connection.execute("SELECT set_config('gps.storage_keys',%s,false)", (private_text(args.keyring_file),))
        print(json.dumps(backfill(connection, args.apply, args.batch_size, args.max_batches), indent=2))
