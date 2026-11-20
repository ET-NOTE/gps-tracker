"""Disposable-only function trial, with unchanged112 migration ledger.

Restores exact function definitions before the real113 migration is applied by
the rebuilt API's migration-only unit. Never a production rollback tool.
"""
import hashlib
from pathlib import Path
import load_runtime122 as l
from profile_runtime124 import profile
from verify_query124 import verify


def run():
    assert l.sql('SELECT max(version) FROM _sqlx_migrations')==[(112,)]
    l.stop_api()
    verify()
    profile('before')
    definitions=l.sql("SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('location_query_records_between','location_speed_metrics_between') ORDER BY p.proname")
    assert len(definitions)==2
    migration=(l.ROOT/'src/gps-tracker-api/migrations/0113_location_device_projection.sql').read_text()
    try:
        db=l.connect();db.autocommit=False
        try:
            with db.cursor() as q:q.execute(migration)
            db.commit()
        finally:db.close()
        profile('after')
    finally:
        db=l.connect();db.autocommit=False
        try:
            with db.cursor() as q:
                for row in definitions:q.execute(row[0])
            db.commit()
        finally:db.close()
    restored=l.sql("SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('location_query_records_between','location_speed_metrics_between') ORDER BY p.proname")
    assert restored==definitions
    assert l.sql('SELECT max(version) FROM _sqlx_migrations')==[(112,)]
    l.save('trial124-restored',dict(schema=112,functions_restored=True,
        definition_sha256=[hashlib.sha256(x[0].encode()).hexdigest() for x in restored]))
    print('PASS trial complete; original112 definitions restored before real migration')


if __name__=='__main__':run()
