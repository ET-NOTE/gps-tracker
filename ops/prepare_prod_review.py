"""Run as root on seriallog. Read-only production backup; restore only a named review DB.

Timescale 2.19.3 cannot restore compressed all-NULL columns (#8893). A consistent
logical hypertable CSV accompanies the schema/catalog dump. Both are REQUIRED.
No production decompression, extension upgrade, or database writes are performed.
"""
import gzip
import argparse
import re
import json
import os
import pathlib
import shutil
import subprocess
import urllib.parse
import psycopg2

os.umask(0o077)
parser = argparse.ArgumentParser()
parser.add_argument('--backup-dir', default='/home/mmm/backups/gps-app-fcm-20260927')
parser.add_argument('--clone', default='gps_tracker_dev_prodreview_20260927')
args = parser.parse_args()
backup = pathlib.Path(args.backup_dir).resolve()
assert backup.parent == pathlib.Path('/home/mmm/backups') and backup.is_dir()
clone = args.clone
assert re.fullmatch(r'gps_tracker_dev_prodreview_[0-9]{8}',clone)
assert clone.startswith('gps_tracker_dev_prodreview_') and clone != 'gps_tracker'
values = {}
for line in (backup/'prod.env').read_text().splitlines():
    if '=' in line and not line.startswith('#'):
        key, value = line.split('=', 1)
        values[key] = value.strip().strip('"').strip("'")
assert urllib.parse.urlsplit(values['DATABASE_URL']).path == '/gps_tracker'

def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)

def psql(query):
    return subprocess.check_output(['sudo','-u','postgres','psql','-v','ON_ERROR_STOP=1','-At','-d',clone,'-c',query], text=True)

db = psycopg2.connect(values['DATABASE_URL'])
db.set_session(isolation_level='REPEATABLE READ', readonly=True)
cur = db.cursor()
cur.execute("SET TIME ZONE 'UTC'")
cur.execute('SELECT pg_export_snapshot()')
snapshot = cur.fetchone()[0]
cur.execute("SELECT hypertable_schema,hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_schema='public'")
assert cur.fetchall() == [('public','location_records')], 'review new hypertables before backing up'
with (backup/'prod-logical.dump').open('wb') as output, (backup/'dump-logical.log').open('w') as log:
    run(['sudo','-u','postgres','pg_dump','-Fc','--no-owner','--no-acl','--snapshot='+snapshot,
         '--exclude-table-data=_timescaledb_internal.compress_*','gps_tracker'], stdout=output, stderr=log)
with gzip.open(backup/'location_records.csv.gz', 'wb') as output:
    cur.copy_expert('COPY (SELECT * FROM public.location_records) TO STDOUT WITH (FORMAT CSV, HEADER)', output)
digest_sql = "SELECT count(*),md5(string_agg(h,'' ORDER BY h)) FROM (SELECT md5(row_to_json(r)::text) h FROM public.location_records r) q"
cur.execute(digest_sql)
expected = list(cur.fetchone())
cur.execute('SELECT count(*) FROM users'); user_count = cur.fetchone()[0]
db.rollback(); db.close()
(backup/'logical-manifest.json').write_text(json.dumps({'required':['prod-logical.dump','location_records.csv.gz'],
    'location_count_and_digest':expected,'users':user_count,'timescale':'2.19.3'},indent=2))

run(['sudo','-u','postgres','dropdb','--if-exists','--force',clone])
run(['sudo','-u','postgres','createdb','-O','gps_tracker_app',clone])
psql("CREATE EXTENSION timescaledb VERSION '2.19.3'; SELECT timescaledb_pre_restore();")
with (backup/'restore-logical.log').open('w') as log, (backup/'prod-logical.dump').open('rb') as source:
    run(['sudo','-u','postgres','pg_restore','--no-owner','--no-acl','-d',clone], stdin=source,stdout=log,stderr=log)
psql('SELECT timescaledb_post_restore();')
psql('SELECT alter_job(job_id,scheduled=>false) FROM timescaledb_information.jobs;')
psql('TRUNCATE public.location_records;')
with (backup/'copy-logical.log').open('w') as log, gzip.open(backup/'location_records.csv.gz','rb') as source:
    proc = subprocess.Popen(['sudo','-u','postgres','psql','-v','ON_ERROR_STOP=1','-d',clone,
        '-c','COPY public.location_records FROM STDIN WITH (FORMAT CSV, HEADER)'],stdin=subprocess.PIPE,stdout=log,stderr=log)
    shutil.copyfileobj(source,proc.stdin)
    proc.stdin.close()
    assert proc.wait() == 0, 'logical hypertable restore failed'
commands = psql("""SELECT format('ALTER TABLE %I.%I OWNER TO gps_tracker_app;',n.nspname,c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  AND c.relkind IN ('r','p') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.objid=c.oid AND d.deptype='e')""")
psql(commands)
psql('GRANT ALL ON ALL TABLES IN SCHEMA public TO gps_tracker_app; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO gps_tracker_app;')
u = urllib.parse.urlsplit(values['DATABASE_URL'])
values['DATABASE_URL'] = urllib.parse.urlunsplit(u._replace(path='/'+clone))
keep = ['DATABASE_URL','JWT_SECRET','DIAG_DEVICE_ALLOWLIST','DIAG_ALLOW_OWNER_EMAILS','JWT_ACCESS_TTL_MIN','JWT_REFRESH_TTL_DAYS']
env = {k:values[k] for k in keep if k in values}
env.update(APP_ENV='test',BIND_ADDR='127.0.0.1:3042',SMS_DEV_MODE='1',UPLOAD_DIR='/home/mmm/gps-prodreview-uploads',
           FCM_SERVICE_ACCOUNT_PATH='',CORS_ALLOWED_ORIGINS='http://127.0.0.1',RUST_LOG='info')
pathlib.Path(env['UPLOAD_DIR']).mkdir(exist_ok=True)
run(['chown','mmm:mmm',env['UPLOAD_DIR']])
(backup/'validation.env').write_text('\n'.join(k+'='+v for k,v in env.items())+'\n')
db = psycopg2.connect(env['DATABASE_URL']);cur = db.cursor()
cur.execute("SET TIME ZONE 'UTC'");cur.execute(digest_sql)
actual = list(cur.fetchone());assert actual == expected, 'restored rows do not match snapshot'
cur.execute('SELECT count(*) FROM users');assert cur.fetchone()[0] == user_count
db.close()
print(json.dumps({'restored_clone':clone,'location_rows':actual[0],'all_location_row_hashes_match':True,'users':user_count}))
