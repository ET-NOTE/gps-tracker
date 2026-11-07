"""Export a private, separately retained privacy checkpoint; replay before restore opens.

The operator must obtain the LATEST checkpoint/hash from independent custody.
An old DB cannot prove that a checkpoint is latest. No live-server restoration.
"""
import argparse, hashlib, json, os, pathlib
from privacy_worker_db import connect, transaction
from privacy_retention import TABLES, LOCK

def export(cfg, path):
    db = connect(cfg)
    try:
        with transaction(db), db.cursor() as c:
            c.execute('SELECT pg_advisory_xact_lock(%s)', (LOCK,))
            result = {'version': 1, 'tables': {}}
            for name in ('privacy_processing_controls', 'privacy_retention_consents', 'privacy_retention_runs', 'device_data_controls', 'privacy_account_controls'):
                c.execute(f"SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM {name} t")
                result['tables'][name] = c.fetchone()[0]
            c.execute("SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'created_at',created_at,'iccid',iccid,'owner_id',owner_id)),'[]'::jsonb) FROM devices")
            result['sim_identities']=c.fetchone()[0]
            c.execute("SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'created_at',created_at)), '[]'::jsonb) FROM users WHERE id IN (SELECT user_id FROM privacy_processing_controls UNION SELECT user_id FROM privacy_retention_consents UNION SELECT user_id FROM privacy_retention_runs UNION SELECT user_id FROM privacy_account_controls)")
            result['identities'] = c.fetchone()[0]
            body = json.dumps(result, sort_keys=True, separators=(',', ':')).encode()
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'wb') as f:
            f.write(body); f.flush(); os.fsync(f.fileno())
        return {'sha256': hashlib.sha256(body).hexdigest(), 'bytes': len(body)}
    finally: db.close()

def restore(cfg, path, expected_sha256):
    body = pathlib.Path(path).read_bytes()
    if hashlib.sha256(body).hexdigest() != expected_sha256: raise ValueError('checkpoint hash mismatch')
    data = json.loads(body)
    if data.get('version') != 1: raise ValueError('unsupported checkpoint')
    db = connect(cfg)
    try:
        with transaction(db), db.cursor() as c:
            c.execute("SELECT pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid='privacy_retention_policy'::regclass),'USAGE')")
            if not c.fetchone()[0]: raise ValueError('maintenance owner required')
            c.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")
            if c.fetchone()[0]: raise ValueError('stop all API/worker/client sessions before restore')
            c.execute('SELECT pg_advisory_xact_lock(%s)', (LOCK,))
            for identity in data['identities']:
                c.execute('SELECT created_at=%s::timestamptz FROM users WHERE id=%s', (identity['created_at'], identity['id']))
                if c.fetchone() != (True,): raise ValueError('checkpoint account identity mismatch')
            for identity in data['sim_identities']:
                c.execute('SELECT created_at=%s::timestamptz AND iccid IS NOT DISTINCT FROM %s AND owner_id IS NOT DISTINCT FROM %s FROM devices WHERE id=%s', (identity['created_at'],identity['iccid'],identity['owner_id'],identity['id']))
                if c.fetchone() != (True,): raise ValueError('checkpoint SIM identity mismatch')
            for row in data['tables']['device_data_controls']:
                c.execute('''UPDATE device_data_controls SET blocked=blocked OR %s,
                    collection_paused=%s,collection_enforced=true,collection_epoch=gen_random_uuid(),
                    collection_changed_at=clock_timestamp(),collection_ack_epoch=NULL,collection_ack_at=NULL,collection_ack_uid=NULL
                    WHERE device_id=%s AND collection_changed_at<=%s::timestamptz''',
                    (row['blocked'],row['collection_paused'],row['device_id'],row['collection_changed_at']))
            for row in data['tables']['privacy_account_controls']:
                if row['restricted']:
                    c.execute('UPDATE privacy_account_controls SET restricted=true,restricted_at=%s WHERE user_id=%s', (row['restricted_at'],row['user_id']))
            for row in data['tables']['privacy_processing_controls']:
                c.execute('''INSERT INTO privacy_processing_controls(user_id,use_paused,provision_paused,revision,changed_at)
                    VALUES(%s,%s,%s,%s,%s) ON CONFLICT(user_id) DO UPDATE SET use_paused=excluded.use_paused,
                    provision_paused=excluded.provision_paused,revision=excluded.revision,changed_at=excluded.changed_at
                    WHERE privacy_processing_controls.revision<=excluded.revision''', tuple(row[k] for k in ('user_id','use_paused','provision_paused','revision','changed_at')))
            # Consent is not inferred from backups. Reapply the latest reviewed record.
            for row in data['tables']['privacy_retention_consents']:
                c.execute('''INSERT INTO privacy_retention_consents(user_id,months,contract_until,consent_reference,consent_at)
                    VALUES(%s,%s,%s,%s,%s) ON CONFLICT(user_id) DO UPDATE SET months=excluded.months,
                    contract_until=excluded.contract_until,consent_reference=excluded.consent_reference,consent_at=excluded.consent_at
                    WHERE privacy_retention_consents.consent_at<=excluded.consent_at''', tuple(row[k] for k in ('user_id','months','contract_until','consent_reference','consent_at')))
            for row in data['tables']['privacy_retention_runs']:
                c.execute('''INSERT INTO privacy_retention_runs(user_id,cutoff,counts,review_reasons,device_ids)
                    SELECT %s,%s,%s::jsonb,%s::jsonb,%s WHERE NOT EXISTS(SELECT 1 FROM privacy_retention_runs WHERE user_id=%s AND cutoff=%s)''',
                    (row['user_id'],row['cutoff'],json.dumps(row['counts']),json.dumps(row['review_reasons']),row['device_ids'],row['user_id'],row['cutoff']))
            c.execute('SELECT user_id,max(cutoff) FROM privacy_retention_runs GROUP BY user_id')
            boundaries = c.fetchall()
            for uid, cutoff in boundaries:
                for table, predicate in TABLES.items():
                    c.execute(f'DELETE FROM {table} WHERE user_id=%s AND {predicate}', (uid,cutoff))
                c.execute('UPDATE devices SET last_lat=NULL,last_lng=NULL,last_fix_at=NULL WHERE owner_id=%s AND last_fix_at<%s', (uid,cutoff))
            c.execute('DELETE FROM geocode_cache')
        return {'replayed_accounts': len(boundaries), 'paused_controls_replayed': True, 'external_copies_verified': False}
    finally: db.close()

if __name__ == '__main__':
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['export','restore']);p.add_argument('--config',required=True);p.add_argument('--checkpoint',required=True);p.add_argument('--expected-sha256')
    a=p.parse_args();f=pathlib.Path(a.config)
    if f.stat().st_mode & 0o077: raise SystemExit('private config required')
    cfg=json.loads(f.read_text())
    result=export(cfg,a.checkpoint) if a.mode=='export' else restore(cfg,a.checkpoint,a.expected_sha256)
    print(json.dumps(result,indent=2))
