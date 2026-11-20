"""Run on Seriallog as an operator with sudo -n postgres access. Never targets prod.

Creates a fresh dev database from the canonical migrations, copies ONLY existing
dev data, and compares every original column. The old database is untouched.
Secrets and row contents must never be printed. API cutover is a separate step.
"""
import hashlib
import pathlib
import subprocess
import sys

OLD = "gps_tracker_dev"
NEW = "gps_tracker_dev_next_20260924"
ROLE = "gps_tracker_dev_app"
MIGRATIONS = pathlib.Path(sys.argv[1])


def sql(db, statement):
    p = subprocess.run(["sudo", "-n", "-u", "postgres", "psql", "-X", "-qAt",
                        "-v", "ON_ERROR_STOP=1", "-d", db],
                       input=statement, text=True, capture_output=True)
    if p.returncode:
        # SQL error output can contain sensitive row values. Keep it local.
        log = pathlib.Path("/home/mmm/gps-dev-reconcile-error.log")
        log.touch(mode=0o600, exist_ok=True)
        log.write_text(p.stderr)
        raise RuntimeError(f"Database operation failed; private log: {log}")
    return p.stdout.strip()


if sql("postgres", f"SELECT 1 FROM pg_database WHERE datname='{NEW}'"):
    raise SystemExit("New database already exists; inspect it before retrying.")
subprocess.run(["sudo", "-n", "-u", "postgres", "createdb", "-O", ROLE, NEW], check=True)
sql(NEW, "CREATE EXTENSION timescaledb; CREATE EXTENSION citext; CREATE EXTENSION btree_gist;")
sql(NEW, f"""SET ROLE {ROLE};
CREATE TABLE _sqlx_migrations (
 version bigint PRIMARY KEY, description text NOT NULL,
 installed_on timestamptz NOT NULL DEFAULT now(), success boolean NOT NULL,
 checksum bytea NOT NULL, execution_time bigint NOT NULL);
""")
for path in sorted(MIGRATIONS.glob("*.sql")):
    version, description = path.stem.split("_", 1)
    raw = path.read_bytes()
    checksum = hashlib.sha384(raw).hexdigest()
    description = description.replace("_", " ").replace("'", "''")
    sql(NEW, f"BEGIN; SET LOCAL ROLE {ROLE};\n" + raw.decode() +
        f"\nINSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) "
        f"VALUES({int(version)},'{description}',true,decode('{checksum}','hex'),0); COMMIT;")
    print(f"migration {int(version)} applied", flush=True)

# Preserve all history. No retention job is allowed to delete data during validation.
sql(NEW, "SELECT alter_job(job_id,scheduled=>false) FROM timescaledb_information.jobs WHERE proc_name='policy_retention';")
dump = subprocess.run(["sudo", "-n", "-u", "postgres", "pg_dump", "--data-only",
                       "--column-inserts", "--rows-per-insert=500", "--no-owner", "--no-acl",
                       "--exclude-table=public._sqlx_migrations", OLD],
                      text=True, capture_output=True, check=True)
sql(NEW, f"BEGIN; SET LOCAL ROLE {ROLE};\n" + dump.stdout + "\nCOMMIT;")

tables = sql(OLD, "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_sqlx_migrations' ORDER BY 1").splitlines()
for table in tables:
    cols = sql(OLD, f"SELECT string_agg(quote_ident(column_name),',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='{table}'")
    query = f"SELECT count(*) || ':' || md5(COALESCE(string_agg(h,'' ORDER BY h),'')) FROM (SELECT md5(row({cols})::text) h FROM public.{table}) rows;"
    if sql(OLD, query) != sql(NEW, query):
        raise RuntimeError(f"Copy verification failed for {table}; old DB is still active")
    print(f"verified {table}", flush=True)
sql(NEW, """INSERT INTO stats_rebuild_queue(device_id,date)
SELECT device_id,date FROM daily_stats UNION
SELECT device_id,(recorded_at AT TIME ZONE 'Asia/Seoul')::date FROM location_points
ON CONFLICT DO NOTHING; ANALYZE;""")
print("All dev tables verified. Ready for dev-only API validation and cutover.")
