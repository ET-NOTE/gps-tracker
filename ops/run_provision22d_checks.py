"""22D isolated regression orchestration. No production calls or external sends."""
import pathlib,subprocess,shutil,os,json
HERE=pathlib.Path(__file__).resolve().parent
assert str(HERE)=='/home/etcom-hub/build/gps-provision22-20261108d'
source=HERE/'src/ops'
for name in ['test_provision22.py','test_provision22_restore.py','test_provision22_encrypted.py','run_provision22_regressions.py']:
 (HERE/name).write_text((source/name).read_text().replace('20261108','20261108d'))
for name in ['test_provision22b.py','test_provision22b_encrypted.py']:
 (HERE/name).write_text((source/name).read_text().replace('20261108b','20261108d'))
for name in ['test_provision22d.py','test_provision22d_encrypted.py','test_provision22d_upgrade.py']:
 shutil.copy2(source/name,HERE/name)
(HERE/'test_provision22c_health.py').write_text((source/'test_provision22c_health.py').read_text().replace('20261108c','20261108d').replace("'schema':107","'schema':108"))
def run(name,*args):
 with (HERE/'out'/name).open('w') as f:subprocess.run(['bash',str(HERE/'dev22.sh'),*args],stdout=f,stderr=subprocess.STDOUT,check=True)
run('api-initial.log','api')
run('22d-integration.log','suite','test_provision22d.py')
run('api-reset.log','api')
run('integration.log','suite','test_provision22.py')
run('restore.log','suite','test_provision22_restore.py')
run('upgrade.log','suite','test_provision22d_upgrade.py')
run('api-plain.log','api')
run('22b-integration.log','suite','test_provision22b.py')
run('encrypted.log','suite','test_provision22_encrypted.py')
run('22b-encrypted.log','suite','test_provision22b_encrypted.py')
run('22d-encrypted.log','suite','test_provision22d_encrypted.py')
run('queue-health.log','suite','test_provision22c_health.py')
cred=json.loads((HERE/'test-runtime.json').read_text())
network=json.loads(subprocess.check_output(['docker','inspect','gps-provision22-db-20261108d']))[0]['NetworkSettings']['Networks']['gps-provision22-test-20261108d']
runtime='postgres://'+cred['user']+':'+cred['password']+'@'+network['IPAddress']+'/gps_closure_test'
subprocess.run(['bash',str(HERE/'dev22.sh'),'api'],env=dict(os.environ,STORAGE='pilot',RUNTIME_DSN=runtime,LEDGER='off',SUBJECTS='off'),check=True)
run('regressions.log','suite','run_provision22_regressions.py')
print('22D isolated validation passed.')
