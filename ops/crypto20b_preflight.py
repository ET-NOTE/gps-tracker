"""Read-only, content-free GPS encryption inventory. No activation or restart.

Run on the GPS server with its private environment file. Prints aggregate sizes,
schema and hashes only, never the DSN, file names, contents or keys.
"""
import argparse, datetime, hashlib, json, os, pathlib, shutil, stat
import psycopg2
from privacy_file_cleanup import config


def run(env_file, binary):
    cfg=config(env_file)
    db=psycopg2.connect(cfg['DATABASE_URL'])
    result={'read_only':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    try:
        db.set_session(readonly=True)
        with db.cursor() as c:
            c.execute("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='2s'")
            c.execute('SELECT current_database(),max(version) FROM _sqlx_migrations WHERE success')
            name,version=c.fetchone()
            if not name.startswith('gps_'): raise ValueError('GPS database required')
            result['schema']=version
            c.execute('SELECT pg_database_size(current_database())')
            result['database_bytes']=c.fetchone()[0]
            c.execute("SELECT relname,n_live_tup,pg_total_relation_size(relid) FROM pg_stat_user_tables WHERE schemaname='public' ORDER BY relname")
            result['tables']=[dict(zip(['table','estimated_rows','relation_bytes'],r)) for r in c.fetchall()]
            c.execute("SELECT sum(total_bytes) FROM hypertable_detailed_size('location_records')")
            result['location_hypertable_bytes']=int(c.fetchone()[0] or 0)
            c.execute("SELECT current_setting('log_parameter_max_length'),current_setting('log_parameter_max_length_on_error'),coalesce(current_setting('pgaudit.log_parameter',true),'off')")
            result['bind_logging']=list(c.fetchone())
            c.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")
            result['other_gps_connections']=c.fetchone()[0]
            c.execute("""SELECT j.job_id,j.hypertable_name,j.scheduled,j.config,s.job_status
              FROM timescaledb_information.jobs j LEFT JOIN timescaledb_information.job_stats s USING(job_id)
              WHERE j.proc_name='policy_retention' AND j.hypertable_schema='public'""")
            result['legacy_retention_jobs']=[dict(zip(['job_id','table','scheduled','config','status'],r)) for r in c.fetchall()]
    finally:db.close()
    uploads=pathlib.Path(cfg.get('UPLOAD_DIR','/home/mmm/uploads'))
    private=pathlib.Path(cfg.get('PRIVATE_UPLOAD_DIR',str(uploads.with_name('gps-private-uploads'))))
    totals={'files':0,'bytes':0,'largest_bytes':0,'unsafe_entries':0,'over_10mib':0}
    for root,subdirs in [(uploads,['device_documents','fleet_documents']),(private,['car-images'])]:
        if root.is_symlink(): totals['unsafe_entries']+=1;continue
        for subdir in subdirs:
            directory=root/subdir
            if directory.is_symlink():totals['unsafe_entries']+=1;continue
            for base,dirs,names in os.walk(directory,followlinks=False):
                for item in dirs+names:
                    m=(pathlib.Path(base)/item).lstat()
                    if stat.S_ISLNK(m.st_mode):totals['unsafe_entries']+=1
                    elif stat.S_ISDIR(m.st_mode):continue
                    elif not stat.S_ISREG(m.st_mode) or m.st_nlink!=1:totals['unsafe_entries']+=1
                    else:
                        totals['files']+=1;totals['bytes']+=m.st_size
                        totals['largest_bytes']=max(totals['largest_bytes'],m.st_size)
                        totals['over_10mib']+=int(m.st_size>10*1024*1024)
    result['uploads']=totals
    result['filesystem_free_bytes']=shutil.disk_usage(binary).free
    result['api_sha256']=hashlib.sha256(pathlib.Path(binary).read_bytes()).hexdigest()
    result['approval_to_activate']=False
    return result


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--env-file',required=True);p.add_argument('--binary',required=True)
    a=p.parse_args();print(json.dumps(run(a.env_file,a.binary),indent=2))
