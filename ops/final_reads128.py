"""After recovery/fault/reboot suites: actual TLS monthly reads and cancellations."""
import hashlib
import json
import subprocess
import time
import psycopg
import verify_runtime126 as v
from runtime121_control import ROOT,DSN,drain

ctx=json.loads(v.CONTEXT.read_text());v.stop_api()
cred=json.loads((ROOT/'test-runtime.json').read_text())
runtime=DSN.replace('postgres:closure-test-only',cred['user']+':'+cred['password'])
v.transition(DSN,ctx['ring'],str(ROOT/'test-storage/uploads'),str(ROOT/'test-storage/private'),'resume')
env=dict(RUNTIME_DSN=runtime,STORAGE='pilot');v.boot_settled(env)
subprocess.run(['systemctl','stop','gps122-proxy'],check=False,capture_output=True);v.load.tls()
for _ in range(50):
    try:
        if v.load.Client().get('/gps-tracker/health')[0]==200:break
    except OSError:pass
    time.sleep(.1)
else:raise AssertionError('TLS proxy not ready')
expected=json.loads((ROOT/'out/restored128.json').read_text())['expected'];rows=[]
for name,path in v.load.b.routes(ctx['did'])[:3]:
    status,body,_,seconds=v.load.Client().get(path,ctx['uid'])
    assert status==200 and hashlib.sha256(body).hexdigest()==expected[name]
    rows.append(dict(route=name,status=status,seconds=seconds,sha256=hashlib.sha256(body).hexdigest()))
v.load.b.fixture=lambda:dict(devices=[dict(device_id=ctx['did'],user_id=ctx['uid'])])
original=v.load.b.routes;day='since=2026-10-02T00:00:00Z&until=2026-10-03T00:00:00Z'
v.load.b.routes=lambda d:[(name,path.replace(v.load.b.MONTH,day)) for name,path in original(d)]
import verify_runtime124 as verify
verify.select=lambda:v.boot_settled(env)
verify.fairness()
with psycopg.connect(DSN,autocommit=True) as db:
    foreign=db.execute('SELECT id FROM users WHERE id<>%s LIMIT 1',(ctx['uid'],)).fetchone()[0]
assert v.load.Client().get(v.load.b.routes(ctx['did'])[2][1],foreign)[0]==404
v.stop_api();drain();states=[]
for target in (DSN,ctx['dsn']):
    with psycopg.connect(target,autocommit=True) as db:
        state=dict(database=db.execute('SELECT current_database()').fetchone()[0],schema=db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone()[0],
            plaintext=db.execute('SELECT count(*) FROM location_records WHERE lat IS NOT NULL OR lng IS NOT NULL OR raw IS NOT NULL OR fixes_jsonb IS NOT NULL').fetchone()[0],
            pending_bounds=db.execute('SELECT count(*) FROM location_records WHERE NOT query_bounds_ready').fetchone()[0],
            images=db.execute('SELECT count(*) FROM privacy_image_payloads').fetchone()[0],
            cleanup=db.execute("SELECT count(*) FROM privacy_file_cleanup WHERE state IN ('pending','retry')").fetchone()[0],
            active=db.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND (state='idle in transaction' OR application_name LIKE 'gps-read-%')").fetchone()[0])
        assert state['schema']==114 and all(state[k]==0 for k in ('plaintext','pending_bounds','images','cleanup','active')),state
        states.append(state)
assert json.loads((ROOT/'out/sustained128-compressed.json').read_text())['queries_accepted']
v.load.save('final-state128',dict(databases=states,monthly_reads=rows,api_sha256=v.load.b.SHA,
    tls='verified synthetic localhost TLS1.2',foreign_denied=404,production_modified=False,external_messages=0,activation_ready=False))
print('PASS128 final post-recovery TLS monthly hashes, cancel/429 and foreign404; plaintext/bounds/temp/idle0',flush=True)
