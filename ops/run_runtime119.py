"""Launch fixed protected rehearsal controllers, never a production deployer."""
import argparse
import json
from pathlib import Path
import subprocess

ROOT = Path('/home/etcom-hub/build')
JOB = ROOT/'gps-provision22-20261112cumulative119'
NET = 'gps-provision22-test-20261112cumulative119'
NAME = 'gps119-controller'


def launch(script, action=None):
    global JOB, NET
    if script == 'benchmark_runtime119.py':
        assert action in ('setup','load','probe','faults','business')
        JOB=ROOT/'gps-provision22-20261112runtime119'; NET='gps-runtime119-test'
    else:
        assert action is None
    assert script in ('rehearse_cumulative119.py','check_cumulative119.py','rehearse_release119.py','verify_process119.py','benchmark_runtime119.py')
    old = subprocess.run(['docker','network','inspect',NET],capture_output=True)
    if old.returncode:
        subprocess.run(['docker','network','create','--internal','--label','gps.runtime119=synthetic',NET],check=True)
    else:
        value=json.loads(old.stdout)[0]; assert value['Internal'] and value['Labels']['gps.runtime119']=='synthetic'
    gid = str(Path('/var/run/docker.sock').stat().st_gid)
    args=['docker','run','--rm','--name',NAME+('-benchmark' if action else ''),'--label','gps.runtime119=synthetic','--network',NET,
          '--memory=1024m','--memory-swap=1024m','--ulimit=core=0','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=64m',
          '--user','1000:1000','--group-add',gid,'--cap-drop=ALL','--security-opt=no-new-privileges',
          '-e','GPS_RUNTIME_PROFILE=controller','-e','PATH='+str(JOB/'bin')+':/usr/bin:/bin',
          '-e','PYTHONPATH='+str(JOB/'src/ops'),'-v',str(JOB)+':'+str(JOB),
          '-v','/var/run/docker.sock:/var/run/docker.sock','-w',str(JOB),
          'gps-runtime119:20261112','python3',str(JOB/script),*([action] if action else [])]
    with (JOB/'out'/(script+('-'+action if action else '')+'.log')).open('w') as log:
        result=subprocess.run(args,stdout=log,stderr=subprocess.STDOUT)
    print(script, 'exit',result.returncode,flush=True)
    if result.returncode: raise SystemExit(result.returncode)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('script');p.add_argument('action',nargs='?'); a=p.parse_args();launch(a.script,a.action)
