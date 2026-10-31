"""Read-only GPS capacity/retention inventory. This tool never deletes or rotates files.

Run with sufficient read permission: python3 audit_gps_storage.py /path/to/prod.env
Output contains sizes, paths and policies only; no credentials or telemetry.
"""
import datetime as dt
import json
import pathlib
import shutil
import subprocess
import sys
import time
import psycopg2

GIB = 1024 ** 3
ROOT = pathlib.Path('/home/mmm')


def allocated(path):
    if not path.exists():
        return None
    return int(subprocess.check_output(['du', '-s', '-B1', '-x', str(path)], timeout=60).split()[0])


def main(env):
    config = {k: v.strip().strip('"').strip("'") for k, v in
              (s.split('=', 1) for s in env.read_text().splitlines()
               if '=' in s and not s.startswith('#'))}
    disk = shutil.disk_usage(ROOT)
    web = (ROOT/'gps-tracker-web/dist-root').resolve(strict=True)
    previous_file = web.parent/'previous-web.txt'
    protected = [str(web.parent)]
    if previous_file.exists():
        protected.append(str(pathlib.Path(previous_file.read_text().strip()).parent))
    backups=[]
    for folder in sorted((ROOT/'backups').iterdir()):
        if not folder.is_dir() or folder.is_symlink():
            continue
        for p in folder.glob('*.dump'):
            backups.append({'path':str(p),'bytes':p.stat().st_size,
                            'age_hours':round((time.time()-p.stat().st_mtime)/3600,1),
                            'offsite_receipt_present':(folder/'offsite-verified.json').is_file()})
    releases=[]
    for folder in sorted((ROOT/'releases').iterdir()):
        if folder.is_dir() and not folder.is_symlink():
            releases.append({'path':str(folder),'bytes':allocated(folder),
                             'protected':str(folder) in protected,
                             'age_days':round((time.time()-folder.stat().st_mtime)/86400,1)})
    with psycopg2.connect(config['DATABASE_URL']) as db:
        db.set_session(readonly=True, autocommit=True)
        q=db.cursor();q.execute("SET statement_timeout='10s'")
        q.execute('SELECT current_database(),pg_database_size(current_database())')
        name, db_bytes=q.fetchone()
        q.execute("SELECT datname,pg_database_size(oid) FROM pg_database WHERE datallowconn AND has_database_privilege(oid,'CONNECT') ORDER BY pg_database_size(oid) DESC")
        databases=[{'name':n,'bytes':size} for n,size in q.fetchall()]
        q.execute("SELECT proc_name,hypertable_name,schedule_interval::text,config FROM timescaledb_information.jobs WHERE proc_name IN ('policy_retention','policy_compression') ORDER BY job_id")
        policies=[{'name':n,'table':t,'interval':i,'drop_after':c.get('drop_after'),'compress_after':c.get('compress_after')} for n,t,i,c in q.fetchall()]
    report={'captured_at':dt.datetime.now(dt.timezone.utc).isoformat(),
            'mode':'read_only_no_deletion',
            'disk':{'total_bytes':disk.total,'free_bytes':disk.free,
                    'status':'critical' if disk.free<2*GIB else 'warning' if disk.free<5*GIB else 'ok',
                    'deploy_minimum_bytes':GIB,'warning_below_bytes':5*GIB,'critical_below_bytes':2*GIB},
            'directories':{str(p):allocated(p) for p in (ROOT/'releases',ROOT/'backups',ROOT/'gps-artifacts',pathlib.Path('/var/lib/postgresql'),pathlib.Path('/var/log/journal'))},
            'production_database':{'name':name,'bytes':db_bytes,'policies':policies},
            'accessible_cluster_databases':databases,'protected_releases':protected,
            'releases':releases,'database_backups':backups,
            'automatic_deletion_enabled_by_this_tool':False}
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__=='__main__':
    main(pathlib.Path(sys.argv[1]))
