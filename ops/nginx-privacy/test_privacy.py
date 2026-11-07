#!/usr/bin/env python3
"""Run only inside the disposable Ubuntu nginx/rsyslog test container, with --network none."""
import http.client, json, os, pathlib, pwd, signal, socket, subprocess, tempfile, time

HERE = pathlib.Path(__file__).resolve().parent
ROOT = pathlib.Path(tempfile.mkdtemp(prefix='gps-private-log-'))
ROOT.chmod(0o755)
CANARY = 'SYNTHETIC_SECRET_DO_NOT_STORE_7824'
processes=[]

def wait_for(test):
    for _ in range(100):
        if test(): return
        time.sleep(.05)
    raise AssertionError('condition not reached')

def request(method, path, status, route):
    c=http.client.HTTPConnection('127.0.0.1',18080,timeout=3)
    c.request(method,path,headers={'Host':'gps.serial.kr','Referer':f'https://example.invalid/{CANARY}',
        'User-Agent':CANARY,'Authorization':f'Bearer {CANARY}'})
    r=c.getresponse();r.read();assert r.status==status,(path,r.status);c.close()
    wait_for(lambda:len((ROOT/'access.log').read_text().splitlines())>=len(expected)+1)
    expected.append((method if method in ('GET','POST','OPTIONS') else 'OTHER',route,status))

try:
    (ROOT/'log').mkdir();account=pwd.getpwnam('syslog')
    os.chown(ROOT/'log',account.pw_uid,account.pw_gid)
    (ROOT/'run').mkdir();os.chown(ROOT/'run',account.pw_uid,account.pw_gid)
    rsys=(HERE/'rsyslog.conf').read_text().replace('/run/gps-nginx-log',str(ROOT/'run')).replace('/var/log/gps-nginx',str(ROOT/'log'))
    (ROOT/'rsyslog.conf').write_text(rsys)
    subprocess.run(['rsyslogd','-N1','-f',str(ROOT/'rsyslog.conf')],check=True,capture_output=True)
    def drop():os.setgid(account.pw_gid);os.setuid(account.pw_uid)
    log=subprocess.Popen(['rsyslogd','-n','-i',str(ROOT/'run/pid'),'-f',str(ROOT/'rsyslog.conf')],
                         stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,preexec_fn=drop)
    processes.append(log);wait_for(lambda:(ROOT/'run/errors.sock').is_socket())
    conf=f'''pid {ROOT}/nginx.pid;
events {{ worker_connections 64; }}
http {{
 include {HERE}/gps-private-log.conf;
 server {{ listen 18080; server_name gps.serial.kr;
 access_log {ROOT}/access.log gps_private;
 error_log syslog:server=unix:{ROOT}/run/errors.sock,tag=gps_nginx,nohostname error;
 location /failure/ {{ proxy_pass http://127.0.0.1:9; }}
 location / {{ return 204; }}
 }}
}}
'''
    (ROOT/'nginx.conf').write_text(conf)
    subprocess.run(['nginx','-t','-c',str(ROOT/'nginx.conf')],check=True)
    nginx=subprocess.Popen(['nginx','-c',str(ROOT/'nginx.conf'),'-g','daemon off;'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    processes.append(nginx);time.sleep(.3)
    assert nginx.poll() is None, nginx.stderr.read().decode()
    expected=[]
    for path,route in [('/health','/health'),('/ws/realtime?token='+CANARY,'/ws/:stream'),
                       ('/gps-tracker/ws/realtime?token='+CANARY,'/ws/:stream'),
                       ('/api/v1/share/'+CANARY+'/locations','/api/v1/share/:redacted'),
                       ('/gps-tracker/api/v1/share/'+CANARY,'/api/v1/share/:redacted'),
                       ('/share/'+CANARY,'/share/:redacted'),('/assets/'+CANARY+'.js','/assets/:file'),
                       ('/unknown/'+CANARY,'/other'),('/login?next='+CANARY,'/login'),
                       ('/api/v1/devices/123?password='+CANARY,'/api/v1/devices/:resource')]:
        request('GET',path,204,route)
    request('GET','/failure/'+CANARY+'?token='+CANARY,502,'/other')
    wait_for(lambda:(ROOT/'log/errors.log').exists())
    # Error message secrets may be anywhere, including filenames and syslog tags.
    sock=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM)
    for text in ['SSL '+CANARY, 'open() "'+CANARY+'" failed', 'limiting requests '+CANARY,
                 'timed out '+CANARY, 'unknown '+CANARY]:
        sock.sendto(('<11>'+CANARY+': '+text).encode(),str(ROOT/'run/errors.sock'))
    wait_for(lambda:len((ROOT/'log/errors.log').read_text().splitlines())>=6)
    # Reopening after rotation must preserve classification and permissions.
    (ROOT/'log/errors.log').rename(ROOT/'log/rotated.log');log.send_signal(signal.SIGHUP);time.sleep(.1)
    sock.sendto(('<11>nginx: connect() failed '+CANARY).encode(),str(ROOT/'run/errors.sock'))
    wait_for(lambda:(ROOT/'log/errors.log').exists())
    raw=(ROOT/'access.log').read_text()+(ROOT/'log/rotated.log').read_text()+(ROOT/'log/errors.log').read_text()
    assert CANARY not in raw
    rows=[json.loads(x) for x in (ROOT/'access.log').read_text().splitlines()]
    assert [(r['method'],r['route'],r['status']) for r in rows]==expected
    assert all(set(r)=={'time','client','method','route','status','bytes','seconds'} for r in rows)
    errors=[json.loads(x) for x in (ROOT/'log/rotated.log').read_text().splitlines()]
    assert {r['category'] for r in errors}>={'upstream_connect','tls','filesystem','rate_limit','timeout','other'}
    assert all(set(r)=={'time','severity','category'} for r in errors)
    assert (ROOT/'log/errors.log').stat().st_mode & 0o777 == 0o640
    print(json.dumps({'environment':'isolated Ubuntu 22.04; network none; synthetic requests only',
        'requests':len(rows),'classified_error_categories':sorted({r['category'] for r in errors}),
        'secret_absent':True,'rotation_passed':True,'error_file_mode':'0640',
        'nginx':subprocess.run(['nginx','-v'],capture_output=True,text=True).stderr.strip()}))
finally:
    for p in reversed(processes):
        p.terminate()
        try:p.wait(timeout=5)
        except subprocess.TimeoutExpired:p.kill();p.wait()
