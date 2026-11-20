"""Execute only synthetic round120 systemd fixtures on the build host."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
import rehearse_runtime120 as r


def guard():
    assert r.call('hostname').stdout.strip()=='etcom-hub'
    assert r.inspect('network',r.NET)['Internal']
    for name in (r.HOST,r.DB):assert r.inspect('container',name)['Config']['Labels']['gps.runtime120']=='synthetic'


def service():
    guard();r.write('/etc/runtime120-test-only','synthetic')
    r.inside('systemctl','stop','gps-pdf-render.socket')
    r.call('docker','cp',str(r.OUT/'gps-pdf-render'),r.HOST+':/opt/gps-pdf-render')
    r.inside('systemctl','restart','gps-pdf-render-selftest.service')
    r.inside('systemctl','start','gps-pdf-render.socket')
    r.call('docker','cp',str(r.JOB/'src/ops/test_runtime120_service.py'),r.HOST+':/opt/test_runtime120_service.py')
    result=r.inside('python3','/opt/test_runtime120_service.py',check=False,timeout=120)
    (r.OUT/'service.log').write_text(result.stdout+result.stderr)
    print(result.stdout+result.stderr,flush=True)
    if result.returncode:raise RuntimeError('service fixture failed')
    (r.OUT/'service-results.json').write_text(r.inside('cat','/tmp/runtime120-service-results.json').stdout)


def business():
    guard()
    source=(r.JOB/'src/ops/test_privacy_receipt_pdf.py').read_text()
    first=source.index("NETWORK='gps-account-closure-test-20261105'")
    end=source.index('tag=uuid.uuid4()')
    prefix='''NETWORK='gps-runtime120-private';DB='gps-runtime120-db';API='gps-runtime120-host'
inspect=lambda kind,name:json.loads(subprocess.check_output(['docker',kind,'inspect',name]))[0]
assert inspect('network',NETWORK)['Internal']
di,ai=inspect('container',DB),inspect('container',API)
assert all(c['Config']['Labels']['gps.runtime120']=='synthetic' for c in (di,ai))
root=pathlib.Path('/home/etcom-hub/build/gps-runtime120-20261113')
digest=hashlib.sha256((root/'out/gps-tracker-api').read_bytes()).hexdigest()
renderer=hashlib.sha256((root/'out/gps-pdf-render').read_bytes()).hexdigest()
for binary,expected in [('gps-tracker-api',digest),('gps-pdf-render',renderer)]:
 assert subprocess.check_output(['docker','exec',API,'sha256sum','/opt/'+binary]).decode().split()[0]==expected
base=f"http://{ai['NetworkSettings']['Networks'][NETWORK]['IPAddress']}:3043/gps-tracker/api/v1"
db=psycopg2.connect(f"postgres://postgres:closure-test-only@{di['NetworkSettings']['Networks'][NETWORK]['IPAddress']}/gps_closure_test");db.autocommit=True
'''
    source=source[:first]+prefix+source[end:]
    source=source.replace("['docker','exec',API,'/gps-pdf-render','selftest']", "['docker','exec',API,'/opt/gps-pdf-render','selftest']")
    source+='\n'+(r.JOB/'src/ops/test_runtime120_apis.py').read_text()
    # The original fixture is unchanged except its guarded endpoint transport.
    fixture=r.OUT/'fixture-business.py';fixture.write_text(source)
    result=r.call('/home/etcom-hub/build/gps-location-erasure-20261105/venv/bin/python',str(fixture),check=False,timeout=180)
    (r.OUT/'business.log').write_text(result.stdout+result.stderr);print(result.stdout[-6000:]+result.stderr,flush=True)
    if result.returncode:raise RuntimeError('business fixture failed')


if __name__=='__main__':{'service':service,'business':business}[sys.argv[1]]()
