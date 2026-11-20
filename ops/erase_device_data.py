"""Device-wide active-database erasure; not an account deletion API.

Dry-run unless --execute is supplied. Requires exact SIM, owner and name.
The same job UUID resumes interrupted work; the write barrier remains enabled.
External files, backups, business/financial records are outside this executor.
Use only after separately authorizing all history owners of the selected SIM.
"""
import argparse
import json
import os
import pathlib
import uuid

import psycopg2

AGGREGATES = {'location_1min': '1 minute', 'location_5min': '5 minutes', 'location_1hour': '1 hour'}


def run(db, device, owner, name, sim, actor, job, execute=False):
    db.autocommit = True
    with db.cursor() as q:
        q.execute("SET statement_timeout='180s'; SET lock_timeout='5s'")
        q.execute('SELECT owner_id,display_name,iccid FROM devices WHERE id=%s', (device,))
        if q.fetchone() != (owner, name, sim):
            raise RuntimeError('Exact device / owner / name / SIM identity mismatch')
        q.execute('SELECT user_id,count(*) FROM location_records WHERE device_id=%s GROUP BY user_id', (device,))
        history = [{'owner_id': u, 'rows': n} for u, n in q.fetchall()]
        q.execute('SELECT state FROM device_data_erasure_jobs WHERE device_id=%s', (device,))
        prior = q.fetchone()
        report = {'device_id': device, 'history': history, 'existing_state': prior[0] if prior else None,
                  'scope': 'all-owner telemetry for one SIM; active database only',
                  'external_copies_verified': False, 'executed': execute, 'job': str(job)}
        if not execute:
            return report
        q.execute("SELECT count(*) FROM location_aggregate_archives WHERE mode='preserved_legacy'")
        if q.fetchone()[0] != 3:
            raise RuntimeError('Legacy aggregates must be preserved before erasure (migration 85)')
        q.execute('SELECT privacy_begin_device_erasure(%s,%s,%s,%s,%s)', (str(job), device, owner, name, actor))
        q.execute('SELECT privacy_erase_device_primary(%s)', (str(job),))
        report['deleted_counts'] = q.fetchone()[0]
        # Ordinary preserved tables allow a targeted DELETE. Never refresh a
        # time range shared with other SIMs or mutate Timescale internal tables.
        q.execute('SELECT privacy_erase_device_aggregates(%s)', (str(job),))
        report['deleted_counts'].update(q.fetchone()[0])
        q.execute('SELECT privacy_verify_device_erasure(%s)', (str(job),))
        q.execute('SELECT state FROM device_data_erasure_jobs WHERE id=%s', (str(job),))
        report['state'] = q.fetchone()[0]
        report['collection_blocked'] = True
        return report


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--env-file', type=pathlib.Path, required=True)
    p.add_argument('--device', type=int, required=True)
    p.add_argument('--owner', type=int, required=True)
    p.add_argument('--name', required=True)
    p.add_argument('--sim', required=True)
    p.add_argument('--actor', type=int, required=True)
    p.add_argument('--job', type=uuid.UUID, required=True)
    p.add_argument('--execute', action='store_true')
    a = p.parse_args()
    env = dict(line.split('=', 1) for line in a.env_file.read_text().splitlines()
               if '=' in line and not line.startswith('#'))
    os.umask(0o077)
    db = psycopg2.connect(env['DATABASE_URL'].strip().strip('"').strip("'"))
    try:
        print(json.dumps(run(db, a.device, a.owner, a.name, a.sim, a.actor, a.job, a.execute), ensure_ascii=False))
    finally:
        db.close()
