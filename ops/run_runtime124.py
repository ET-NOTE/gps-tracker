"""Sequential, fail-fast synthetic124 verification, no production target."""
import json
import sys
from rehearse_runtime124 import base, HOST, original_call as call, suite


def verify(action):
    p=base.inside('python3','/opt/gps121/verify_runtime124.py',action,check=False,timeout=900)
    (base.OUT/('verify-'+action+'.log')).write_text(p.stdout+p.stderr)
    call('docker','cp',HOST+':/opt/gps121/out/.',str(base.OUT))
    print(p.stdout[-1500:]+p.stderr[-1500:],flush=True)
    assert p.returncode==0,action


if __name__=='__main__':
    base.guard()
    info=json.loads(call('docker','inspect',HOST).stdout)[0]
    assert info['Config']['Labels'].get('gps.runtime124')=='synthetic'
    actions=[('verify','after'),('verify','fairness'),('suite','candidate-1'),
             ('suite','candidate-2'),('suite','shared-after'),('verify','rights'),('verify','final')]
    start=sys.argv[1] if len(sys.argv)>1 else 'after'
    assert start in [a for _,a in actions]
    for kind,action in actions[[a for _,a in actions].index(start):]:
        print('START',action,flush=True)
        (verify if kind=='verify' else suite)(action)
    print('PASS full124 sequence',flush=True)
