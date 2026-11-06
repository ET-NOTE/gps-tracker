"""Account closure personal-scope executor. Dry run unless --execute is explicit.

Never deletes users, SIM identity, company or financial records, unowned telemetry
or ownerless legacy summaries. Never marks an entire request fulfilled. Kept
records are review obligations, not a claim of anonymisation or lawful retention.
"""
import argparse
import json

from privacy_file_cleanup import config

# Ordered for FK updates (e.g. event_id SET NULL) to occur before blocked parents.
PERSONAL = (
    ('connection_alert_episodes', 'user_id'), ('ai_analysis_requests', 'user_id'),
    ('ai_analyses', 'user_id'), ('ai_usage_log', 'user_id'),
    ('trip_annotations', 'user_id'), ('geofences', 'owner_id'),
    ('device_commands', 'user_id'), ('device_documents', 'user_id'),
    ('daily_stats', 'user_id'), ('events', 'user_id'), ('location_records', 'user_id'),
)
REVIEW = (
    ('fleet_vehicles', 'owner_id'), ('staff', 'user_id'), ('corporate_info', 'user_id'),
    ('rental_contracts', 'user_id'), ('rental_photos', 'user_id'),
    ('renter_blacklist', 'user_id'), ('fleet_expenses', 'owner_id'),
    ('fleet_expense_receipts', 'owner_id'), ('payment_orders', 'user_id'),
    ('credit_log', 'user_id'), ('sim_topup_requests', 'user_id'),
    ('vehicle_reservations', 'user_id'),
)


# What one timer run picks up. New and failed closures come first, oldest first: processing
# moves them on (review_required) or to the back (retry sets updated_at). Closures that only
# wait for their files are rechecked separately and in random order, because a recheck that
# changes nothing writes nothing: ordered by updated_at with one shared limit, five long
# holds would be picked on every run and no later request would ever start.
PENDING = '''(SELECT request_id FROM privacy_account_closures
        WHERE state IN ('restricted','retry') ORDER BY updated_at,request_id LIMIT 5)
    UNION ALL
    (SELECT request_id FROM privacy_account_closures
        WHERE state='review_required' AND review_reasons ? 'private_files_pending_or_shared'
        ORDER BY random() LIMIT 5)'''


def count(q, table, col, uid):
    # All identifiers originate in the fixed allowlists above.
    q.execute(f'SELECT count(*) FROM {table} WHERE {col}=%s', (uid,))
    return q.fetchone()[0]


def process(db, request_id, execute=False):
    with db:
        with db.cursor() as q:
            q.execute("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'")
            # Same order as administrative request transitions.
            q.execute('SELECT id FROM privacy_requests WHERE id=%s FOR UPDATE', (request_id,))
            if q.fetchone() is None:
                raise ValueError('request_not_found')
            q.execute('SELECT user_id,review_reasons,deleted_counts,state,personal_scope_verified FROM privacy_account_closures WHERE request_id=%s FOR UPDATE', (request_id,))
            job = q.fetchone()
            if not job:
                raise ValueError('closure_not_started')
            uid, prior_reasons, deleted, prior_state, prior_verified = job
            prior_deleted = dict(deleted)
            q.execute('SELECT restricted FROM privacy_account_controls WHERE user_id=%s FOR UPDATE', (uid,))
            if q.fetchone() != (True,):
                raise ValueError('restriction_missing')
            review = {t: n for t, c in REVIEW if (n := count(q, t, c, uid))}
            reasons = set(prior_reasons)
            q.execute('''SELECT count(*) FROM privacy_company_submissions p
                JOIN privacy_company_tasks t ON t.id=p.task_id
                JOIN privacy_company_reviews c ON c.id=t.review_id
                JOIN privacy_requests r ON r.id=c.request_id
                WHERE t.company_owner_id=%s OR r.user_id=%s''', (uid, uid))
            proof_count = q.fetchone()[0]
            if proof_count:
                review['privacy_company_submissions'] = proof_count
                reasons.add('company_evidence_retention_review')
            if review:
                reasons.add('company_or_financial_scope_review')
            reasons.update(('account_profile_and_audit_review', 'backups_and_external_copies_unverified',
                            'SIM_reuse_requires_review'))
            for t in ('location_records', 'events', 'daily_stats'):
                q.execute(f'SELECT count(*) FROM {t} r JOIN devices d ON d.id=r.device_id WHERE d.owner_id=%s AND r.user_id IS NULL', (uid,))
                if q.fetchone()[0]:
                    reasons.add('unattributed_history_review')
            # No account boundary in archived CAGGs, including formerly owned SIMs.
            for t in ('location_1min', 'location_5min', 'location_1hour'):
                q.execute(f'''SELECT EXISTS(SELECT 1 FROM {t} a WHERE a.device_id IN (
                    SELECT id FROM devices WHERE owner_id=%s UNION
                    SELECT device_id FROM location_records WHERE user_id=%s))''', (uid, uid))
                if q.fetchone()[0]:
                    reasons.add('legacy_aggregate_scope_review')
            eligible = not review and not reasons.intersection((
                'company_membership_subject_review', 'company_or_financial_scope_review'))
            before = {t: count(q, t, c, uid) for t, c in PERSONAL}
            report = {'request_id': request_id, 'account_id': uid, 'execute': execute,
                      'personal_scope_eligible': eligible, 'personal_scope_counts': before,
                      'retained_review_counts': review, 'review_reasons': sorted(reasons),
                      'external_copies_verified': False, 'request_fulfilled': False}
            if not execute:
                return report
            if eligible:
                for t, c in PERSONAL:
                    # Count first: Timescale compressed DML rowcount is not logical rows.
                    n = before[t]
                    q.execute(f'DELETE FROM {t} WHERE {c}=%s', (uid,))
                    deleted[t] = deleted.get(t, 0) + n
                q.execute('''UPDATE devices SET last_lat=NULL,last_lng=NULL,last_fix_at=NULL,
                    last_seen_at=NULL,last_stationary=NULL,car_image_url=NULL
                    WHERE owner_id=%s''', (uid,))
                for t, c in PERSONAL:
                    if count(q, t, c, uid):
                        raise ValueError('personal_scope_verification_failed')
            q.execute('''SELECT state,count(*) FROM privacy_file_cleanup j WHERE EXISTS(
                SELECT 1 FROM privacy_file_cleanup_sources s WHERE s.job_id=j.id AND s.owner_id=%s)
                GROUP BY state''', (uid,))
            files = dict(q.fetchall())
            if any(s != 'local_absent' for s in files):
                reasons.add('private_files_pending_or_shared')
            else:
                reasons.discard('private_files_pending_or_shared')
            verified = eligible and not any(s != 'local_absent' for s in files)
            report.update({'personal_scope_verified': verified, 'deleted_counts': deleted,
                           'file_states': files, 'review_reasons': sorted(reasons)})
            # A shared-file hold can remain for months. Do not create a new
            # request revision/event on each timer tick without a state change.
            if (prior_state == 'review_required' and prior_verified == verified
                    and prior_deleted == deleted and set(prior_reasons) == reasons):
                return report
            q.execute('''UPDATE privacy_account_closures SET state='review_required',
                personal_scope_verified=%s,deleted_counts=%s::jsonb,review_reasons=%s::jsonb,
                attempts=attempts+1,last_error=NULL,updated_at=now() WHERE request_id=%s''',
                (verified, json.dumps(deleted), json.dumps(sorted(reasons)), request_id))
            message = ('본인 계정 기준의 위치·이벤트·개인 첨부자료 처리를 확인했습니다. '
                       if verified else '자동 처리 범위 또는 첨부파일 확인이 남아 있습니다. ')
            message += '계정은 이용 종료 상태이며, 회사·거래·계정 자료와 백업 등은 별도 검토 중입니다. 전체 삭제 완료가 아닙니다.'
            q.execute('''UPDATE privacy_requests SET revision=revision+1,result_message=%s,
                updated_at=now() WHERE id=%s RETURNING revision''', (message, request_id))
            revision = q.fetchone()[0]
            q.execute('''INSERT INTO privacy_request_events(request_id,revision,status,message,evidence_reference)
                VALUES(%s,%s,'in_review',%s,%s)''', (request_id, revision, message, f'account-closure:{request_id}'))
            return report


def execute(db, request_id):
    try:
        return process(db, request_id, True)
    except Exception as exc:
        db.rollback()
        # Log a code only; SQL diagnostics may contain identifying values.
        reason = getattr(exc, 'pgcode', None) or type(exc).__name__
        with db:
            with db.cursor() as q:
                q.execute("UPDATE privacy_account_closures SET state='retry',personal_scope_verified=false,attempts=attempts+1,last_error=%s,updated_at=now() WHERE request_id=%s", (reason, request_id))
        raise RuntimeError('closure_retry:'+reason) from None


def main():
    import psycopg2
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--env-file', required=True)
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument('--request', type=int)
    group.add_argument('--pending', action='store_true')
    p.add_argument('--execute', action='store_true')
    args = p.parse_args()
    # Not `with psycopg2.connect(...) as db`: process() and execute() open their own transaction
    # with `with db`, and psycopg2 refuses to enter a connection context that is already open.
    # Wrapping the loop made every timer run fail as soon as one request was pending.
    db = psycopg2.connect(config(args.env_file)['DATABASE_URL'])
    try:
        if args.pending:
            with db, db.cursor() as q:
                q.execute(PENDING)
                ids = [r[0] for r in q.fetchall()]
        else:
            ids = [args.request]
        result = []
        for rid in ids:
            try:
                result.append(execute(db, rid) if args.execute else process(db, rid))
            except RuntimeError as exc:
                result.append({'request_id': rid, 'error': str(exc)})
    finally:
        db.close()
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
