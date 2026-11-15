"""Refresh encrypted range-query planner statistics before maintenance ends.

No key or coordinate is read. Only range/identity/fix filter columns are
sampled, including each inherited Timescale chunk and then the parent. Automatic
ANALYZE is asynchronous after pg_restore and is not a serving-readiness gate.
The caller owns the transition advisory lock and must have stopped all writers.
"""
import time
from psycopg import sql


def refresh(db):
    name,version=db.execute('SELECT current_database(),max(version) FROM _sqlx_migrations WHERE success').fetchone()
    if not name.startswith('gps_') or version not in (104,105,106,107,108,109,110,111,112,113):
        raise ValueError('reviewed GPS schema104 through113 required for statistics')
    if db.execute('SELECT maintenance FROM location_storage_policy WHERE singleton').fetchone()!=(True,):
        raise ValueError('statistics refresh requires maintenance fence')
    owned=db.execute("SELECT pg_has_role(current_user,relowner,'USAGE') FROM pg_class WHERE oid='location_storage_policy'::regclass").fetchone()
    if owned!=(True,):raise ValueError('statistics refresh requires maintenance owner')
    if db.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'").fetchone()!=(0,):
        raise ValueError('stop ALL API/worker/other GPS database sessions before statistics')
    rows=db.execute("""WITH RECURSIVE relations(oid,depth) AS (
          SELECT 'public.location_records'::regclass::oid,0
          UNION ALL SELECT i.inhrelid,r.depth+1 FROM relations r JOIN pg_inherits i ON i.inhparent=r.oid
        ) SELECT n.nspname,c.relname,c.oid,pg_has_role(current_user,c.relowner,'USAGE')
          FROM relations r JOIN pg_class c ON c.oid=r.oid JOIN pg_namespace n ON n.oid=c.relnamespace
          ORDER BY r.depth DESC,n.nspname,c.relname""").fetchall()
    if not rows or any(not r[3] for r in rows):
        raise ValueError('statistics owner must own every location relation; no skipped tables')
    fields=['device_id','user_id','recorded_at','source','fix']
    if version>=110:fields+=['query_bounds_ready','query_first_at','query_last_at']
    # No ciphertext/decrypted location values are copied into statistics.
    columns=sql.SQL(',').join(map(sql.Identifier,fields))
    result=[];begin=time.monotonic()
    with db.transaction():
        db.execute("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'")
        for schema,table,oid,_ in rows:
            start=time.monotonic()
            db.execute(sql.SQL('ANALYZE {} ({})').format(sql.Identifier(schema,table),columns))
            result.append(dict(schema=schema,table=table,seconds=round(time.monotonic()-start,6)))
    return dict(completed=True,columns=fields,relations=result,seconds=round(time.monotonic()-begin,6),
        decrypted=False,location_rows_written=0,automatic_statistics_required=False)
