"""Native encrypted API consent/PDF regressions; synthetic root fixture only."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from runtime121_control import ROOT, DSN, boot_settled as boot_new, stop_api

assert Path('/etc/runtime121-test-only').read_text().strip() == 'synthetic'
cred=json.loads((ROOT/'test-runtime.json').read_text())
runtime=DSN.replace('postgres:closure-test-only',cred['user']+':'+cred['password'])
env=dict(os.environ,STORAGE='pilot',RUNTIME_DSN=runtime,LEDGER='off',SUBJECTS='off')
results=[]


def restart(source):
    source=source.replace("subprocess.run(['bash',str(HERE/'dev22.sh'),'api'],env=env,check=True)", 'boot_new(env)')
    source=source.replace("subprocess.run(['bash',str(HERE/'dev22.sh'),'api'],env=dict(os.environ,LEDGER='on',SUBJECTS='on'),check=True)", "boot_new(dict(os.environ,LEDGER='on',SUBJECTS='on'))")
    source=source.replace("subprocess.run(['bash',str(HERE/'dev22.sh'),'api'],env=dict(os.environ,LEDGER='off',SUBJECTS='off'),check=True)", "boot_new(dict(os.environ,LEDGER='off',SUBJECTS='off'))")
    return source


def run(name,source):
    boot_new(env)
    target=ROOT/('native_'+name)
    target.write_text(source)
    with (ROOT/'out'/name.replace('.py','.log')).open('w') as log:
        p=subprocess.run([sys.executable,str(target)],env=env,stdout=log,stderr=subprocess.STDOUT)
    results.append(dict(suite=name,exit=p.returncode))
    (ROOT/'out/regressions121.json').write_text(json.dumps(results,indent=2))
    if p.returncode:
        raise AssertionError((name,(ROOT/'out'/name.replace('.py','.log')).read_text()[-2500:]))
    print('PASS '+name,flush=True)


for name in ['test_provision22.py','test_provision22b.py','test_provision22d.py']:
    source=(ROOT/name).read_text()
    a=source.index("NET='gps-provision22-test-")
    b=source.index('db=psycopg.connect',a)
    source=source[:a]+"from runtime121_control import DSN as dsn,boot_settled as boot_new\nassert HERE==pathlib.Path('/opt/gps121')\ndigest=hashlib.sha256((HERE/'out/gps-tracker-api').read_bytes()).hexdigest()\n"+source[b:]
    source=source.replace("host=inspect('container',API)['NetworkSettings']['Networks'][NET]['IPAddress']", "host='127.0.0.1'")
    if name=='test_provision22d.py':
        cases=ROOT/'test_provision22d_cases.py'
        cases.write_text(restart(cases.read_text()))
        source=source.replace("HERE/'src/ops/test_provision22d_cases.py'", "HERE/'test_provision22d_cases.py'")
    run(name,restart(source))

# Existing seven PDF business groups, only transport and decrypted view reads
# are adapted. The actual original bytes still pass through native PDF service.
name='test_privacy_receipt_pdf.py'
source=(ROOT/name).read_text().replace('import psycopg2','import psycopg as psycopg2').replace('.tobytes()','')
a=source.index("NETWORK='gps-account-closure-test-")
b=source.index('tag=uuid.uuid4()',a)
prefix='''from runtime121_control import ROOT,DSN
digest=hashlib.sha256((ROOT/'out/gps-tracker-api').read_bytes()).hexdigest()
renderer=hashlib.sha256((ROOT/'out/gps-pdf-render').read_bytes()).hexdigest()
base='http://127.0.0.1:3043/gps-tracker/api/v1'
db=psycopg2.connect(DSN,autocommit=True)
db.execute("SELECT set_config('gps.storage_keys',%s,false)",((ROOT/'test-keys.json').read_text(),))
'''
source=source[:a]+prefix+source[b:]
source=source.replace("['docker','exec',API,'/gps-pdf-render','selftest']", "['/opt/gps-pdf-render','selftest']")
source=source.replace("['docker','exec',API,'sh','-c',", "['sh','-c',")
fields=json.loads((ROOT/'crypto20b-fields.json').read_text())
for table in list(fields)+['devices','events','location_records']:
    source=re.sub(r'(DELETE\s+FROM\s+)'+table+r'\b',lambda m:m[1]+'__delete_'+table,source,flags=re.I)
    source=re.sub(r'((?:FROM|JOIN)\s+)'+table+r'\b',lambda m:m[1]+'gps_read_'+table,source,flags=re.I)
    source=source.replace('__delete_'+table,table)
source=source.replace('DELETE FROM users WHERE id=ANY(%s)','SELECT count(*) FROM users WHERE id=ANY(%s)')
run(name,source)
(ROOT/'out/receipt-pdf-validation.json').write_bytes((ROOT/'receipt-pdf-validation.json').read_bytes())
stop_api()
