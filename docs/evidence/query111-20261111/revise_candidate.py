import hashlib
from pathlib import Path
from benchmark_location111 import JOB, connect
migration=JOB/'src/gps-tracker-api/migrations/0111_location_page_windows.sql'
with connect() as db,db.transaction():
 assert db.execute('select max(version) from _sqlx_migrations').fetchone()==(111,)
 db.execute('DROP FUNCTION location_page_sample_keys(bigint,bigint,timestamptz,timestamptz,text,boolean,timestamptz,text,integer)')
 db.execute(migration.read_text())
 db.execute('UPDATE _sqlx_migrations SET checksum=%s WHERE version=111',(hashlib.sha384(migration.read_bytes()).digest(),))
print('Synthetic111 candidate revision applied; earlier migrations untouched')
