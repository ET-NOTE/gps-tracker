"""Round 20B offline conversion helper. No service restart or production deployment.

Requires separate maintenance credentials. Serving/cleanup sessions must be stopped.
ON is one-way; recovery restores ciphertext with its separately held keys.
File roots must be GPS-owned, excluding downloads/static bundles/other projects.
"""
import argparse, base64, hashlib, json, os, pathlib, stat, time
import psycopg
from location_storage import private_json, validate_keyring, run as convert_database

MAGIC = b'GPSFILE1\n'
LIMIT = 10 * 1024 * 1024

def connect(dsn, ring):
    validate_keyring(ring)
    db = psycopg.connect(dsn, autocommit=True)
    with db.cursor() as c:
        c.execute("SELECT current_database(),(SELECT max(version) FROM _sqlx_migrations WHERE success),current_setting('log_parameter_max_length'),current_setting('log_parameter_max_length_on_error'),coalesce(current_setting('pgaudit.log_parameter',true),'off')")
        name, version, normal, error, audit = c.fetchone()
        if not name.startswith('gps_') or version not in (104,105,106,107,108,109): raise ValueError('GPS schema 104/105/106/107/108/109 required')
        if normal != '0' or error != '0' or audit not in ('off','false','0'): raise ValueError('bind logging must be disabled')
        c.execute("SELECT set_config('gps.storage_keys',%s,false)", (json.dumps(ring),))
        c.execute("SET lock_timeout='5s'; SET statement_timeout='60s'")
    return db

def offline(c):
    c.execute("SELECT pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid='location_storage_policy'::regclass),'USAGE')")
    if not c.fetchone()[0]: raise ValueError('maintenance must own the GPS schema')
    c.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")
    if c.fetchone()[0]: raise ValueError('stop ALL API/worker/other GPS database sessions first')
    c.execute("""SELECT j.job_id FROM timescaledb_information.jobs j
      LEFT JOIN timescaledb_information.job_stats s USING(job_id)
      WHERE j.proc_name='policy_retention' AND j.hypertable_schema='public'
      AND j.hypertable_name IN ('location_records','location_1min','location_5min','location_1hour')
      AND (j.scheduled OR s.job_status='Running')""")
    if c.fetchall(): raise ValueError('pause legacy Timescale retention jobs and wait for running jobs before transition')

def files(uploads, private):
    roots=[('uploads',pathlib.Path(uploads),['device_documents','fleet_documents']),('private',pathlib.Path(private),['car-images'])]
    result=[]
    for role,root,subdirs in roots:
        if not root.is_absolute() or not root.is_dir() or root.is_symlink() or root.resolve()!=root: raise ValueError('existing canonical, absolute non-symlink root required')
        for subdir in subdirs:
            directory=root/subdir
            if directory.is_symlink(): raise ValueError('symlink in upload tree')
            if not directory.exists(): continue
            for base,dirs,names in os.walk(directory,followlinks=False):
                for name in dirs+names:
                    p=pathlib.Path(base)/name; m=p.lstat()
                    if stat.S_ISLNK(m.st_mode): raise ValueError('symlink in upload tree')
                    if stat.S_ISDIR(m.st_mode): continue
                    if not stat.S_ISREG(m.st_mode) or m.st_nlink!=1 or m.st_size>LIMIT*2+65536: raise ValueError('unsafe upload entry')
                    if name.startswith('.crypto20b-'): raise ValueError('unfinished ciphertext staging file: review before retry')
                    context=json.dumps(['gps-file-v1',role,list(p.relative_to(root).parts)],ensure_ascii=False,separators=(',',':'))
                    result.append((p,context))
    return result

def open_bytes(c, context, stored):
    if stored.startswith(MAGIC):
        envelope=json.loads(stored[len(MAGIC):])
        c.execute('SELECT gps_open_cell(%s::jsonb,%s)',(json.dumps(envelope),context))
        raw=base64.b64decode(c.fetchone()[0],validate=True)
    else: raw=stored
    if len(raw)>LIMIT: raise ValueError('oversize plaintext')
    return raw

def convert_files(db,uploads,private,ring,apply=False):
    report={'files':0,'converted':0,'plaintext_files':0,'bytes':0,'content_hashes':[]}
    with db.cursor() as c:
        if apply:
            offline(c)
            c.execute('SELECT maintenance AND enabled FROM location_storage_policy WHERE singleton')
            if not c.fetchone()[0]: raise ValueError('enabled encryption and maintenance fence required')
        for path,ctx in files(uploads,private):
            owner=path.stat()
            stored=path.read_bytes();raw=open_bytes(c,ctx,stored)
            sealed=stored.startswith(MAGIC)
            if apply and (not sealed or json.loads(stored[len(MAGIC):])['kid']!=ring['active']):
                c.execute('SELECT gps_seal_cell(to_jsonb(%s::text),%s)',(base64.b64encode(raw).decode(),ctx))
                encoded=MAGIC+json.dumps(c.fetchone()[0],separators=(',',':')).encode()
                if open_bytes(c,ctx,encoded)!=raw: raise ValueError('file roundtrip failed')
                stage=path.with_name('.crypto20b-'+os.urandom(12).hex())
                fd=os.open(stage,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
                try:
                    with os.fdopen(fd,'wb') as f:
                        # Maintenance can run as root while files belong to the
                        # API account. Atomic replacement must preserve access.
                        current=os.fstat(f.fileno())
                        if (current.st_uid,current.st_gid)!=(owner.st_uid,owner.st_gid):
                            os.fchown(f.fileno(),owner.st_uid,owner.st_gid)
                        f.write(encoded);f.flush();os.fsync(f.fileno())
                    os.replace(stage,path)
                    parent=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
                    try:os.fsync(parent)
                    finally:os.close(parent)
                finally:stage.unlink(missing_ok=True)
                sealed=True;report['converted']+=1
            report['files']+=1;report['bytes']+=len(raw)
            report['plaintext_files']+=int(not sealed)
            report['content_hashes'].append(hashlib.sha256(raw).hexdigest())
    return report

def run(dsn,ring,uploads,private,mode):
    db=connect(dsn,ring)
    try:
        with db.cursor() as c:
            c.execute('SELECT pg_try_advisory_lock(2042020)')
            if not c.fetchone()[0]: raise ValueError('another transition is running')
            if mode in ('fence','convert','resume'):
                offline(c)
                if mode=='fence':c.execute('UPDATE location_storage_policy SET maintenance=true WHERE singleton')
        if mode=='convert':
            # Keep the coordinator advisory lock while batch transactions use another connection.
            database=convert_database(dsn,ring,True,True,batch=100)
            file_report=convert_files(db,uploads,private,ring,True)
        else:
            file_report=convert_files(db,uploads,private,ring)
            database=convert_database(dsn,ring)
        ready=database['enabled'] and all(t['plaintext_rows']==0 for t in database['tables'].values()) and file_report['plaintext_files']==0
        if mode=='resume':
            if not ready: raise ValueError('plaintext or decrypt failures remain; do not resume')
            with db.cursor() as c:
                offline(c)
                c.execute('UPDATE location_storage_policy SET maintenance=false WHERE singleton')
        return {'mode':mode,'ready_to_start_key_configured_api':ready,'database':database,'files':file_report,
                'old_wal_snapshots_backups_erased':False,'production_services_changed':False}
    finally:db.close()

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode',choices=['check','fence','convert','resume'])
    for name in ['dsn-file','keyring-file','uploads','private']:p.add_argument('--'+name,required=True)
    a=p.parse_args()
    print(json.dumps(run(private_json(a.dsn_file)['dsn'],private_json(a.keyring_file),a.uploads,a.private,a.mode),indent=2))
