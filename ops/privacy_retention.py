"""Round 21 personal telemetry retention. Dry-run by default; policy and consent required.

No current-SIM-owner reassignment, inferred consent, financial/file deletion or
claim of backup erasure. Each account is atomic with a durable replay cutoff.
Run hourly under the reviewed maintenance identity; no systemd activation here.
"""
import argparse, json, pathlib
from privacy_worker_db import connect, transaction

LOCK = 210571031
TABLES = {
    'location_records': 'recorded_at < %s',
    'events': 'occurred_at < %s',
    'daily_stats': "date <= (%s AT TIME ZONE 'Asia/Seoul')::date",
    'fcm_outbox': 'created_at < %s',
    'ai_analyses': "target_date <= (%s AT TIME ZONE 'Asia/Seoul')::date",
}


def run(cfg, execute=False):
    db = connect(cfg)
    reports = []
    try:
        with transaction(db), db.cursor() as c:
            c.execute('SELECT enabled,policy_reference FROM privacy_retention_policy WHERE singleton')
            enabled, reference = c.fetchone()
            if execute and not enabled:
                raise ValueError('retention policy is OFF; nothing removed')
            c.execute('SELECT user_id FROM privacy_retention_consents ORDER BY user_id')
            accounts = [r[0] for r in c.fetchall()]
        for uid in accounts:
            with transaction(db), db.cursor() as c:
                c.execute("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'")
                c.execute('SELECT pg_try_advisory_xact_lock(%s)', (LOCK,))
                if not c.fetchone()[0]:
                    raise ValueError('processing in flight; retry without partial account deletion')
                c.execute('SELECT enabled FROM privacy_retention_policy WHERE singleton FOR SHARE')
                if execute and not c.fetchone()[0]:
                    raise ValueError('retention disabled during run')
                c.execute('''SELECT CASE WHEN months>6 AND contract_until<=now() THEN now()
                    ELSE now()-make_interval(months=>months) END
                    FROM privacy_retention_consents WHERE user_id=%s FOR SHARE''', (uid,))
                cutoff = c.fetchone()[0]
                # Retention never moves backwards after a contract/consent change.
                c.execute('SELECT greatest(%s,max(cutoff)) FROM privacy_retention_runs WHERE user_id=%s', (cutoff, uid))
                cutoff = c.fetchone()[0]
                reasons = ['external_backups_and_exports_unverified', 'personal_files_and_audit_separate_policy']
                c.execute('''SELECT EXISTS(SELECT 1 FROM fleet_vehicles WHERE owner_id=%s)
                    OR EXISTS(SELECT 1 FROM fleet_staff_accounts WHERE account_id=%s)''', (uid, uid))
                company = c.fetchone()[0]
                c.execute("SELECT to_regclass('location_subject_mappings') IS NOT NULL")
                if c.fetchone()[0]:
                    c.execute("SELECT EXISTS(SELECT 1 FROM location_subject_mappings WHERE owner_id=%s OR subject_id=%s)",(uid,uid))
                    mapped = c.fetchone()[0]
                    company = company or mapped
                if company:
                    reasons.append('company_subject_and_retention_review')
                c.execute('''SELECT EXISTS(SELECT 1 FROM location_records r JOIN devices d ON d.id=r.device_id
                    WHERE (d.owner_id=%s OR r.device_id IN (SELECT device_id FROM location_records WHERE user_id=%s)) AND r.user_id IS NULL)''', (uid,uid))
                if c.fetchone()[0]: reasons.append('unattributed_history_review')
                c.execute("SELECT EXISTS(SELECT 1 FROM location_1min a WHERE a.device_id IN (SELECT id FROM devices WHERE owner_id=%s UNION SELECT device_id FROM location_records WHERE user_id=%s))", (uid,uid))
                if c.fetchone()[0]: reasons.append('legacy_aggregate_scope_review')
                counts = {}
                for table, predicate in TABLES.items():
                    c.execute(f'SELECT count(*) FROM {table} WHERE user_id=%s AND {predicate}', (uid, cutoff))
                    counts[table] = c.fetchone()[0]
                report = {'account_id': uid, 'cutoff': cutoff.isoformat(), 'execute': execute,
                          'eligible': not company, 'counts': counts, 'review_reasons': reasons,
                          'external_copies_verified': False}
                if execute and not company:
                    # Fence concurrent ingestion, including retransmits at old timestamps.
                    c.execute('LOCK TABLE location_records IN SHARE ROW EXCLUSIVE MODE')
                    c.execute('SELECT array_agg(id) FROM (SELECT id FROM devices WHERE owner_id=%s UNION SELECT device_id FROM location_records WHERE user_id=%s) d', (uid,uid))
                    device_ids=c.fetchone()[0] or []
                    c.execute('DELETE FROM fcm_outbox WHERE user_id=%s AND event_id IN (SELECT id FROM events WHERE user_id=%s AND occurred_at<%s)', (uid,uid,cutoff))
                    for table, predicate in TABLES.items():
                        c.execute(f'DELETE FROM {table} WHERE user_id=%s AND {predicate}', (uid, cutoff))
                    c.execute('''UPDATE devices SET last_lat=NULL,last_lng=NULL,last_fix_at=NULL
                        WHERE owner_id=%s AND last_fix_at<%s''', (uid, cutoff))
                    # Geocode cells are not attributable to a subject: evict the cache,
                    # never claim pseudonymous coordinate keys are anonymous.
                    c.execute('DELETE FROM geocode_cache')
                    for table, predicate in TABLES.items():
                        c.execute(f'SELECT count(*) FROM {table} WHERE user_id=%s AND {predicate}', (uid, cutoff))
                        if c.fetchone()[0]: raise ValueError('retention verification failed')
                    c.execute('''INSERT INTO privacy_retention_runs(user_id,cutoff,counts,review_reasons,device_ids)
                        VALUES(%s,%s,%s::jsonb,%s::jsonb,%s)''', (uid, cutoff, json.dumps(counts), json.dumps(reasons),device_ids))
                    report['covered_rows_erased'] = True
                else:
                    report['covered_rows_erased'] = False
                reports.append(report)
        return {'policy_enabled': enabled, 'accounts': reports, 'unconsented_accounts_untouched': True}
    finally:
        db.close()


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--config', required=True, help='private JSON: DATABASE_URL and encryption settings')
    p.add_argument('--execute', action='store_true')
    a = p.parse_args()
    f = pathlib.Path(a.config)
    if f.stat().st_mode & 0o077: raise SystemExit('config must be mode 600')
    print(json.dumps(run(json.loads(f.read_text()), a.execute), indent=2))
