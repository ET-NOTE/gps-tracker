"""GPS schema owner/runtime separation. Never reads or modifies neighboring databases.
Run --check first. --apply requires a dedicated GPS database, privileged maintenance
connection in a mode-600 DSN file, and an unused output path for runtime credentials.
No production address is embedded; this tool is not invoked on production by the tests.
"""
import argparse,json,pathlib,os,secrets,stat
import psycopg2
from psycopg2 import sql

def run(dsn,apply=False,secret_out=None):
 db=psycopg2.connect(dsn);db.autocommit=False
 with db.cursor() as c:
  c.execute('SELECT current_database(),current_user');name,actor=c.fetchone()
  if not name.startswith('gps_'):raise RuntimeError('dedicated gps_ database required')
  c.execute("SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('public','information_schema','timescaledb_experimental','timescaledb_information') AND nspname NOT LIKE 'pg_%' AND nspname NOT LIKE '_timescaledb_%'")
  if c.fetchall():raise RuntimeError('unreviewed schema: stop rather than changing other projects')
  c.execute("SELECT max(version) FROM _sqlx_migrations WHERE success");version=c.fetchone()[0]
  if version not in (102,103,104,105,106,107):raise RuntimeError('reviewed schema 102/103/104/105/106/107 required')
  c.execute("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m')")
  count=c.fetchone()[0]
  report={'database':name,'schema':version,'public_objects':count,'apply':apply,'roles':['gps_schema_owner','gps_runtime']}
  if not apply:db.rollback();return report
  out=pathlib.Path(secret_out)
  # Exclusive creation before touching DB avoids overwriting a working credential.
  fd=os.open(out,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  secret=secrets.token_urlsafe(36)
  commit_attempted=False
  try:
   c.execute("SELECT 1 FROM pg_roles WHERE rolname='gps_runtime'")
   if c.fetchone():raise RuntimeError('runtime role exists; use separate reviewed rotation procedure')
   c.execute("SELECT 1 FROM pg_roles WHERE rolname='gps_schema_owner'")
   if not c.fetchone():c.execute('CREATE ROLE gps_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')
   c.execute("SELECT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) FROM pg_roles r WHERE rolname='gps_schema_owner'")
   if c.fetchone()[0]:raise RuntimeError('existing owner has unreviewed privileges')
   c.execute(sql.SQL('CREATE ROLE gps_runtime LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS').format(sql.Literal(secret)))
   c.execute('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
   c.execute(sql.SQL('REVOKE CREATE,TEMPORARY ON DATABASE {} FROM PUBLIC').format(sql.Identifier(name)))
   # Extension-owned routines stay under the extension administrator.
   c.execute("SELECT c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e') ORDER BY c.relkind,c.relname")
   for obj,kind in c.fetchall():
    typ={'v':'VIEW','m':'MATERIALIZED VIEW'}.get(kind,'TABLE')
    c.execute(sql.SQL('ALTER '+typ+' {} OWNER TO gps_schema_owner').format(sql.Identifier('public',obj)))
   c.execute("SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')")
   routines=[r[0] for r in c.fetchall()]
   for routine in routines:c.execute(sql.SQL('ALTER FUNCTION {} OWNER TO gps_schema_owner').format(sql.SQL(routine)))
   c.execute('GRANT USAGE ON SCHEMA public TO gps_runtime,gps_schema_owner')
   c.execute('GRANT CREATE ON SCHEMA public TO gps_schema_owner')
   c.execute(sql.SQL('GRANT CONNECT ON DATABASE {} TO gps_runtime').format(sql.Identifier(name)))
   c.execute('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO gps_runtime')
   c.execute('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO gps_runtime')
   c.execute('REVOKE ALL ON _sqlx_migrations FROM gps_runtime')
   c.execute('GRANT SELECT ON _sqlx_migrations TO gps_runtime')
   # Evidence is append-only to the serving identity; trigger definitions belong to schema_owner.
   for table in ['admin_security_events','admin_audit_log','location_access_erasure_runs']:
    c.execute(sql.SQL('REVOKE UPDATE,DELETE ON {} FROM gps_runtime').format(sql.Identifier(table)))
   c.execute('REVOKE INSERT ON location_access_erasure_runs FROM gps_runtime')
   if version >= 103:
    c.execute('REVOKE ALL ON location_storage_policy,location_storage_fields FROM gps_runtime')
    c.execute('GRANT SELECT ON location_storage_policy,location_storage_fields TO gps_runtime')
   if version >= 105:
    c.execute('REVOKE ALL ON privacy_retention_policy,privacy_retention_consents,privacy_retention_runs FROM gps_runtime')
    c.execute('GRANT SELECT ON privacy_retention_policy,privacy_retention_consents,privacy_retention_runs TO gps_runtime')
    c.execute('REVOKE UPDATE,DELETE ON privacy_processing_events FROM gps_runtime')
   if version >= 106:
    c.execute('REVOKE ALL ON location_subject_policy FROM gps_runtime')
    c.execute('GRANT SELECT ON location_subject_policy TO gps_runtime')
    c.execute('REVOKE UPDATE,DELETE ON location_subject_actions,location_notice_attempts FROM gps_runtime')
    c.execute('REVOKE DELETE ON location_subject_mappings,location_provision_notices FROM gps_runtime')
   if version >= 107:
    c.execute('REVOKE INSERT,DELETE ON location_notice_worker FROM gps_runtime')
   for routine in routines:
    c.execute(sql.SQL('REVOKE ALL ON FUNCTION {} FROM PUBLIC').format(sql.SQL(routine)))
    c.execute(sql.SQL('GRANT EXECUTE ON FUNCTION {} TO gps_runtime').format(sql.SQL(routine)))
   # Future migrations must explicitly refresh grants; broad default DDL grants are not installed.
   with os.fdopen(fd,'w') as f:
    fd=None
    json.dump({'user':'gps_runtime','password':secret,'database':name},f);f.write('\n');f.flush();os.fsync(f.fileno())
   commit_attempted=True
   db.commit()
  except BaseException:
   db.rollback()
   if fd is not None:os.close(fd)
   if not commit_attempted:out.unlink(missing_ok=True)
   raise
 db.close();return report
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--dsn-file',required=True);p.add_argument('--apply',action='store_true');p.add_argument('--secret-out');a=p.parse_args()
 if a.apply and not a.secret_out:p.error('--secret-out required for apply')
 f=pathlib.Path(a.dsn_file)
 if stat.S_IMODE(f.stat().st_mode)&0o077:raise SystemExit('DSN file must be mode 600')
 print(json.dumps(run(f.read_text().strip(),a.apply,a.secret_out),indent=2))
