"""Read-only operator inventory, NOT an erasure selector or an account export.

Collection ownership is separate from current SIM ownership and company roles.
No coordinates, names, email addresses, document names or secret values in output.
Backup roots are explicitly supplied. No retention period or deletion is inferred.
"""
import argparse
from privacy_worker_db import connect, transaction
import datetime as dt
import json
import os
import pathlib

from privacy_file_cleanup import config


def account_scope(db, uid):
    if hasattr(db, 'read_only'):
        from psycopg import IsolationLevel
        db.isolation_level=IsolationLevel.REPEATABLE_READ
        db.read_only=True
    else:
        db.set_session(isolation_level='REPEATABLE READ', readonly=True)
    with transaction(db):
        with db.cursor() as q:
            q.execute("SET LOCAL statement_timeout='10s'")
            q.execute('SELECT EXISTS(SELECT 1 FROM users WHERE id=%s)', (uid,))
            if not q.fetchone()[0]:
                raise ValueError('account_not_found')
            telemetry = {}
            for table in ('location_records', 'events', 'daily_stats'):
                q.execute(f"""SELECT
                  count(*) FILTER(WHERE r.user_id=%s),
                  count(*) FILTER(WHERE r.user_id=%s AND d.owner_id IS DISTINCT FROM %s),
                  count(*) FILTER(WHERE d.owner_id=%s AND r.user_id IS NOT NULL AND r.user_id<>%s),
                  count(*) FILTER(WHERE d.owner_id=%s AND r.user_id IS NULL)
                  FROM {table} r LEFT JOIN devices d ON d.id=r.device_id
                  WHERE r.user_id=%s OR d.owner_id=%s""", (uid,) * 8)
                telemetry[table] = dict(zip(('collected_for_account', 'detached_or_transferred_history',
                    'other_accounts_on_current_sims_excluded', 'unattributed_on_current_sims_needs_review'), q.fetchone()))
            items = {}
            for table, column in (
                ('devices', 'owner_id'), ('device_documents', 'user_id'),
                ('rental_photos', 'user_id'), ('fleet_expense_receipts', 'owner_id'),
                ('fleet_vehicles', 'owner_id'), ('staff', 'user_id'),
                ('fleet_staff_accounts', 'account_id'), ('fleet_expenses', 'owner_id'),
                ('rental_contracts', 'user_id'), ('payment_orders', 'user_id'),
                ('credit_log', 'user_id'), ('sim_topup_requests', 'user_id'),
                ('trip_annotations', 'user_id'), ('ai_analyses', 'user_id')):
                q.execute(f'SELECT count(*) FROM {table} WHERE {column}=%s', (uid,))
                items[table] = q.fetchone()[0]
            q.execute("""SELECT count(*),COALESCE(sum(octet_length(content)),0),
              count(*) FILTER(WHERE removed_at IS NOT NULL)
              FROM fleet_expense_receipts WHERE owner_id=%s""", (uid,))
            count, size, hidden = q.fetchone()
            receipts = {'count': count, 'bytes_in_db': int(size), 'hidden_but_retained': hidden}
            # Counts of companies where this account is an employee must not be
            # mistaken for datasets owned by the departing employee.
            q.execute("""SELECT count(DISTINCT a.owner_id),count(DISTINCT a.staff_id),
              (SELECT count(*) FROM fleet_expenses WHERE created_by=%s AND owner_id<>%s)
              FROM fleet_staff_accounts a WHERE a.account_id=%s""", (uid, uid, uid))
            companies, staff, authored = q.fetchone()
            q.execute("""SELECT state,count(*) FROM privacy_file_cleanup j
              WHERE EXISTS(SELECT 1 FROM privacy_file_cleanup_sources s WHERE s.job_id=j.id AND s.owner_id=%s)
              GROUP BY state""", (uid,))
            file_states = dict(q.fetchall())
    return {'account_id': uid, 'read_only': True, 'deletion_ready': False,
        'telemetry': telemetry, 'owned_or_linked_record_counts': items,
        'company_membership_only': {'companies': companies, 'staff_links': staff,
            'expenses_authored_for_other_companies': authored, 'company_data_auto_delete': False},
        'receipt_storage': receipts, 'file_cleanup_states': file_states,
        'manual_boundaries': ['NULL owner is not anonymization',
            'SIM-only legacy aggregates have no reliable account boundary',
            'Company driver/name snapshots require subject review even after unlinking',
            'Financial and contract retention requires a confirmed policy',
            'Local absence does not prove backup, cache or external-copy erasure']}


def copies_inventory(roots):
    inventories = []
    for name in roots:
        root = pathlib.Path(name)
        item = {'root': str(root), 'status': 'review_required', 'files': 0,
                'bytes': 0, 'symlinks_not_followed': 0, 'unreadable_entries': 0,
                'database_dump_candidates': 0, 'sql_file_candidates': 0, 'archive_candidates': 0,
                'offsite_receipts': 0, 'oldest_mtime_utc': None, 'newest_mtime_utc': None}
        if not root.is_absolute() or root.is_symlink() or not root.is_dir():
            item['status'] = 'unavailable'
            inventories.append(item)
            continue
        stamps = []
        def error(_):
            item['unreadable_entries'] += 1
        for folder, dirs, files in os.walk(root, followlinks=False, onerror=error):
            for child in dirs[:]:
                if pathlib.Path(folder, child).is_symlink():
                    dirs.remove(child)
                    item['symlinks_not_followed'] += 1
            for child in files:
                p = pathlib.Path(folder, child)
                try:
                    if p.is_symlink():
                        item['symlinks_not_followed'] += 1
                        continue
                    info = p.stat()
                    item['files'] += 1
                    item['bytes'] += info.st_size
                    stamps.append(info.st_mtime)
                    item['database_dump_candidates'] += int(child.endswith('.dump'))
                    item['sql_file_candidates'] += int(child.endswith(('.sql', '.sql.gz')))
                    item['archive_candidates'] += int(child.endswith(('.tar.gz', '.tgz', '.zip', '.age', '.gpg')))
                    item['offsite_receipts'] += int(child == 'offsite-verified.json')
                except OSError:
                    item['unreadable_entries'] += 1
        if stamps:
            item['oldest_mtime_utc'], item['newest_mtime_utc'] = (
                dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat() for t in (min(stamps), max(stamps)))
        inventories.append(item)
    return {'roots': inventories, 'coverage': 'explicit_roots_only',
        'content_inspected': False, 'external_copies_verified': False,
        'unverified': ['VPS provider snapshots/replicas', 'unlisted external disks or hosts',
            'browser/app caches', 'downloaded/shared exports', 'external processor retention'],
        'restore_rule': 'Restore only in isolation; replay erasure obligations and verify before serving',
        'deletion_performed': False}


def main():

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', required=True)
    parser.add_argument('--account', type=int, required=True)
    parser.add_argument('--copy-root', action='append', default=[])
    args = parser.parse_args()
    cfg = config(args.env_file)
    db = connect(cfg)
    try:
        report = {'captured_at': dt.datetime.now(dt.timezone.utc).isoformat(),
                  'account': account_scope(db, args.account), 'copies': copies_inventory(args.copy_root)}
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        db.close()


if __name__ == '__main__':
    main()
