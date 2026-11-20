import hashlib,json,pathlib,re,shutil
root=pathlib.Path('/home/etcom-hub/build')
job=root/'gps-provision22-20261111query112'
cum=root/'gps-provision22-20261111cumulative112'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
new=job/'out/gps-tracker-api.budget112'
assert new.is_file() and sha(new)!=sha(job/'out/gps-tracker-api.final112')
shutil.copy2(job/'out/gps-tracker-api.final112',job/'out/gps-tracker-api.prebudget112')
shutil.copy2(new,job/'out/gps-tracker-api.final112')
for kind in ['check','release']:
 shutil.copy2(job/f'out/api-{kind}-final.log',job/f'out/api-{kind}-prebudget.log')
 shutil.copy2(job/f'out/api-{kind}-budget.log',job/f'out/api-{kind}-final.log')
saved=cum/'prebudget-evidence';saved.mkdir(exist_ok=False)
for p in (cum/'out').iterdir():
 if p.suffix in ('.json','.log'):shutil.copy2(p,saved/p.name)
# Guarded cleanup removes only this round's synthetic resources and keys.
import prepare_query112_cumulative
prepare_query112_cumulative.cleanup()
shutil.copy2(new,cum/'out/gps-tracker-api')
shutil.copytree(job/'src',cum/'src',dirs_exist_ok=True)
p=cum/'rehearse_cumulative112.py';s=p.read_text()
s=re.sub(r"API_SHA = '[a-f0-9]{64}'",'API_SHA = '+repr(sha(new)),s);p.write_text(s)
print('FINAL BUDGET BUILD',sha(new),flush=True)
