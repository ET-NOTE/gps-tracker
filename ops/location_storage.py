"""Core-field encryption conversion/check, using a separate maintenance credential.

Default is read-only. Only dedicated gps_ databases at schema 103/104/105/106 are accepted.
Activation is one-way: there is deliberately no plaintext rollback switch.
Stop all API/worker writers before --activate/--convert; retain keyring separately
from DB dumps. Old WAL, snapshots, derived fields and files are NOT erased here.
"""
import argparse, base64, json, os, pathlib, stat
import psycopg
from psycopg import sql

def private_json(path):
    p = pathlib.Path(path)
    if p.is_symlink() or not p.is_file() or p.stat().st_size>8192 or stat.S_IMODE(p.stat().st_mode) & 0o077:
        raise ValueError('private regular file (0600) required')
    return json.loads(p.read_text())

def validate_keyring(ring):
    import re
    if not isinstance(ring, dict) or set(ring) != {'active','keys'} or not isinstance(ring['keys'],dict):
        raise ValueError('invalid keyring structure')
    keys=ring['keys']
    if not 1 <= len(keys) <= 16 or ring['active'] not in keys: raise ValueError('invalid active key')
    seen=set()
    for kid,value in keys.items():
        if not re.fullmatch(r'[A-Za-z0-9-]{1,40}',kid) or not isinstance(value,str): raise ValueError('invalid key')
        decoded=base64.b64decode(value,validate=True)
        if len(decoded)!=32 or base64.b64encode(decoded).decode()!=value or decoded in seen: raise ValueError('keys must be distinct canonical 256-bit values')
        seen.add(decoded)

def create_keyring(path):
    ring = {'active': 'v1', 'keys': {'v1': base64.b64encode(os.urandom(32)).decode()}}
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(ring, f); f.write('\n'); f.flush(); os.fsync(f.fileno())

def run(dsn, keyring, activate=False, convert=False, batch=500):
    validate_keyring(keyring)
    db = psycopg.connect(dsn)
    db.autocommit = False
    report = {'scope':'registered location fields; old WAL/backups need separate retirement', 'tables':{}}
    try:
        with db.cursor() as c:
            c.execute("SELECT current_database(),(SELECT max(version) FROM _sqlx_migrations WHERE success)")
            name, version = c.fetchone()
            if not name.startswith('gps_') or version not in (103,104,105,106): raise ValueError('dedicated GPS schema 103/104/105/106 required')
            if not 1 <= batch <= 1000: raise ValueError('batch must be 1..1000')
            c.execute("SELECT current_setting('log_parameter_max_length')='0' AND current_setting('log_parameter_max_length_on_error')='0' AND coalesce(current_setting('pgaudit.log_parameter',true),'off') IN ('off','false','0')")
            if not c.fetchone()[0]: raise ValueError('disable database bind-parameter logging before loading keys')
            # Psycopg 3 uses protocol parameters; never interpolate keys into SQL.
            c.execute("SELECT set_config('gps.storage_keys',%s,false)", (json.dumps(keyring),))
            c.execute("SET timezone='UTC'")
            c.execute("SET lock_timeout='5s'; SET statement_timeout='60s'")
            if version>=104:
                c.execute('SELECT maintenance FROM location_storage_policy WHERE singleton')
                if (activate or convert) and not c.fetchone()[0]: raise ValueError('maintenance fence required')
            c.execute('SELECT enabled FROM location_storage_policy WHERE singleton FOR UPDATE')
            enabled = c.fetchone()[0]
            if activate and not enabled:
                c.execute("SELECT gps_open_cell(gps_seal_cell('1'::jsonb,'probe'),'probe')= '1'::jsonb")
                if not c.fetchone()[0]: raise ValueError('key self-test failed')
                c.execute('UPDATE location_storage_policy SET enabled=true,activated_at=clock_timestamp() WHERE singleton')
                enabled = True
            if convert and not enabled: raise ValueError('activate before converting')
            c.execute('SELECT table_name,identity_columns,fields FROM location_storage_fields ORDER BY table_name')
            tables = c.fetchall()
        db.commit()
        for table, ids, fields in tables:
            converted = 0
            # Bounded transactions; restart resumes on remaining plaintext/old key.
            while convert:
                with db.cursor() as c:
                    # Owner-only, fenced rewrite: encrypt retained restricted data without reopening collection.
                    if version>=104:c.execute("SET LOCAL gps.storage_rewrite='on'")
                    # Full logical values must survive conversion without new business versions/audits.
                    disabled=[]
                    if version>=104:
                        c.execute(sql.SQL('LOCK TABLE {} IN ACCESS EXCLUSIVE MODE').format(sql.Identifier(table)))
                        c.execute("SELECT tgname FROM pg_trigger WHERE tgrelid=%s::regclass AND NOT tgisinternal AND tgenabled='O' AND tgname IN ('fleet_site_update','fleet_site_updated_version','privacy_company_proof_immutable','privacy_image_payload_guard','privacy_receipt_revision','privacy_receipt_source_cleanup')",(table,))
                        disabled=[r[0] for r in c.fetchall()]
                        for trigger in disabled:
                            c.execute(sql.SQL('ALTER TABLE {} DISABLE TRIGGER {}').format(sql.Identifier(table),sql.Identifier(trigger)))
                    terms=[]; args=[]
                    for f in fields:
                        terms.append(sql.SQL('({plain} IS NOT NULL OR ({sealed} IS NOT NULL AND {sealed}->>\'kid\' IS DISTINCT FROM %s))').format(plain=sql.Identifier(f), sealed=sql.Identifier(f+'_sealed')))
                        args.append(keyring['active'])
                    c.execute(sql.SQL('SELECT {} FROM {} WHERE {} ORDER BY {} LIMIT %s'+(' FOR UPDATE' if version<104 else '')).format(
                        sql.SQL(',').join(map(sql.Identifier,ids)),sql.Identifier(table),sql.SQL(' OR ').join(terms),sql.SQL(',').join(map(sql.Identifier,ids))),args+[batch])
                    keys=c.fetchall()
                    if not keys:
                        for trigger in disabled:c.execute(sql.SQL('ALTER TABLE {} ENABLE TRIGGER {}').format(sql.Identifier(table),sql.Identifier(trigger)))
                        db.commit(); break
                    predicate=sql.SQL(' AND ').join(sql.SQL('t.{}=r.{}').format(sql.Identifier(k),sql.Identifier(k)) for k in ids)
                    where=sql.SQL(' AND ').join(sql.SQL('t.{}=%s').format(sql.Identifier(k)) for k in ids)
                    for row in keys:
                        c.execute(sql.SQL('UPDATE {} t SET {} FROM {} r WHERE {} AND {}').format(
                            sql.Identifier(table),sql.SQL(',').join(sql.SQL('{}=r.{}').format(sql.Identifier(f),sql.Identifier(f)) for f in fields),
                            sql.Identifier('gps_read_'+table),predicate,where),row)
                        converted+=c.rowcount
                    for trigger in disabled:c.execute(sql.SQL('ALTER TABLE {} ENABLE TRIGGER {}').format(sql.Identifier(table),sql.Identifier(trigger)))
                db.commit()
            with db.cursor() as c:
                plain=sql.SQL(' OR ').join(sql.SQL('{} IS NOT NULL').format(sql.Identifier(f)) for f in fields)
                c.execute(sql.SQL('SELECT count(*),count(*) FILTER(WHERE {}) FROM {}').format(plain,sql.Identifier(table)))
                total, pending=c.fetchone()
                # Force each decrypted value to be evaluated; COUNT(*) alone does not.
                c.execute(sql.SQL('SELECT sum(octet_length(row_to_json(r)::text)) FROM {} r').format(sql.Identifier('gps_read_'+table)))
                c.fetchone()
                report['tables'][table]={'rows':total,'plaintext_rows':pending,'converted':converted,'decrypt_scan':'passed'}
            db.commit()
        report['enabled']=enabled
        return report
    finally: db.close()

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--create-keyring');p.add_argument('--dsn-file');p.add_argument('--keyring-file')
    p.add_argument('--activate',action='store_true');p.add_argument('--convert',action='store_true');p.add_argument('--batch',type=int,default=500)
    a=p.parse_args()
    if a.create_keyring:
        if any([a.dsn_file,a.keyring_file,a.activate,a.convert]):p.error('create-keyring must run separately')
        create_keyring(a.create_keyring);print('Private keyring created; no key printed.')
    else:
        if not a.dsn_file or not a.keyring_file:p.error('private DSN JSON {"dsn":...} and keyring files required')
        print(json.dumps(run(private_json(a.dsn_file)['dsn'],private_json(a.keyring_file),a.activate,a.convert,a.batch),indent=2))
