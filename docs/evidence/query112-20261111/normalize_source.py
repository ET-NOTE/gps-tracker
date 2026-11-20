import hashlib,json,pathlib,tarfile
root=pathlib.Path('/home/etcom-hub/build')
perf=root/'gps-provision22-20261111query112';cum=root/'gps-provision22-20261111cumulative112'
name='gps-tracker-api/src/routes/devices.rs'
with tarfile.open(perf/'source.tar') as tar: expected=tar.extractfile(name).read()
evidence=[]
for job in (perf,cum):
 p=job/'src'/name;old=p.read_bytes()
 assert old.replace(b'\r\n',b'\n')==expected
 evidence.append({'job':job.name,'before_sha256':hashlib.sha256(old).hexdigest(),'git_sha256':hashlib.sha256(expected).hexdigest(),'only_crlf_normalized':True})
 p.write_bytes(expected)
(perf/'out/source-newline-check.json').write_text(json.dumps(evidence,indent=2)+'\n')
# Rebuild into a separate immutable file; leave the running candidate untouched.
script=(perf/'dev22.sh').read_text().replace('/out/gps-tracker-api.next','/out/gps-tracker-api.normalized-next').replace('mv /out/gps-tracker-api.normalized-next /out/gps-tracker-api','mv /out/gps-tracker-api.normalized-next /out/gps-tracker-api.normalized112')
(perf/'rebuild-normalized.sh').write_text(script)
print('Only CRLF normalized; separate binary rebuild prepared')
