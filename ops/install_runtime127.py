"""Install the built114 candidate only into the labeled synthetic container."""
import hashlib
import json
import rehearse_runtime127 as r

r.base.guard()
info=json.loads(r.call('docker','inspect',r.HOST).stdout)[0]
assert info['Config']['Labels'].get('gps.runtime127')=='synthetic'
r.base.inside('systemctl','stop','gps121-api')
binary=r.JOB/'out/gps-tracker-api127'
digest=hashlib.sha256(binary.read_bytes()).hexdigest()
assert digest==json.loads((r.JOB/'out/build127.json').read_text())['api_sha256']
r.call('docker','cp',str(binary),r.HOST+':/opt/gps121/out/gps-tracker-api')
r.base.inside('chmod','0755','/opt/gps121/out/gps-tracker-api')
r.base.write('/opt/gps121/candidate124.sha256',digest)
names=['admin_db_roles.py','location_storage.py','location_query_bounds.py','location_query_statistics.py',
       'crypto20b_transition.py','migrate_runtime127.py','verify_query127.py','perf_runtime127.py']
for name in names:r.call('docker','cp',str(r.JOB/'src/ops'/name),r.HOST+':/opt/gps121/'+name)
r.call('docker','cp',str(r.JOB/'src/gps-tracker-api/migrations/0114_location_single_scan.sql'),
    r.HOST+':/opt/gps121/src/gps-tracker-api/migrations/')
source=(r.JOB/'src/ops/regress_runtime126.py').read_text()
source=source.replace("row['schema']==113","row['schema']==114").replace("'final-state126'","'final-state127'")
source=source.replace("performance_accepted=False", "performance_accepted=True")
source=source.replace("open_issue='compressed monthly history uses more than protected256MiB sort space; shared capacity not accepted'",
    "scope='synthetic127; production shared capacity and cumulative deployment gates remain separate'")
source=source.replace("v.load.save('final-state127'", "assert all(json.loads((ROOT/('out/sustained127-'+phase+'.json')).read_text())['queries_accepted'] for phase in ('compressed','uncompressed'))\nv.load.save('final-state127'")
source=source.replace("print('PASS126 rights/PDF, day-range TLS cancel/429, foreign404; plaintext/temp/idle0; performance remains open'",
    "print('PASS127 rights/PDF, day-range TLS cancel/429, foreign404; plaintext/temp/idle0; synthetic monthly acceptance passed'")
r.base.write('/opt/gps121/regress_runtime127.py',source)
stats=(r.JOB/'src/ops/test_statistics126.py').read_text().replace('VALUES(114,true)','VALUES(115,true)').replace('unreviewed114','unreviewed115')
stats=stats.replace('v.stop_api()\nresults=[]',"v.stop_api()\nv.transition(dsn,ring,str(v.ROOT/'test-storage/uploads'),str(v.ROOT/'test-storage/private'),'fence')\nresults=[]")
r.base.write('/opt/gps121/test_statistics127.py',stats)
(r.JOB/'out/installed127.json').write_text(json.dumps(dict(api_sha256=digest,
    source_sha256={n:hashlib.sha256((r.JOB/'src/ops'/n).read_bytes()).hexdigest() for n in names},
    adapters={'regress_runtime127.py':hashlib.sha256(source.encode()).hexdigest(),
              'test_statistics127.py':hashlib.sha256(stats.encode()).hexdigest()}),indent=2))
print('PASS127 installed candidate in isolated fixture',digest,flush=True)
