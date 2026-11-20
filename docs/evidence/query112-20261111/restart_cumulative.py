import hashlib,pathlib,re,shutil
root=pathlib.Path('/home/etcom-hub/build');job=root/'gps-provision22-20261111cumulative112'
source=root/'gps-provision22-20261111query112/out/gps-tracker-api.final112'
assert job.resolve()==job and source.is_file()
shutil.copy2(job/'out/rehearse112.log',job/'out/attempt-baseline-binary.log')
shutil.copy2(source,job/'out/gps-tracker-api')
p=job/'rehearse_cumulative112.py';s=p.read_text();s=re.sub(r"API_SHA = '[a-f0-9]{64}'",'API_SHA = '+repr(hashlib.sha256(source.read_bytes()).hexdigest()),s);p.write_text(s)
print('Cumulative harness pinned to immutable final112 artifact')
