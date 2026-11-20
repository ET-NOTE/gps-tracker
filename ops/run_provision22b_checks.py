"""Fresh 22B validation in a throwaway network; never production."""
import pathlib,subprocess,shutil
HERE=pathlib.Path(__file__).resolve().parent
assert str(HERE)=='/home/etcom-hub/build/gps-provision22-20261108b'
source=HERE/'src/ops'
# Prior 22 fixtures keep their expectations. Only disposable environment IDs differ.
for name in ['test_provision22.py','test_provision22_restore.py','test_provision22_upgrade.py','test_provision22_encrypted.py','run_provision22_regressions.py']:
 (HERE/name).write_text((source/name).read_text().replace('20261108','20261108b'))
for name in ['test_provision22b.py','test_provision22b_encrypted.py']:
 shutil.copy2(source/name,HERE/name)
def run(name,*args):
 with (HERE/'out'/name).open('w') as f:subprocess.run(['bash',str(HERE/'dev22.sh'),*args],stdout=f,stderr=subprocess.STDOUT,check=True)
run('reset.log','down')
for name in ['test-runtime.json','test-checkpoint.json','test-subject-checkpoint.json']:(HERE/name).unlink(missing_ok=True)
run('start.log','up')
run('external-all.log','external-all')
run('integration.log','suite','test_provision22.py')
run('restore.log','suite','test_provision22_restore.py')
run('upgrade.log','suite','test_provision22_upgrade.py')
run('api-plain.log','api')
run('22b-integration.log','suite','test_provision22b.py')
run('encrypted.log','suite','test_provision22_encrypted.py')
run('22b-encrypted.log','suite','test_provision22b_encrypted.py')
# Retained legacy suites exercise the intentional OFF compatibility mode.
import json,os
cred=json.loads((HERE/'test-runtime.json').read_text())
network=json.loads(subprocess.check_output(['docker','inspect','gps-provision22-db-20261108b']))[0]['NetworkSettings']['Networks']['gps-provision22-test-20261108b']
runtime='postgres://'+cred['user']+':'+cred['password']+'@'+network['IPAddress']+'/gps_closure_test'
subprocess.run(['bash',str(HERE/'dev22.sh'),'api'],env=dict(os.environ,STORAGE='pilot',RUNTIME_DSN=runtime,LEDGER='off',SUBJECTS='off'),check=True)
run('regressions.log','suite','run_provision22_regressions.py')
print('22B final isolated validation passed.')
