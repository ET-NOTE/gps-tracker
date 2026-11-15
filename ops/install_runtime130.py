"""Pin a built variant into the labelled synthetic fixture, never production."""
import hashlib
import json
import shutil
import sys
import rehearse_runtime130 as r

r.base.guard();label=sys.argv[1]
assert label in ('baseline','candidate','candidate-r1')
info=json.loads(r.call('docker','inspect',r.HOST).stdout)[0]
assert info['Config']['Labels'].get('gps.runtime130')=='synthetic'
binary=r.JOB/'out/gps-tracker-api130';digest=r.sha(binary)
saved=r.JOB/('gps-tracker-api130-'+label)
assert not saved.exists(),'A variant is immutable'
shutil.copy2(binary,saved)
(r.JOB/('source130-'+label+'.json')).write_text(json.dumps({
    p.relative_to(r.JOB/'src').as_posix():r.sha(p) for p in (r.JOB/'src/gps-tracker-api').rglob('*') if p.is_file()},indent=2))
shutil.copy2(r.JOB/'out/build-api.log',r.JOB/'out'/('build130-'+label+'.log'))
r.base.inside('systemctl','stop','gps121-api')
r.call('docker','cp',str(saved),r.HOST+':/opt/gps121/out/gps-tracker-api')
r.base.inside('chown','root:root','/opt/gps121/out/gps-tracker-api')
r.base.inside('chmod','0555','/opt/gps121/out/gps-tracker-api')
r.base.write('/opt/gps121/active130.json',json.dumps(dict(sha=digest,release='runtime130-20261115-r1',variant=label)))
r.base.write('/opt/gps121/candidate124.sha256',digest)
for name in ('load_runtime130.py','run_runtime130.py','audit_runtime130.py','profile_ingest130.py','test_ingest130.py'):
    r.call('docker','cp',str(r.JOB/'src/ops'/name),r.HOST+':/opt/gps121/'+name)
(r.JOB/'out'/('installed130-'+label+'.json')).write_text(json.dumps(dict(api_sha256=digest,
    variant=label,production_modified=False,source_hashes=r.JOB.joinpath('source130-'+label+'.json').name),indent=2))
print('PASS130 installed immutable',label,digest,flush=True)
