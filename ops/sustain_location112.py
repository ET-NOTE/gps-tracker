"""Bounded sustained HTTP load in the fixed private synthetic query112 network.

Real TLS1.2 + signed ingest + restricted API, concurrent heavy month queries,
full cursor traversal and daily statistics worker. Never accepts a remote DSN.
"""
import argparse
import concurrent.futures
import hashlib
import hmac
import json
import os
import pathlib
import shutil
import ssl
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from benchmark_location112 import DB, JOB, NET, OUT, connect, info, run, save
from load_location112 import API, token, stats

PROXY='gps-query112-proxy'


def tls_setup():
    assert info('network',NET)['Internal']
    directory=JOB/'tls-fixture'; directory.mkdir(exist_ok=True)
    subnet=info('network',NET)['IPAM']['Config'][0]['Subnet']
    address=subnet.rsplit('.',1)[0]+'.10'
    run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','2',
        '-keyout',str(directory/'key.pem'),'-out',str(directory/'cert.pem'),
        '-subj','/CN=GPS isolated query112','-addext','subjectAltName=IP:'+address,
        stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    os.chmod(directory/'key.pem',0o600)
    api=info('container',API)['NetworkSettings']['Networks'][NET]['IPAddress']
    (directory/'nginx.conf').write_text(f'''pid /tmp/nginx.pid; events {{}} http {{
      access_log off; client_body_temp_path /tmp/client; proxy_temp_path /tmp/proxy;
      fastcgi_temp_path /tmp/fastcgi; uwsgi_temp_path /tmp/uwsgi; scgi_temp_path /tmp/scgi;
      server {{ listen 8443 ssl; ssl_protocols TLSv1.2 TLSv1.3;
       ssl_certificate /fixture/cert.pem; ssl_certificate_key /fixture/key.pem;
       location / {{ proxy_pass http://{api}:3043; proxy_read_timeout 180s;
        proxy_set_header X-GPS-TLS-Version $ssl_protocol; }} }} }}''')
    run('docker','run','-d','--name',PROXY,'--network',NET,'--ip',address,
        '--cpus=.25','--memory=64m','--user',f'{os.getuid()}:{os.getgid()}',
        '--cap-drop=ALL','--security-opt=no-new-privileges',
        '-v',f'{directory}:/fixture:ro','nginx:stable-alpine',
        'nginx','-c','/fixture/nginx.conf','-g','daemon off;',stdout=subprocess.DEVNULL)
    context=ssl.create_default_context(cafile=str(directory/'cert.pem'))
    for _ in range(30):
        try:
            with urllib.request.urlopen('https://'+address+':8443/gps-tracker/health',context=context,timeout=3) as r:
                if r.status==200:return address
        except (OSError,urllib.error.URLError):time.sleep(1)
        assert info('container',PROXY)['State']['Running'], 'isolated TLS proxy exited'
    raise RuntimeError('isolated TLS proxy readiness timeout')


def load(label,seconds,workers):
    assert 30<=seconds<=1800 and 4<=workers<=16
    assert shutil.disk_usage(JOB).free>3*1024**3
    assert info('network',NET)['Internal']
    api=info('container',API)
    assert not api['HostConfig']['PortBindings']
    actual=subprocess.check_output(['docker','exec',API,'sha256sum','/proc/1/exe']).decode().split()[0]
    assert actual==hashlib.sha256((OUT/'gps-tracker-api').read_bytes()).hexdigest()
    origin='http://'+api['NetworkSettings']['Networks'][NET]['IPAddress']+':3043'
    proxy=info('container',PROXY)['NetworkSettings']['Networks'][NET]['IPAddress']
    tls=ssl.create_default_context(cafile=str(JOB/'tls-fixture/cert.pem'))
    tls.minimum_version=tls.maximum_version=ssl.TLSVersion.TLSv1_2
    fixture=json.loads((OUT/'fixture.json').read_text())
    uid,did=fixture['user_id'],fixture['device_id']
    auth=token(uid)
    root=f'/gps-tracker/api/v1/devices/{did}/locations'
    month='since=2026-10-01T00:00:00Z&until=2026-11-01T00:00:00Z'
    routes=[('month_aggregate',root+'/aggregated?'+month+'&bucket=1h'),
      ('month_history',root+'?'+month+'&limit=10000'),
      ('day_aggregate',root+'/aggregated?since=2026-10-10T00:00:00Z&until=2026-10-11T00:00:00Z&bucket=5m'),
      ('latest',root+'/latest')]
    secret=os.urandom(32)
    hardware='query112-'+str(time.time_ns())
    iccid='89'+str(time.time_ns())[-17:]
    with connect() as db:
        settings=dict(db.execute("SELECT name,setting FROM pg_settings WHERE name IN ('max_connections','work_mem','shared_buffers','jit')").fetchall())
        assert int(settings['max_connections'])==50
        ingest_did=db.execute("INSERT INTO devices(device_uid,iccid,api_key_hash,owner_id) VALUES(%s,%s,'',%s) RETURNING id",(hardware,iccid,uid)).fetchone()[0]
        db.execute('INSERT INTO hardware_credentials(auth_uid,key_digest,authorized_owner_id) VALUES(%s,%s,%s)',(hardware,secret,uid))
        before=db.execute('SELECT temp_bytes,temp_files FROM pg_stat_database WHERE datname=current_database()').fetchone()
    rows=[];errors=[];health=[];ingest=[];resources=[];traversals=[];busy=[]
    stop=threading.Event(); begun=time.monotonic(); deadline=begun+seconds

    def request(path,body=None,headers=None,secure=False):
        req=urllib.request.Request(('https://'+proxy+':8443' if secure else origin)+path,data=body,
            headers=headers or {'Authorization':'Bearer '+auth})
        start=time.monotonic()
        try:
            response=urllib.request.urlopen(req,timeout=180,context=tls if secure else None)
        except urllib.error.HTTPError as e: response=e
        with response:
            result=response.read();status=response.status
        return status,result,time.monotonic()-start

    # Check the TLS gate and signature before the timed workload.
    def wire(counter):
        body=json.dumps({'device_uid':hardware,'iccid':iccid,'ts':counter,'boot':1,
          'l80':{'fix':True,'lat':37.12345678,'lng':127.87654321,'sat':12},'cbc_mv':4100},separators=(',',':')).encode()
        signature=hmac.new(secret,f'{hardware}\n{counter}\n'.encode()+body,hashlib.sha256).hexdigest()
        return body,{'Content-Type':'application/json','X-GPS-Auth-Version':'2','X-GPS-Uid':hardware,
          'X-GPS-Counter':str(counter),'X-GPS-Signature':signature}
    body,headers=wire(1)
    assert request('/gps-tracker/ingest',body,headers)[0]==426
    assert request('/gps-tracker/ingest',body,{**headers,'X-GPS-TLS-Version':'TLSv1.2'})[0]==426
    assert request('/gps-tracker/ingest',body,headers,True)[0]==200
    assert request('/gps-tracker/ingest',body,headers,True)[0]==409
    assert request('/gps-tracker/ingest',body+b' ',headers,True)[0]==401

    compatibility=[]
    for name,path in routes+[('grouped',root+'?'+month+'&limit=100&grouped=true'),('filtered',root+'?'+month+'&limit=100&source=l80&fix_only=true')]:
        status,body,_=request(path)
        assert status==200
        decoded=json.loads(body)
        compatibility.append({'route':name,'sha256':hashlib.sha256(json.dumps(decoded,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'items':len(decoded) if isinstance(decoded,list) else 1})
    save(label+'-http-oracle.json',compatibility)
    begun=time.monotonic();deadline=begun+seconds

    def query_worker(index):
        cursor=None;page_count=0;point_count=0;cycle_start=time.monotonic()
        i=0
        while time.monotonic()<deadline and not stop.is_set():
            # One worker walks the entire month; remaining workers mix full
            # monthly aggregates/history and interactive requests evenly.
            if index==0:
                name='month_page'
                path=root+'/page?'+month+'&limit=5000'+('&cursor='+urllib.parse.quote(cursor) if cursor else '')
            else: name,path=routes[(index+i)%len(routes)]
            try:
                status,body,elapsed=request(path)
                if status==429:
                    assert 'error' in json.loads(body)
                    busy.append({'route':name,'seconds':elapsed,'at_s':time.monotonic()-begun})
                    stop.wait(.7+(index%5)*.17)
                    continue
                assert status==200, f'HTTP {status}'
                parsed=json.loads(body)
                assert parsed is not None and parsed!=[]
                rows.append({'route':name,'seconds':elapsed,'bytes':len(body),'at_s':time.monotonic()-begun})
                if index==0:
                    page_count+=1;point_count+=len(parsed['items']);cursor=parsed['next_cursor']
                    if not parsed['has_more']:
                        assert point_count==fixture['unique_points'], (point_count,fixture['unique_points'])
                        traversals.append({'pages':page_count,'points':point_count,'seconds':time.monotonic()-cycle_start})
                        page_count=point_count=0;cursor=None;cycle_start=time.monotonic()
            except Exception as e:
                errors.append({'route':name,'error':type(e).__name__,'detail':str(e)[:120]})
            i+=1

    def background():
        counter=1
        while not stop.is_set():
            try:
                counter+=1;body,headers=wire(counter)
                status,body,elapsed=request('/gps-tracker/ingest',body,headers,True)
                assert status==200, f'ingest HTTP {status}'
                ingest.append(elapsed)
                status,body,elapsed=request('/gps-tracker/health',headers={})
                assert status==200 and json.loads(body)['db']
                health.append(elapsed)
            except Exception as e: errors.append({'background':type(e).__name__,'detail':str(e)[:120]})
            stop.wait(1)

    def monitor():
        with connect() as db:
            while not stop.is_set():
                try:
                    values=db.execute("SELECT count(*),count(*) FILTER(WHERE state='active') FROM pg_stat_activity WHERE datname=current_database()").fetchone()
                    snap=[]
                    for name in (DB,API,PROXY):
                        raw=info('container',name)
                        # cgroup measurements from Docker; no process env/logs.
                        data=json.loads(subprocess.check_output(['docker','stats','--no-stream','--format','{{json .}}',name]))
                        snap.append({'name':name,'cpu':data['CPUPerc'],'memory':data['MemUsage'],'block_io':data['BlockIO'],
                          'oom':raw['State']['OOMKilled'],'restarts':raw['RestartCount']})
                    resources.append({'at_s':time.monotonic()-begun,'connections':list(values),'containers':snap,'free_bytes':shutil.disk_usage(JOB).free})
                    print('PROGRESS',label,'seconds',round(time.monotonic()-begun),'queries',len(rows),'ingest',len(ingest),'errors',len(errors),flush=True)
                    if resources[-1]['free_bytes']<2*1024**3:
                        errors.append({'disk':'less than 2GiB'});stop.set()
                except Exception as e: errors.append({'monitor':type(e).__name__})
                stop.wait(15)

    threads=[threading.Thread(target=background),threading.Thread(target=monitor)]
    for thread in threads: thread.start()
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            list(pool.map(query_worker,range(workers)))
    finally:
        stop.set()
        for thread in threads: thread.join()
    with connect() as db:
        physical=db.execute('SELECT count(*),count(*) FILTER(WHERE lat IS NOT NULL OR lng IS NOT NULL OR raw IS NOT NULL OR fixes_jsonb IS NOT NULL),bool_and(query_bounds_ready) FROM location_records WHERE device_id=%s',(ingest_did,)).fetchone()
        after=db.execute('SELECT temp_bytes,temp_files FROM pg_stat_database WHERE datname=current_database()').fetchone()
        daily=db.execute('SELECT count(*) FROM daily_stats WHERE device_id=%s AND user_id=%s',(ingest_did,uid)).fetchone()[0]
    if physical!=(len(ingest)+1,0,True):errors.append({'physical_storage':list(physical),'ingest':len(ingest)})
    report={'label':label,'api_sha256':actual,'target_duration_s':seconds,'duration_s':time.monotonic()-begun,
      'workers':workers,'http':{name:stats([r['seconds'] for r in rows if r['route']==name]) for name in [*dict(routes),'month_page']},
      'requests':len(rows),'errors':errors,'busy_responses':busy,'health':stats(health),'signed_tls12_ingest':stats(ingest),
      'physical_ciphertext_rows':physical[0],'physical_plaintext_rows':physical[1],'daily_stats_rows':daily,
      'traversals':traversals,'resources':resources,'raw':rows,'pg_settings':settings,
      'temp_bytes_delta':after[0]-before[0],'temp_files_delta':after[1]-before[1],
      'security_preflight':['direct HTTP denied','spoofed TLS header denied','TLS1.2 signed request accepted','replay denied','tamper denied'],
      'scope':'synthetic private Docker network on build-host NVMe, production DB settings and explicit CPU/memory budgets; not LTE nor production storage IO',
      'production_modified':False,'external_delivery':False}
    save(label+'-sustained.json',report)
    assert not errors, errors[:10]
    assert health and ingest and resources and rows
    assert all(not c['oom'] and c['restarts']==0 for r in resources for c in r['containers'])
    print('SUSTAIN PASS',label,'requests',len(rows),'ingest',len(ingest),'traversals',len(traversals),flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('action',choices=['tls','load']);p.add_argument('--label',default='final112')
    p.add_argument('--seconds',type=int,default=900);p.add_argument('--workers',type=int,default=8);a=p.parse_args()
    print(tls_setup()) if a.action=='tls' else load(a.label,a.seconds,a.workers)
