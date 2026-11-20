"""Fresh final verification; never run outside the named disposable build job."""
import pathlib,subprocess
HERE=pathlib.Path(__file__).resolve().parent
assert str(HERE)=='/home/etcom-hub/build/gps-provision22-20261108'
def run(name,*args):
 with (HERE/'out'/name).open('w') as f:
  subprocess.run(['bash',str(HERE/'dev22.sh'),*args],stdout=f,stderr=subprocess.STDOUT,check=True)
run('reset.log','down')
for name in ['test-runtime.json','test-checkpoint.json','test-subject-checkpoint.json']:(HERE/name).unlink(missing_ok=True)
run('start.log','up')
run('external-all.log','external-all')
run('integration.log','suite','test_provision22.py')
run('restore.log','suite','test_provision22_restore.py')
run('upgrade.log','suite','test_provision22_upgrade.py')
run('encrypted.log','suite','test_provision22_encrypted.py')
run('regressions.log','suite','run_provision22_regressions.py')
print('Final isolated checks passed.')
