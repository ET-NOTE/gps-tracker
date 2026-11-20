import hashlib,json,pathlib,subprocess,time,urllib.request
ROOT=pathlib.Path('/home/etcom-hub/build/gps-review148-20261119')
NAME='gps-review148-functional'
IMAGE='sha256:a0bc650b308d2099a5cb2a1d561c8051dced45c991d43b065da665899c632a00'
def run(*args,check=True):
 p=subprocess.run(args,capture_output=True,text=True)
 if check and p.returncode:raise RuntimeError(repr(args[:4])+'\n'+p.stdout[-1500:]+p.stderr[-1500:])
 return p
def inside(*args,**kw):return run('docker','exec',NAME,*args,**kw)
assert run('hostname').stdout.strip()=='etcom-hub'
assert pathlib.Path.cwd()==ROOT
assert run('docker','inspect',NAME,check=False).returncode
assert (ROOT/'out/gps-tracker-api').is_file()
before=run('docker','ps','--format','{{.ID}} {{.Names}}').stdout
created=False
try:
 run('docker','run','-d','--name',NAME,'--label','gps.review148=synthetic','--network','none','--memory','1536m','--memory-swap','1536m','--cpus','1.5','--ulimit','core=0','--entrypoint','/bin/sleep',IMAGE,'infinity');created=True
 inside('mkdir','-p','/review/private','/review/uploads')
 for name,dest in [('out/gps-tracker-api','gps-api-dev'),('backend-extra.py','backend-extra.py'),('test_fleet_assets.py','test_fleet_assets.py')]:
  run('docker','cp',str(ROOT/name),NAME+':/review/'+dest)
 inside('chmod','755','/review/gps-api-dev')
 inside('pg_ctlcluster','--skip-systemctl-redirect','14','main','start','-o','-c shared_preload_libraries=timescaledb -c shared_buffers=64MB')
 inside('runuser','-u','postgres','--','psql','-v','ON_ERROR_STOP=1','-c',"ALTER USER postgres PASSWORD 'review147-test-only'")
 inside('runuser','-u','postgres','--','createdb','gps_tracker_dev_prodreview_20261020')
 env={'APP_ENV':'test','BIND_ADDR':'127.0.0.1:3042','DATABASE_URL':'postgres://postgres:review147-test-only@127.0.0.1/gps_tracker_dev_prodreview_20261020','JWT_SECRET':'review147-synthetic-only','UPLOAD_DIR':'/review/uploads','PRIVATE_UPLOAD_DIR':'/review/private','SMS_DEV_MODE':'1','RUST_LOG':'warn'}
 (ROOT/'synthetic.env').write_text(''.join(k+'='+v+'\n' for k,v in env.items()))
 run('docker','cp',str(ROOT/'synthetic.env'),NAME+':/review/synthetic.env')
 run('docker','exec','-d','-w','/review',*[arg for k,v in env.items() for arg in ('-e',k+'='+v)],NAME,'sh','-c','exec /review/gps-api-dev > /review/api.log 2>&1')
 ready=False
 for _ in range(60):
  status=inside('curl','-fsS','http://127.0.0.1:3042/gps-tracker/health',check=False)
  if status.returncode==0:ready=True;break
  time.sleep(.5)
 if ready:assert json.loads(status.stdout)['release']=='review148-20261119-r1'
 if not ready:raise RuntimeError(inside('cat','/review/api.log').stdout[-3000:])
 (ROOT/'health.json').write_text(status.stdout)
 for test in ('test_fleet_assets.py','backend-extra.py'):
  args=['python3','/review/'+test]
  if test=='test_fleet_assets.py':args+=['/review/synthetic.env','http://127.0.0.1:3042']
  result=inside(*args,check=False)
  (ROOT/(test+'.log')).write_text(result.stdout+result.stderr)
  print(test,result.returncode,result.stdout[-6000:]+result.stderr[-2000:],flush=True)
  assert result.returncode==0,test+' failed'
finally:
 if created:
  run('docker','cp',NAME+':/review/api.log',str(ROOT/'synthetic-api.log'),check=False)
  inspect=json.loads(run('docker','inspect',NAME).stdout)[0]
  assert inspect['Config']['Labels'].get('gps.review148')=='synthetic' and inspect['HostConfig']['NetworkMode']=='none'
  run('docker','rm','-f',NAME)
  after=run('docker','ps','--format','{{.ID}} {{.Names}}').stdout
  result={'container_removed':True,'neighbors_unchanged':sorted(before.splitlines())==sorted(after.splitlines()),'network':'none','api_sha256':hashlib.sha256((ROOT/'out/gps-tracker-api').read_bytes()).hexdigest()}
  (ROOT/'cleanup.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
