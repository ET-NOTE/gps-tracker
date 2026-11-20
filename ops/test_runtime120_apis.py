"""Appended to the synthetic PDF business fixture; its accounts stay in RAM DB."""
import socket
import signal

def inside(*args):
 return subprocess.check_output(['docker','exec',API,*args],text=True).strip()

def units():
 return inside('pgrep','-x','gps-pdf-render').splitlines()

held_code="import socket; s=socket.socket(socket.AF_UNIX); s.connect('/run/gps-pdf-render/render.sock'); print('READY',flush=True); input(); s.close()"
holder=subprocess.Popen(['docker','exec','-i',API,'python3','-c',held_code],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
assert holder.stdout.readline().strip()=='READY'
try:
 for _ in range(50):
  try:
   if len(units())==2:break
  except subprocess.CalledProcessError:pass
  time.sleep(.02)
 else:raise AssertionError('no held worker')
 sql('DELETE FROM privacy_result_limits');now=company_state()['revision'];original=base
 started=time.monotonic();statuses=[]
 for port in (3043,3044):
  base=original.replace(':3043',':'+str(port))
  s,b,h=call('POST',path+f'/receipt-sources/{cr}/{edge}',{'company_revision':now,'page':1},at)
  assert s==429,(s,b);statuses.append(s)
 assert time.monotonic()-started<5
 check('two independent real API services return 429 while global PDF worker is occupied')
finally:
 base=original;holder.communicate('\n',timeout=5)
for _ in range(60):
 try:
  if not units():break
 except subprocess.CalledProcessError:break
 time.sleep(.02)
for port in (3043,3044):
 base=original.replace(':3043',':'+str(port));assert read(g,1)[0]==200
base=original
check('both API services recover after peer cancellation without restarting')

# Arm a deterministic stopped worker before issuing a valid HTTP page. The
# watcher observes /proc, stops the sandbox child, and records only its PID.
watcher_code="""import os,signal,time
from pathlib import Path
deadline=time.monotonic()+5
while time.monotonic()<deadline:
 ps={}
 for p in Path('/proc').glob('[0-9]*'):
  try:
   if (p/'comm').read_text().strip()=='gps-pdf-render':
    st=dict(x.split(':',1) for x in (p/'status').read_text().splitlines() if ':' in x)
    ps[int(p.name)]=int(st['PPid'])
  except FileNotFoundError:pass
 for pid,parent in ps.items():
  if parent in ps:
   os.kill(pid,signal.SIGSTOP);print(pid,flush=True);raise SystemExit(0)
 time.sleep(.001)
raise SystemExit('no worker observed')
"""
sql('DELETE FROM privacy_result_limits');now=company_state()['revision']
watcher=subprocess.Popen(['docker','exec',API,'python3','-c',watcher_code],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
ip=ai['NetworkSettings']['Networks'][NETWORK]['IPAddress']
body=json.dumps({'company_revision':now,'page':1}).encode()
request=(f'POST /gps-tracker/api/v1{path}/receipt-sources/{cr}/{edge} HTTP/1.1\r\nHost: fixture\r\nAuthorization: Bearer {at}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n').encode()+body
s=socket.create_connection((ip,3043));s.sendall(request)
pid=watcher.stdout.readline().strip();watcher.wait(timeout=6);assert pid.isdigit(),watcher.stderr.read()
start=time.monotonic();s.close()
# HTTP cancellation propagation and service's absolute deadline are reported
# separately; do not infer prompt HTTP cancellation from socket-only tests.
while time.monotonic()-start<16:
 try:
  if not units():break
 except subprocess.CalledProcessError:break
 time.sleep(.02)
else:raise AssertionError('HTTP cancellation left a worker beyond deadline')
elapsed=round(time.monotonic()-start,3)
assert read(g,1)[0]==200
check('HTTP disconnect drains sandbox worker within its bounded lifetime')
Path=pathlib.Path
(Path(__file__).parent/'api-lifetime-results.json').write_text(json.dumps(dict(two_api_busy=statuses,http_disconnect_seconds=elapsed,
 prompt_http_cancel=elapsed<2,api_recovery=True),indent=2))
