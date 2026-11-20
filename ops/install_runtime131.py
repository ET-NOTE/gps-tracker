"""Pin a built variant into the labelled synthetic fixture, never production."""
import hashlib
import json
import shutil
import sys
import rehearse_runtime131 as r

r.base.guard();label=sys.argv[1]
assert label in ('baseline','candidate','candidate-r1')
info=json.loads(r.call('docker','inspect',r.HOST).stdout)[0]
assert info['Config']['Labels'].get('gps.runtime131')=='synthetic'
binary=r.JOB/'out/gps-tracker-api131';digest=r.sha(binary)
saved=r.JOB/('gps-tracker-api131-'+label)
assert not saved.exists(),'A variant is immutable'
shutil.copy2(binary,saved)
(r.JOB/('source131-'+label+'.json')).write_text(json.dumps({
    p.relative_to(r.JOB/'src').as_posix():r.sha(p) for p in (r.JOB/'src/gps-tracker-api').rglob('*') if p.is_file()},indent=2))
shutil.copy2(r.JOB/'out/build-api.log',r.JOB/'out'/('build131-'+label+'.log'))
r.base.inside('systemctl','stop','gps121-api')
r.call('docker','cp',str(saved),r.HOST+':/opt/gps121/out/gps-tracker-api')
r.base.inside('chown','root:root','/opt/gps121/out/gps-tracker-api')
r.base.inside('chmod','0555','/opt/gps121/out/gps-tracker-api')
r.base.write('/opt/gps121/active131.json',json.dumps(dict(sha=digest,release='runtime131-20261115-r1',variant=label)))
r.base.write('/opt/gps121/candidate124.sha256',digest)
for name in ('load_runtime131.py','run_runtime131.py','audit_runtime131.py','profile_ingest131.py','test_ingest131.py','verify_endpoints131.py','verify_download131.py'):
    r.call('docker','cp',str(r.JOB/'src/ops'/name),r.HOST+':/opt/gps121/'+name)
r.call('docker','cp',str(r.JOB/'out/gps-read131-tests'),r.HOST+':/opt/gps121/out/gps-read131-tests')
(r.JOB/'out'/('installed131-'+label+'.json')).write_text(json.dumps(dict(api_sha256=digest,
    variant=label,production_modified=False,source_hashes=r.JOB.joinpath('source131-'+label+'.json').name),indent=2))
print('PASS131 installed immutable',label,digest,flush=True)
