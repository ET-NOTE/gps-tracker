"""Explicitly authorized one-year entitlements for two GPS test accounts.

Defaults to a read-only plan. --apply adds 365 days after the current expiry,
once per account/kind. No wallet balance, account type or device data changes.
Delivery currently has no paid entitlement gate; do not invent a subscription.
"""
import argparse
import datetime as dt
import json
import os
import pathlib
import urllib.parse

import psycopg2
from psycopg2.extras import RealDictCursor

parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
MARK = 'operator-grant:20261103:business-365d:455498a4'
EXPECTED = {25: 'user@user.com', 28: 'user@user4.com'}
KINDS = ('corporate_report', 'rentcar_report')
root = pathlib.Path('/home/mmm/gps-artifacts/profile-layout-20261103')
env = dict(line.split('=', 1) for line in pathlib.Path('/home/mmm/projects/gps-tracker-api/.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
dsn = env['DATABASE_URL'].strip().strip('"').strip("'")
assert urllib.parse.urlsplit(dsn).path == '/gps_tracker'

with psycopg2.connect(dsn) as db:
    db.set_session(readonly=not args.apply)
    with db.cursor(cursor_factory=RealDictCursor) as c:
        c.execute("SET LOCAL TIME ZONE 'Asia/Seoul'")
        if args.apply:
            for uid in EXPECTED:
                for kind in KINDS:
                    c.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', (f'sub:{kind}:{uid}',))
        c.execute('SELECT id,email,account_type,credits FROM users WHERE id=ANY(%s) ORDER BY id' + (' FOR UPDATE' if args.apply else ''), (list(EXPECTED),))
        users = list(c.fetchall())
        assert {u['id']: u['email'] for u in users} == EXPECTED
        c.execute('SELECT * FROM subscriptions WHERE user_id=ANY(%s) ORDER BY id', (list(EXPECTED),))
        before = list(c.fetchall())
        c.execute('SELECT count(*) AS count FROM credit_log WHERE user_id=ANY(%s)', (list(EXPECTED),))
        ledger = c.fetchone()['count']
        c.execute('SELECT now() AS now')
        now = c.fetchone()['now']
        result = []
        existing = [row for row in before if row['note'] == MARK]
        assert len(existing) in (0, 4), 'Partial grant requires investigation'
        if args.apply:
            os.umask(0o077)
            root.mkdir(mode=0o700, parents=True, exist_ok=True)
            backup = root/'subscription-before.json'
            if not existing:
                assert not backup.exists(), 'Prior attempt requires checking before replay'
                backup.write_text(json.dumps(dict(marker=MARK, users=users, subscriptions=before, credit_log_count=ledger), default=str, ensure_ascii=False, indent=2))
        for uid, email in EXPECTED.items():
            for kind in KINDS:
                already = [r for r in existing if r['user_id'] == uid and r['kind'] == kind]
                assert len(already) <= 1
                if already:
                    row = already[0]
                    assert row['expires_at']-row['starts_at'] == dt.timedelta(days=365)
                    result.append(dict(email=email, kind=kind, id=row['id'], starts_at=row['starts_at'], expires_at=row['expires_at'], already_applied=True))
                    continue
                expiry = max([now] + [r['expires_at'] for r in before if r['user_id'] == uid and r['kind'] == kind])
                end = expiry + dt.timedelta(days=365)
                row = dict(email=email, kind=kind, starts_at=expiry, expires_at=end)
                if args.apply:
                    c.execute('INSERT INTO subscriptions(user_id,kind,starts_at,expires_at,paid_credits,note) VALUES(%s,%s,%s,%s,NULL,%s) RETURNING id', (uid, kind, expiry, end, MARK))
                    row['id'] = c.fetchone()['id']
                result.append(row)
        if args.apply:
            c.execute('SELECT id,email,account_type,credits FROM users WHERE id=ANY(%s) ORDER BY id', (list(EXPECTED),))
            assert list(c.fetchall()) == users
            c.execute('SELECT * FROM subscriptions WHERE id=ANY(%s) ORDER BY id', ([r['id'] for r in before],))
            assert list(c.fetchall()) == before
            c.execute('SELECT count(*) AS count FROM credit_log WHERE user_id=ANY(%s)', (list(EXPECTED),))
            assert c.fetchone()['count'] == ledger
            c.execute('SELECT count(*) AS count FROM subscriptions WHERE note=%s', (MARK,))
            assert c.fetchone()['count'] == 4
    db.commit()
    if args.apply:
        (root/'subscription-grant.json').write_text(json.dumps(dict(marker=MARK, grants=result, wallet_unchanged=True, delivery='No paid subscription gate'), default=str, ensure_ascii=False, indent=2))
    print(json.dumps(dict(applied=args.apply, grants=result, delivery='No paid subscription gate'), default=str, ensure_ascii=False))
