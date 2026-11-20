"""Actual113->114 migration, transactional fault, ciphertext and role guards."""
import hashlib
import json
import psycopg
import verify_runtime126 as v
from runtime121_control import DSN,migrate,job

ctx=json.loads(v.CONTEXT.read_text());v.stop_api()
source=(v.ROOT/'src/gps-tracker-api/migrations/0114_location_single_scan.sql').read_bytes()
oracle=json.loads((v.ROOT/'out/oracle113-functions.json').read_text());proof=[]


def fingerprint(db):
    return db.execute("SELECT count(*),md5(string_agg(md5(to_jsonb(r)::text),'' ORDER BY recorded_at,source)) FROM location_records r").fetchone()


for dsn in (DSN,ctx['dsn']):
    with psycopg.connect(dsn,autocommit=True) as db:
        # Undo the explicitly unregistered prototype in the disposable clone.
        for definition in oracle.values():db.execute(definition)
        assert db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone()==(113,)
        before=fingerprint(db)
        functions=db.execute("SELECT md5(string_agg(pg_get_functiondef(oid),'' ORDER BY oid)) FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind='f'").fetchone()
        try:
            with db.transaction():
                db.execute(source.decode())
                raise RuntimeError('injected114 rollback')
        except RuntimeError as exc:assert str(exc)=='injected114 rollback'
        assert db.execute("SELECT md5(string_agg(pg_get_functiondef(oid),'' ORDER BY oid)) FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind='f'").fetchone()==functions
        assert fingerprint(db)==before
        db.execute('GRANT gps_schema_owner TO gps_migration')
        assert db.execute("SELECT rolsuper FROM pg_roles WHERE rolname='gps_migration'").fetchone()==(False,)
    owner=dsn.replace('postgres:closure-test-only','gps_migration:synthetic-migration-only')
    migrate('migration127-'+dsn.rsplit('/',1)[1],owner)
    with psycopg.connect(dsn,autocommit=True) as db:
        assert db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone()==(114,)
        assert bytes(db.execute('SELECT checksum FROM _sqlx_migrations WHERE version=114').fetchone()[0])==hashlib.sha384(source).digest()
        assert fingerprint(db)==before
        assert db.execute("SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proowner=(SELECT oid FROM pg_roles WHERE rolname='gps_runtime')").fetchone()==(0,)
        proof.append(dict(database=dsn.rsplit('/',1)[1],schema=114,rows=before[0],ciphertext_hash=before[1],
            migration_superuser=False,injected_transaction_rolled_back=True,physical_rows_unchanged=True))
v.load.save('migration127',dict(databases=proof,api_sha256=v.load.b.SHA,source_sha256=hashlib.sha256(source).hexdigest()))
v.transition(ctx['dsn'],ctx['ring'],str(v.ROOT/'test-storage/uploads'),str(v.ROOT/'test-storage/private'),'fence')
v.transition(ctx['dsn'],ctx['ring'],str(v.ROOT/'test-storage/uploads'),str(v.ROOT/'test-storage/private'),'resume')
print('PASS127 actual non-superuser113->114, rollback, ciphertext hashes and runtime role separation',flush=True)
