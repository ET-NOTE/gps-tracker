#!/usr/bin/env python3
"""Read-only diagnostics plus synthetic invalid credential probes. No account, location or payment actions."""
import datetime, hashlib, json, pathlib, socket, subprocess, time, urllib.request, urllib.error, uuid

marker='gps_log_probe_'+uuid.uuid4().hex
began=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
paths=['/health?probe='+marker, '/api/v1/share/'+marker,
       '/gps-tracker/api/v1/share/'+marker, '/ws/realtime?token='+marker, '/share/'+marker]
log=pathlib.Path('/var/log/nginx/gps_access.log')
start=log.stat().st_size if log.exists() else 0
errors=pathlib.Path('/var/log/gps-nginx/errors.log')
error_start=errors.stat().st_size if errors.exists() else 0
results=[]
for path in paths:
    req=urllib.request.Request('https://gps.serial.kr'+path,headers={'User-Agent':marker,'Referer':'https://example.invalid/'+marker})
    try:
        with urllib.request.urlopen(req,timeout=10) as r: results.append(r.status)
    except urllib.error.HTTPError as e: results.append(e.code)
sock=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM)
sock.sendto(('<11>gps_probe: connect() failed while testing redaction request='+marker).encode(),'/run/gps-nginx-log/errors.sock')
sock.close();time.sleep(.5)
with log.open() as f:f.seek(start);access=f.read()
with errors.open() as f:f.seek(error_start);error=f.read()
assert marker not in access and marker not in error
rows=[json.loads(s) for s in access.splitlines()]
assert len(rows)>=len(paths)
assert any(r['route']=='/api/v1/share/:redacted' for r in rows)
assert any(r['route']=='/ws/:stream' for r in rows)
assert any(json.loads(s)['category']=='upstream_connect' for s in error.splitlines())
# The vhost must not duplicate these requests to the old, raw global logs.
for path in ['/var/log/nginx/access.log','/var/log/nginx/error.log']:
    with open(path,'rb') as f:
        f.seek(max(0,pathlib.Path(path).stat().st_size-2_000_000))
        assert marker.encode() not in f.read(), 'raw global logging still receives GPS probes'
with urllib.request.urlopen('https://gps.serial.kr/health',timeout=10) as r: health=json.load(r)
assert health['ok'] and health['db']
journal=subprocess.check_output(['journalctl','-u','gps-tracker-api','--since',began,'--no-pager','-o','cat'],text=True)
assert marker not in journal
out={'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
     'environment':'production gps.serial.kr','probes':'synthetic invalid credentials; error socket injection',
     'http_statuses':results,'access_secret_absent':True,'error_secret_absent':True,'global_log_copy_absent':True,
     'api_journal_probe_secret_absent':True,
     'safe_route_labels':sorted({r['route'] for r in rows}),
     'health':health,'api_sha256':hashlib.sha256(pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api').read_bytes()).hexdigest(),
     'api_process':subprocess.check_output(['systemctl','show','gps-tracker-api','-p','MainPID','-p','ExecMainStartTimestamp'],text=True).splitlines(),
     'logger':subprocess.check_output(['systemctl','is-active','gps-nginx-log'],text=True).strip(),
     'scope':'Production synthetic probes: NGINX access/error and API journal. Rust trace fields and disclosure text are additionally checked in isolated tests. HTTP 200 frontend responses are SPA pages, not successful authentication.'}
print(json.dumps(out,indent=2))
