"""Round22 metadata replay, called only inside the offline checkpoint transaction.

No location payload, FCM token or credential. A restore never starts sending.
Identity collisions fail the whole replay; older consent cannot undo revocation.
"""
import json

TABLES = {
    'location_subject_mappings': ('request_key','owner_id','subject_id','proposed_by','staff_id','vehicle_id','binding_id','device_id','starts_at','ends_at','purpose','consent_version','replaces_id','replaces_revision','change_kind'),
    'location_subject_actions': ('mapping_id','actor_id','action','revision','at'),
    'location_provision_notices': ('event_id','mapping_id','subject_id','owner_id','actor_id','device_id','vehicle_id','purpose','consent_version','policy_reference','range_from','range_until','started_at'),
    'location_notice_attempts': ('notice_id','lease_id','attempt','result','at'),
}


def snapshot(c):
    out = {}
    for table in TABLES:
        c.execute(f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM {table} t")
        out[table] = c.fetchone()[0]
    return out


def replay(c, tables):
    for table, immutable in TABLES.items():
        if table not in tables: raise ValueError('subject checkpoint missing table')
        for row in tables[table]:
            c.execute(f'SELECT to_jsonb(t) FROM {table} t WHERE id=%s FOR UPDATE', (row['id'],))
            found = c.fetchone()
            if found:
                old = found[0]
                if any(old.get(k) != row.get(k) for k in immutable):
                    raise ValueError('subject checkpoint identity mismatch')
                if table == 'location_subject_mappings':
                    if old['revision'] > row['revision']: continue
                    if old['revision'] == row['revision'] and old['status'] != row['status']:
                        raise ValueError('subject checkpoint revision conflict')
                    c.execute('UPDATE location_subject_mappings SET status=%s,revision=%s,decided_at=%s WHERE id=%s',
                              (row['status'],row['revision'],row['decided_at'],row['id']))
                elif table == 'location_provision_notices':
                    # Preserve acknowledgements even if independently newer than checkpoint.
                    accepted = old['provider_accepted_at'] or row['provider_accepted_at']
                    read = old['read_at'] or row['read_at']
                    c.execute('''UPDATE location_provision_notices SET outcome=%s,completed_at=%s,
                        provider_accepted_at=%s,read_at=%s,delivery=%s,lease_id=NULL,lease_until=NULL,
                        last_error='restored_delivery_review' WHERE id=%s''',
                        (row['outcome'],row['completed_at'],accepted,read,
                         'provider_accepted' if accepted else 'not_provided' if row['delivery']=='not_provided' else 'review',row['id']))
            else:
                c.execute(f'INSERT INTO {table} SELECT * FROM jsonb_populate_record(NULL::{table},%s::jsonb)', (json.dumps(row),))
        c.execute(f"SELECT setval(pg_get_serial_sequence('{table}','id'),greatest(coalesce((SELECT max(id) FROM {table}),1),1),true)")
    c.execute("UPDATE location_provision_notices SET delivery='review',lease_id=NULL,lease_until=NULL,last_error='restored_delivery_review' WHERE delivery IN ('pending','waiting')")
    c.execute('UPDATE location_subject_policy SET enabled=false,push_enabled=false')
