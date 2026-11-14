"""Sequential, fail-fast synthetic123 verification, no production target."""
import json
import sys
from rehearse_runtime123 import base, HOST, original_call as call, suite


def verify(action):
    p=base.inside('python3','/opt/gps121/verify_runtime123.py',action,check=False,timeout=900)
    (base.OUT/('verify-'+action+'.log')).write_text(p.stdout+p.stderr)
    call('docker','cp',HOST+':/opt/gps121/out/.',str(base.OUT))
    print(p.stdout[-1500:]+p.stderr[-1500:],flush=True)
    assert p.returncode==0,action


if __name__=='__main__':
    base.guard()
    info=json.loads(call('docker','inspect',HOST).stdout)[0]
    assert info['Config']['Labels'].get('gps.runtime123')=='synthetic'
    actions=[('verify','before'),('suite','baseline'),('verify','after'),('verify','fairness'),
             ('suite','dedicated'),('suite','shared'),('verify','rights'),('verify','final')]
    start=sys.argv[1] if len(sys.argv)>1 else 'before'
    assert start in [a for _,a in actions]
    for kind,action in actions[[a for _,a in actions].index(start):]:
        print('START',action,flush=True)
        (verify if kind=='verify' else suite)(action)
    print('PASS full123 sequence',flush=True)
