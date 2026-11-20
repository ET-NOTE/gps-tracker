import hashlib,json,pathlib,shutil,subprocess,time
from benchmark_location111 import JOB,DB,NET,OUT,connect,info
assert pathlib.Path(__file__).resolve().parent==JOB
assert info('network',NET)['Internal']
assert {c['Name'] for c in info('network',NET)['Containers'].values()}=={DB}
PY='/home/etcom-hub/build/gps-location-erasure-20261105/venv/bin/python'
def run(*args,log=None):
 if log:
  with (OUT/log).open('w') as f: subprocess.run(args,check=True,stdout=f,stderr=subprocess.STDOUT)
 else: subprocess.run(args,check=True)
with connect() as db:
 assert db.execute('SHOW max_connections').fetchone()[0]=='50'
 with db.transaction():
  db.execute('DROP FUNCTION location_page_sample_keys(bigint,bigint,timestamptz,timestamptz,text,boolean,timestamptz,text,integer)')
  db.execute('DELETE FROM _sqlx_migrations WHERE version=111')
candidate=OUT/'gps-tracker-api'
saved=OUT/'gps-tracker-api.final111'
shutil.copy2(candidate,saved)
baseline=pathlib.Path('/home/etcom-hub/build/gps-provision22-20261111query110/out/gps-tracker-api')
assert hashlib.sha256(baseline.read_bytes()).hexdigest()=='4fa945a268facc48c355ddfb53367bf0b34ba76db893dde0511aff4df619c89d'
shutil.copy2(baseline,candidate)
try:
 run(PY,'load_location111.py','start')
 run(PY,'load_location111.py','load','--workers','8','--iterations','25',log='baseline110-http8.log')
 shutil.copy2(OUT/'load111-8.json',OUT/'baseline110-http8.json')
finally:
 run('docker','stop','gps-query111-api');run('docker','rm','gps-query111-api')
 shutil.copy2(saved,candidate)
 run(PY,'stop_retired_connections.py',log='retired-before-final-load.log')
 with connect() as db:
  migration=JOB/'src/gps-tracker-api/migrations/0111_location_page_windows.sql'
  with db.transaction():
   db.execute(migration.read_text())
   db.execute("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(111,'location page windows',true,%s,0)",(hashlib.sha384(migration.read_bytes()).digest(),))
run(PY,'load_location111.py','start')
run(PY,'verify_page111_http.py','current',log='http-pages111-final.log')
run(PY,'load_location111.py','load','--workers','8','--iterations','25',log='load111-8.log')
run(PY,'load_location111.py','load','--workers','16','--iterations','50',log='load111-16.log')
for name in ['baseline110-http8.json','load111-8.json','load111-16.json']:
 d=json.loads((OUT/name).read_text()); print(name,d['requests'],d['errors'],{k:round(v['p95_s'],4) for k,v in d['http'].items()},flush=True)
