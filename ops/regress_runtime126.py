"""After-performance rights/PDF, TLS cancel/admission and encrypted final checks."""
import hashlib
import json
import subprocess
import time
import psycopg
import verify_runtime126 as v
from runtime121_control import DSN,ROOT,drain

ctx=json.loads(v.CONTEXT.read_text());v.stop_api()
# Reuse the full121/125 native business suite against its original fixture DB.
v.transition(DSN,ctx['ring'],str(ROOT/'test-storage/uploads'),str(ROOT/'test-storage/private'),'resume')
subprocess.run(['python3',str(ROOT/'verify_runtime121.py')],check=True)
cred=json.loads((ROOT/'test-runtime.json').read_text())
runtime=DSN.replace('postgres:closure-test-only',cred['user']+':'+cred['password'])
env=dict(RUNTIME_DSN=runtime,STORAGE='pilot')
v.boot_settled(env)
subprocess.run(['systemctl','stop','gps122-proxy'],check=False,capture_output=True);v.load.tls()
for _ in range(50):
    try:
        if v.load.Client().get('/gps-tracker/health')[0]==200:break
    except OSError:pass
    time.sleep(.1)
else:raise AssertionError('TLS proxy not ready')
with psycopg.connect(DSN,autocommit=True) as db:
    did,uid=db.execute("SELECT id,owner_id FROM devices WHERE device_uid='cumulative119-sim'").fetchone()
    foreign=db.execute('SELECT id FROM users WHERE id<>%s LIMIT 1',(uid,)).fetchone()[0]
v.load.b.fixture=lambda:dict(devices=[dict(device_id=did,user_id=uid)])
# Admission tests intentionally lock the data and cancel requests. They use the
# same reviewed day range as125; full-month performance is separately measured.
original=v.load.b.routes
day='since=2026-10-02T00:00:00Z&until=2026-10-03T00:00:00Z'
v.load.b.routes=lambda d:[(name,path.replace(v.load.b.MONTH,day)) for name,path in original(d)]
import verify_runtime124 as verify
verify.select=lambda:v.boot_settled(env)
verify.fairness()
assert v.load.Client().get(v.load.b.routes(did)[2][1],foreign)[0]==404
v.stop_api();drain()
states=[]
for dsn in (DSN,ctx['dsn']):
    with psycopg.connect(dsn,autocommit=True) as db:
        row=dict(database=db.execute('SELECT current_database()').fetchone()[0],
            schema=db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone()[0],
            plaintext_locations=db.execute('SELECT count(*) FROM location_records WHERE lat IS NOT NULL OR lng IS NOT NULL OR fixes_jsonb IS NOT NULL').fetchone()[0],
            idle_transactions=db.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'").fetchone()[0],
            images=db.execute('SELECT count(*) FROM privacy_image_payloads').fetchone()[0],
            pending_cleanup=db.execute("SELECT count(*) FROM privacy_file_cleanup WHERE state IN ('pending','retry')").fetchone()[0])
        assert row['schema']==113 and all(row[k]==0 for k in ('plaintext_locations','idle_transactions','images','pending_cleanup')),row
        states.append(row)
v.load.save('final-state126',dict(databases=states,foreign_denied=404,api_sha256=v.load.b.SHA,
    production_modified=False,external_messages=0,activation_ready=False,performance_accepted=False,
    open_issue='compressed monthly history uses more than protected256MiB sort space; shared capacity not accepted'))
print('PASS126 rights/PDF, day-range TLS cancel/429, foreign404; plaintext/temp/idle0; performance remains open',flush=True)
