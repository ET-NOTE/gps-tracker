"""Native monthly/read/ingest/PDF/cleanup workload, synthetic and internal only.

Uses the established115 monthly fixture and actual120 API/PDF binaries. Other
projects and AV are bounded pressure simulators, not their real applications.
"""
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import http.client
import inspect
import json
import os
from pathlib import Path
import pwd
import random
import ssl
import subprocess
import sys
import threading
import time
import uuid
from urllib.parse import quote
import psycopg2
import benchmark_location115 as b
from runtime121_control import ROOT, DSN, secret, migrate, job, stop_api

assert Path('/etc/runtime121-test-only').read_text().strip() == 'synthetic'
b.JOB, b.OUT = ROOT, ROOT/'out'
b.SHA = '56912e102bd55db65f253d7f19c409a04e239b8e993f60baead577e51efbf536'


def connect():
    db = psycopg2.connect(DSN)
    db.autocommit = True
    with db.cursor() as q:
        q.execute("SET statement_timeout='120s'; SET lock_timeout='5s'; SET jit=off; SET temp_tablespaces='gps121_sort'")
        if (ROOT/'test-keys.json').exists():
            q.execute("SELECT set_config('gps.storage_keys',%s,false)", ((ROOT/'test-keys.json').read_text(),))
    return db


b.connect = connect
sql, save = b.sql, b.save


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def runtime():
    value = json.loads((ROOT/'test-runtime.json').read_text())
    return DSN.replace('postgres:closure-test-only', value['user']+':'+value['password'])


def start(poll=300):
    stop_api()
    link = ROOT/'active-api'
    link.unlink(missing_ok=True)
    link.symlink_to('/opt/gps-tracker-api')
    values = dict(APP_ENV='test', DATABASE_URL=runtime(), GPS_DATABASE_MODE='runtime', JWT_SECRET=b.JWT,
        BIND_ADDR='127.0.0.1:3043', SMS_DEV_MODE='1', GPS_PDF_SOCKET='/run/gps-pdf-render/render.sock',
        GPS_PDF_RENDERER='/opt/gps-pdf-render', GPS_LOCATION_ENCRYPTION='pilot',
        GPS_LOCATION_KEYRING_FILE=str(ROOT/'api-keyring.json'), GPS_LOCATION_TEMP_TABLESPACE='gps121_sort',
        UPLOAD_DIR=str(ROOT/'test-storage/uploads'), PRIVATE_UPLOAD_DIR=str(ROOT/'test-storage/private'),
        GPS_LOCATION_ACCESS_LOG='on', GPS_LOCATION_ACCESS_FLUSH_SECONDS='1', GPS_SUBJECT_PROVISION='on',
        GPS_INGEST_TLS_REQUIRED='on', GPS_TLS_TRUSTED_PROXIES='127.0.0.1/32', GPS_STATS_POLL_SECONDS=str(poll))
    secret('/etc/gps121/api.env', '\n'.join(k+'='+v for k,v in values.items()))
    command('systemctl', 'reset-failed', 'gps121-api')
    command('systemctl', 'start', 'gps121-api')
    for _ in range(100):
        try:
            c = http.client.HTTPConnection('127.0.0.1', 3043, timeout=1)
            c.request('GET', '/gps-tracker/health'); r=c.getresponse(); body=r.read(); c.close()
            if r.status == 200 and json.loads(body)['db']: return
        except OSError: pass
        time.sleep(.2)
    raise AssertionError('API startup failed')


def tls():
    directory = Path('/etc/gps122-tls'); directory.mkdir(exist_ok=True)
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj','/CN=localhost',
        '-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',str(directory/'key.pem'),'-out',str(directory/'cert.pem')],check=True,capture_output=True)
    user = pwd.getpwnam('gps-api')
    os.chown(directory/'key.pem',user.pw_uid,user.pw_gid);(directory/'key.pem').chmod(0o400)
    (directory/'nginx.conf').write_text('pid /tmp/gps122-nginx.pid; error_log stderr warn; events {} http { access_log off; client_body_temp_path /tmp/client; proxy_temp_path /tmp/proxy; fastcgi_temp_path /tmp/fastcgi; uwsgi_temp_path /tmp/uwsgi; scgi_temp_path /tmp/scgi; '
        'server { listen 127.0.0.1:8443 ssl; ssl_protocols TLSv1.2 TLSv1.3; ssl_certificate /etc/gps122-tls/cert.pem; ssl_certificate_key /etc/gps122-tls/key.pem; '
        'location / { proxy_pass http://127.0.0.1:3043; proxy_read_timeout 90s; proxy_ignore_client_abort off; proxy_set_header X-GPS-TLS-Version $ssl_protocol; } } }')
    unit = '''[Unit]
Requires=gps121-temp-ready.service
After=gps121-temp-ready.service
BindsTo=run-gps121-tmp.mount
[Service]
User=gps-api
Group=gps-api
ExecStart=/usr/sbin/nginx -c /etc/gps122-tls/nginx.conf -g 'daemon off;'
MemoryMax=64M
MemorySwapMax=0
LimitCORE=0
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
BindPaths=/run/gps121/tmp:/tmp
Environment=LD_PRELOAD=/usr/local/lib/gps-nodump.so
Slice=gps-workload.slice
'''
    Path('/etc/systemd/system/gps122-proxy.service').write_text(unit)
    command('systemctl','daemon-reload');command('systemctl','start','gps122-proxy')


class Client:
    def __init__(self):
        self.tls = ssl.create_default_context(cafile='/etc/gps122-tls/cert.pem')
        self.tls.minimum_version = self.tls.maximum_version = ssl.TLSVersion.TLSv1_2

    def get(self,path,uid=None,body=None,headers=None):
        c=http.client.HTTPSConnection('127.0.0.1',8443,context=self.tls,timeout=90)
        began=time.monotonic()
        try:
            c.request('POST' if body is not None else 'GET',path,body,headers or ({'Authorization':'Bearer '+b.token(uid)} if uid else {}))
            r=c.getresponse(); data=r.read()
            return r.status,data,dict((k.lower(),v) for k,v in r.getheaders()),time.monotonic()-began
        finally:c.close()


b.Client = Client


def seed():
    assert hashlib.sha256((ROOT/'out/gps-tracker-api').read_bytes()).hexdigest() == b.SHA
    migrate('migration122', DSN)
    assert sql('SELECT max(version) FROM _sqlx_migrations') == [(112,)]
    # Reuse only the reviewed synthetic fixture block, with explicit boundaries.
    source=inspect.getsource(b.setup)
    begin=source.index("    private('test-keys.json'")
    end=source.index("    sys.path.insert",begin)
    fragment='\n'.join(line[4:] if line.startswith('    ') else line for line in source[begin:end].splitlines())
    scope=dict(vars(b))
    exec(compile(fragment,'monthly115_fixture_reuse','exec'),scope)
    devices,users=scope['devices'],scope['users']
    save('fixture',dict(devices=devices,users=users,rows=119040,unique_points=714240,schema=112,api_sha256=b.SHA))
    b.mappings()
    # Disable only the disposable cluster's legacy retention jobs.
    for job_id, in sql("SELECT job_id FROM timescaledb_information.jobs WHERE proc_name='policy_retention' AND hypertable_schema='public'"):
        sql('SELECT alter_job(%s,scheduled=>false)',(job_id,))
    from admin_db_roles import run as roles
    roles(DSN,True,ROOT/'test-runtime.json')
    sql('GRANT CREATE ON TABLESPACE gps121_sort TO gps_runtime')
    sql('ALTER ROLE gps_runtime CONNECTION LIMIT 30')
    sql("ALTER ROLE gps_runtime IN DATABASE gps_closure_test SET temp_tablespaces='gps121_sort'")
    ring=(ROOT/'test-keys.json').read_text()
    secret('/etc/gps121/keyring.json',ring);secret(ROOT/'api-keyring.json',ring)
    uid=pwd.getpwnam('gps-api').pw_uid
    os.chown(ROOT/'api-keyring.json',uid,uid)
    for name in ['uploads/device_documents/1/1','private']:
        (ROOT/'test-storage'/name).mkdir(parents=True,exist_ok=True)
    for p in (ROOT/'test-storage').rglob('*'):os.chown(p,uid,uid)
    start(5);tls();b.repair();start(300)
    assert Client().get('/gps-tracker/health')[0] == 200
    save('seed122',dict(encrypted_rows=sql('SELECT count(*),count(*) FILTER(WHERE lat IS NOT NULL OR lng IS NOT NULL OR fixes_jsonb IS NOT NULL) FROM location_records')[0],
        source_fixture='benchmark_location115.setup synthetic seed block',stats_days=248,legacy_retention_disabled_only_in_fixture=True))


def cgroups():
    names={'gps':'gps-workload.slice','db':'gps121-db.service','api':'gps121-api.service','pdf':'gps-workload-pdf.slice',
        'other':'gps122-other.service','av':'gps122-av.service','cleanup':'gps121-cleanup.service'}
    values={}
    for label,unit in names.items():
        cg=command('systemctl','show',unit,'-p','ControlGroup','--value')
        if not cg:continue
        path=Path('/sys/fs/cgroup'+cg)
        values[label]={k:(path/k).read_text().strip() for k in ['memory.current','memory.peak','memory.max','memory.swap.current','memory.events','cpu.stat','io.stat'] if (path/k).exists()}
    values['container']={k:(Path('/sys/fs/cgroup')/k).read_text().strip() for k in ['memory.current','memory.peak','memory.max','memory.swap.current','memory.events','cpu.max','cpu.stat','io.max','io.stat']}
    return values


def pressure(kind):
    # Separate pressure services. Models reserved use, not actual application/AV behavior.
    size=768 if kind=='other' else 600
    memory=bytearray(size*1024**2)
    for i in range(0,len(memory),4096):memory[i]=1
    clients=[]
    if kind=='other':
        for _ in range(24):clients.append(psycopg2.connect(DSN.replace('postgres:closure-test-only','other122:synthetic-only')))
        for c in clients:c.autocommit=True
    Path('/tmp/gps122-'+kind+'-ready').write_text(str(size))
    counter=0
    while True:
        for i in range(0,len(memory),4096):memory[i]=(memory[i]+1)&255
        if clients:
            with clients[counter%24].cursor() as q:q.execute('SELECT sum(i*i::bigint) FROM generate_series(1,10000) i');q.fetchone()
            with open('/tmp/gps122-io.bin','wb') as f:f.write(memory[:1024**2]);f.flush();os.fsync(f.fileno())
        counter+=1
        time.sleep(.2)


def shared(enable):
    if not enable:
        for kind in ['other','av']:subprocess.run(['systemctl','stop','gps122-'+kind],check=False,capture_output=True)
        return
    sql("CREATE ROLE other122 LOGIN PASSWORD 'synthetic-only' CONNECTION LIMIT 24 NOSUPERUSER")
    sql('GRANT CONNECT ON DATABASE gps_closure_test TO other122')
    for kind,limit,cpu in [('other',1024,25),('av',675,25)]:
        text=f'''[Service]
ExecStart=/usr/bin/python3 /opt/gps121/load_runtime122.py pressure-{kind}
MemoryMax={limit}M
MemorySwapMax=0
CPUQuota={cpu}%
LimitCORE=0
NoNewPrivileges=yes
Environment=LD_PRELOAD=/usr/local/lib/gps-nodump.so
'''
        Path('/etc/systemd/system/gps122-'+kind+'.service').write_text(text)
    command('systemctl','daemon-reload')
    for kind in ['other','av']:command('systemctl','start','gps122-'+kind)
    for _ in range(100):
        if all(Path('/tmp/gps122-'+k+'-ready').exists() for k in ['other','av']):return
        time.sleep(.2)
    raise AssertionError('pressure fixture failed to start')


def load(label,seconds=300):
    data=b.fixture(); stop=threading.Event(); deadline=time.monotonic()+seconds
    done=[];attempts=[];ingest=[];health=[];pdf=[];cleanups=[];errors=[];resources=[];walks=[]
    secret_key=os.urandom(32); hardware='runtime122-'+uuid.uuid4().hex; iccid='89'+str(time.time_ns())[-17:]
    owner=data['users'][0]
    did=sql("INSERT INTO devices(owner_id,device_uid,iccid,api_key_hash) VALUES(%s,%s,%s,'') RETURNING id",(owner,hardware,iccid))[0][0]
    sql('INSERT INTO hardware_credentials(auth_uid,key_digest,authorized_owner_id) VALUES(%s,%s,%s)',(hardware,secret_key,owner))
    before=cgroups()
    db_before=sql('SELECT temp_bytes,temp_files,blk_read_time,blk_write_time FROM pg_stat_database WHERE datname=current_database()')[0]
    start_time=time.monotonic()

    def reader(index):
        client=Client(); d=data['devices'][index]; count=0;cursor=None;points=pages=0;walk_start=time.monotonic()
        while time.monotonic()<deadline and not stop.is_set():
            routes=b.routes(d['device_id'])
            choices=routes[:3] if index<4 else routes[2:]
            name,path=routes[2] if index==0 else choices[count%len(choices)]
            if index==0 and cursor:path+='&cursor='+quote(cursor)
            begin=time.monotonic()
            try:
                for attempt in range(3):
                    status,body,headers,elapsed=client.get(path,d['user_id'])
                    attempts.append(dict(route=name,status=status,seconds=elapsed))
                    if status!=429:break
                    retry=float(headers.get('retry-after','0'))
                    assert json.loads(body).get('code')=='location_read_busy' and 0<retry<=10
                    if attempt==2:break
                    if stop.wait(max(retry,2**attempt)+random.random()*.5):return
                done.append(dict(route=name,status=status,seconds=time.monotonic()-begin,device=index))
                if status==200 and index==0:
                    payload=json.loads(body);points+=len(payload['items']);pages+=1;cursor=payload['next_cursor']
                    if not payload['has_more']:
                        assert points==89280,(points,pages)
                        walks.append(dict(points=points,pages=pages,seconds=time.monotonic()-walk_start))
                        points=pages=0;cursor=None;walk_start=time.monotonic()
                assert status in (200,429),(name,status,body[:100])
            except Exception as e:errors.append(dict(reader=index,error=repr(e)[:200]))
            count+=1;stop.wait(.1)

    def report():
        client=Client();counter=0
        while time.monotonic()<deadline and not stop.is_set():
            counter+=1
            body=json.dumps(dict(device_uid=hardware,iccid=iccid,ts=counter,boot=1,l80=dict(fix=True,lat=37.123456,lng=127.654321,sat=12),cbc_mv=4100),separators=(',',':')).encode()
            signature=hmac.new(secret_key,f'{hardware}\n{counter}\n'.encode()+body,hashlib.sha256).hexdigest()
            headers={'Content-Type':'application/json','X-GPS-Auth-Version':'2','X-GPS-Uid':hardware,'X-GPS-Counter':str(counter),'X-GPS-Signature':signature}
            try:
                s,_,_,t=client.get('/gps-tracker/ingest',body=body,headers=headers);ingest.append(dict(status=s,seconds=t))
                s,_,_,t=client.get('/gps-tracker/health');health.append(dict(status=s,seconds=t))
            except Exception as e:errors.append(dict(background=repr(e)[:200]))
            stop.wait(1)

    def render():
        import test_runtime120_service as p
        while time.monotonic()<deadline and not stop.is_set():
            begin=time.monotonic()
            try:
                dimensions=p.page();pdf.append(dict(seconds=time.monotonic()-begin,dimensions=dimensions))
            except Exception as e:errors.append(dict(pdf=repr(e)[:200]))
            stop.wait(3)

    def cleanup():
        cfg=dict(DATABASE_URL=runtime(),GPS_LOCATION_ENCRYPTION='pilot',GPS_LOCATION_KEYRING_FILE=str(ROOT/'test-keys.json'),
            UPLOAD_DIR=str(ROOT/'test-storage/uploads'),PRIVATE_UPLOAD_DIR=str(ROOT/'test-storage/private'))
        while time.monotonic()<deadline and not stop.is_set():
            p=ROOT/'test-storage/uploads/device_documents/1/1'/('cleanup122-'+uuid.uuid4().hex+'.bin')
            try:
                p.write_bytes(b'GPSFILE1\n'+b'synthetic file cleanup workload');uid=pwd.getpwnam('gps-api').pw_uid;os.chown(p,uid,uid)
                qid=sql("INSERT INTO privacy_file_cleanup(storage_kind,storage_key,reason,source_table,source_id) VALUES('document',%s,'runtime122','synthetic',122) RETURNING id",(str(p),))[0][0]
                begin=time.monotonic();value=job('cleanup',worker=cfg)
                assert value['processed']['job_id']==qid and not p.exists(),value
                cleanups.append(dict(seconds=time.monotonic()-begin,state=value['processed']['state']))
            except Exception as e:errors.append(dict(cleanup=repr(e)[:200]))
            stop.wait(5)

    with ThreadPoolExecutor(max_workers=11) as executor:
        futures=[executor.submit(reader,i) for i in range(8)]+[executor.submit(f) for f in (report,render,cleanup)]
        while time.monotonic()<deadline:
            resources.append(dict(seconds=time.monotonic()-start_time,cgroups=cgroups(),connections=sql("SELECT usename,state,count(*) FROM pg_stat_activity WHERE backend_type='client backend' GROUP BY usename,state")))
            save(label+'-progress',dict(seconds=time.monotonic()-start_time,completed=len(done),errors=errors,resources=resources))
            print(label,round(time.monotonic()-start_time),'reads',len(done),'ingest',len(ingest),'PDF',len(pdf),'cleanup',len(cleanups),'errors',len(errors),flush=True)
            if errors:break
            time.sleep(min(10,max(.1,deadline-time.monotonic())))
        stop.set()
        for f in futures:f.result()
    after=cgroups();db_after=sql('SELECT temp_bytes,temp_files,blk_read_time,blk_write_time FROM pg_stat_database WHERE datname=current_database()')[0]
    grouped=defaultdict(list)
    for x in done:grouped[x['route']].append(x)
    result=dict(label=label,seconds=seconds,elapsed=time.monotonic()-start_time,workers=8,api_sha256=b.SHA,
        statuses=dict(Counter(x['status'] for x in done)),attempts=dict(Counter(x['status'] for x in attempts)),
        per_route={k:dict(statuses=dict(Counter(x['status'] for x in v)),latency=b.stats([x['seconds'] for x in v if x['status']==200])) for k,v in grouped.items()},
        ingest=dict(statuses=dict(Counter(x['status'] for x in ingest)),latency=b.stats([x['seconds'] for x in ingest])),
        health=dict(statuses=dict(Counter(x['status'] for x in health)),latency=b.stats([x['seconds'] for x in health])),
        pdf=dict(completed=len(pdf),latency=b.stats([x['seconds'] for x in pdf])),cleanup=dict(completed=len(cleanups),latency=b.stats([x['seconds'] for x in cleanups])),
        full_month_traversals=walks,errors=errors,resources=resources,before=before,after=after,
        db_io_delta=dict(zip(['temp_bytes','temp_files','read_ms','write_ms'],[y-x for x,y in zip(db_before,db_after)])),
        saved_ingest=sql('SELECT count(*) FROM location_records WHERE device_id=%s',(did,))[0][0],production_modified=False)
    save(label,result)
    assert not errors,errors[:5]
    assert ingest and all(x['status']==200 for x in ingest) and result['saved_ingest']==len(ingest)
    assert health and all(x['status']==200 for x in health)
    assert len(pdf)>=10 and len(cleanups)>=10
    for label2 in ['gps','db','api','pdf','container']:
        event=lambda x:dict(line.split() for line in x['memory.events'].splitlines())
        assert event(before[label2])['oom_kill']==event(after[label2])['oom_kill']
        assert after[label2]['memory.swap.current']=='0'
    print('PASS sustained concurrent workload',label,flush=True)


if __name__=='__main__':
    action=sys.argv[1]
    if action=='seed':seed()
    elif action=='dedicated':load('dedicated-4g')
    elif action=='shared':shared(True);load('shared-6g');shared(False)
    elif action.startswith('pressure-'):pressure(action.split('-',1)[1])
    elif action=='probe':b.probe()
    else:raise ValueError(action)
