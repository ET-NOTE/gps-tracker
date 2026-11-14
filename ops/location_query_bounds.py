"""Check/backfill query time envelopes without changing encrypted location cells.

Default is read-only. Apply is resumable and bounded; use the dedicated GPS
maintenance connection, and supply the private keyring when encryption is on.
"""
import argparse
import json
import os
import pathlib

import psycopg


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
    if not name.startswith('gps_') or version not in (110, 111, 112, 113):
        raise ValueError('reviewed GPS schema110/111/112/113 required')
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
            while not max_batches or report['batches'] < max_batches:
                # No SKIP LOCKED: an interrupted/locked batch must not be reported
                # as complete. Each statement is atomic and commits independently.
                count = db.execute('''WITH batch AS (
                  SELECT device_id,recorded_at,source FROM location_records
                  WHERE NOT query_bounds_ready ORDER BY device_id,recorded_at,source LIMIT %s
                ) UPDATE location_records r SET query_bounds_ready=true FROM batch b
                  WHERE r.device_id=b.device_id AND r.recorded_at=b.recorded_at AND r.source=b.source
                    AND NOT r.query_bounds_ready''', (batch_size,)).rowcount
                if not count:
                    break
                report['updated'] += count
                report['batches'] += 1
        finally:
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
