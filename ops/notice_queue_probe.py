"""Read-only queue probe. No outbound notification, DDL or policy change.

Exit 0 healthy; 1 warning; 2 critical/query unavailable. Feed to the external
watcher's existing alert transport only after candidate activation. A separate
SELECT-only monitoring DB identity and private credential file are required.
"""
import argparse
import json
import os
from pathlib import Path
import stat
import sys

import psycopg


def probe(secret, sql_file, expected):
    p = Path(secret)
    if os.name != 'nt' and stat.S_IMODE(p.stat().st_mode) & 0o077:
        raise ValueError('private credential file required')
    dsn = json.loads(p.read_text())['dsn']
    with psycopg.connect(dsn, connect_timeout=5) as db:
        db.execute('SET TRANSACTION READ ONLY')
        db.execute("SET LOCAL statement_timeout='2s'")
        row = db.execute(Path(sql_file).read_text().replace('$1', '%s'), (expected,)).fetchone()
        if not row:
            raise ValueError('queue singleton missing')
        db.rollback()
    return row[0]


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--credential-file', required=True)
    parser.add_argument('--sql-file', default=str(Path(__file__).with_name('subject_queue_health.sql') if Path(__file__).with_name('subject_queue_health.sql').exists() else Path(__file__).resolve().parents[1] / 'gps-tracker-api/sql/subject_queue_health.sql'))
    parser.add_argument('--expect-running', action='store_true')
    args = parser.parse_args()
    try:
        result = probe(args.credential_file, args.sql_file, args.expect_running)
    except Exception:
        result = {'severity': 'critical', 'alerts': ['probe_failed']}
    print(json.dumps(result, sort_keys=True))
    sys.exit({'ok': 0, 'warning': 1, 'critical': 2}[result['severity']])
