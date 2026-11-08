"""Sequential additional tests on the already rehearsed fixed isolated job."""
import json
import pathlib
import subprocess

JOB=pathlib.Path('/home/etcom-hub/build/gps-provision22-20261108cumulative109')
assert pathlib.Path(__file__).resolve().parent==JOB
assert json.loads((JOB/'out/cumulative109.json').read_text())['runtime_ready_for_regressions']
results=[]
for name,args in (
    ('ancestry109',['suite','test_subject_ancestry109.py']),
    ('query109',['suite','benchmark_subject_queries109.py']),
    ('external-all',['external-all']),
    ('external-boundary',['external-boundary']),
):
    with (JOB/'out'/(name+'.log')).open('w') as log:
        result=subprocess.run(['bash',str(JOB/'dev22.sh'),*args],stdout=log,stderr=subprocess.STDOUT)
    results.append({'check':name,'exit':result.returncode})
    (JOB/'out/additional109-tests.json').write_text(json.dumps(results,indent=2)+'\n')
    assert result.returncode==0,name
    print('PASS '+name,flush=True)
