"""Run restricted-runtime worker tests in the fixed, disposable repair113 job."""
import json
import os
import pathlib
import subprocess
import sys
from urllib.parse import quote

JOB = pathlib.Path('/home/etcom-hub/build/gps-provision22-20261111repair113')
NET = 'gps-provision22-test-20261111repair113'
DB = 'gps-provision22-db-20261111repair113'
IMAGE = 'gps-build:rust1.88-node22.22.2'
ROOT = JOB.parent / 'gps-tracker'

def address(name):
    return subprocess.check_output(['docker','inspect','-f', '{{(index .NetworkSettings.Networks "'+NET+'").IPAddress}}',name],text=True).strip()

def prepare():
    sys.path.insert(0,str(JOB/'src/ops'))
    from admin_db_roles import run
    secret = JOB/'test-runtime.json'
    result = run('postgres://postgres:closure-test-only@'+address(DB)+'/gps_closure_test',True,secret)
    creds=json.loads(secret.read_text())
    runtime='postgres://gps_runtime:'+quote(creds['password'])+'@closure-db:5432/gps_closure_test'
    env=JOB/'fixture.env'
    with env.open('x') as f:
        os.chmod(env,0o600)
        f.write('LEDGER_TEST_DATABASE_URL=postgres://postgres:closure-test-only@closure-db:5432/gps_closure_test\n')
        f.write('STATS_TEST_RUNTIME_URL='+runtime+'\n')
    ring=JOB/'test-keys.json'
    with ring.open('x') as f:
        os.chmod(ring,0o600)
        json.dump({'active':'repair113','keys':{'repair113':'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE='}},f)
    (JOB/'out/runtime-setup.json').write_text(json.dumps(result,indent=2))
    print('Restricted runtime prepared; synthetic credentials kept private')

def test():
    command=['docker','run','--rm','--network',NET,'--env-file',str(JOB/'fixture.env'),
        '--cpus=6','--memory=8g','--pids-limit=1024','--cap-drop=ALL','--security-opt=no-new-privileges',
        '--user',str(os.getuid())+':'+str(os.getgid()),'-e','CARGO_HOME=/cache/cargo',
        '-e','CARGO_TARGET_DIR=/cache/target','-e','CARGO_BUILD_JOBS=6','-e','CARGO_INCREMENTAL=0',
        '-v',str(ROOT/'cache')+':/cache','-v',str(JOB/'src')+':/work',
        '-w','/work/gps-tracker-api',IMAGE,'cargo','test','--locked','missing_daily_repair113','--','--ignored','--nocapture']
    subprocess.run(['flock','-w','900',str(ROOT/'build.lock'),*command],check=True)

if __name__=='__main__':
    assert JOB.resolve()==JOB
    {'prepare':prepare,'test':test}[sys.argv[1]]()
