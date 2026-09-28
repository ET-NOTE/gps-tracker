#!/usr/bin/env python3
"""Approved launch checks: only disposable Shield fixtures; never SIM billing.

Run as root on the VPS. `cleanup` deletes only the recorded synthetic fixture.
Secrets stay in a mode-0600 file, outside the release and source repositories.
"""
import argparse
import base64
import datetime as dt
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import pwd
import secrets
import socket
import ssl
import struct
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

BASE='https://shield.serial.kr'
ROOT=Path('/home/mmm/shield-deploy')
FIXTURE=ROOT/'launch-fixture.json'
checks=[]

def pg(sql,db='shield_prod'):
    return subprocess.check_output(['sudo','-u','postgres','psql','-XAt','-v','ON_ERROR_STOP=1','-d',db],input=sql,text=True).strip()

def envfile():
    return dict(line.split('=',1) for line in Path('/etc/shield-api/shield.env').read_text().splitlines() if line and not line.startswith('#'))

def cli(*args):
    u=pwd.getpwnam('gps-shield')
    def demote():
        os.setgroups([]);os.setgid(u.pw_gid);os.setuid(u.pw_uid)
    output=subprocess.check_output(['/srv/shield/current/shield-api',*args],env={**os.environ,**envfile()},cwd='/srv/shield/current',preexec_fn=demote,text=True)
    return json.loads(output)

def check(name,value):
    assert value,name
    checks.append(name);print('PASS '+name,flush=True)

class Client:
    def __init__(self):
        self.cookies=http.cookiejar.CookieJar()
        self.opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))
    def call(self,path,data=None,headers=None):
        h={'Origin':BASE,**(headers or {})}
        if data is not None:h['Content-Type']='application/json'
        req=urllib.request.Request(BASE+path,headers=h,data=json.dumps(data).encode() if data is not None else None)
        try:r=self.opener.open(req,timeout=15)
        except urllib.error.HTTPError as e:r=e
        body=r.read().decode()
        try:body=json.loads(body)
        except json.JSONDecodeError:pass
        return r.status,body,dict(r.headers)

class WS:
    def __init__(self,client,origin=BASE):
        self.sock=ssl.create_default_context().wrap_socket(socket.create_connection(('shield.serial.kr',443),timeout=5),server_hostname='shield.serial.kr')
        self.stream=self.sock.makefile('rb',buffering=0)
        cookies='; '.join(f'{c.name}={c.value}' for c in client.cookies)
        key=base64.b64encode(secrets.token_bytes(16)).decode()
        self.sock.sendall((f'GET /api/ws HTTP/1.1\r\nHost: shield.serial.kr\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: {origin}\r\nCookie: {cookies}\r\n\r\n').encode())
        self.status=int(self.stream.readline().split()[1])
        while self.stream.readline() not in (b'\r\n',b''):pass
    def read(self,n):
        data=b''
        while len(data)<n:
            part=self.stream.read(n-len(data))
            if not part:raise EOFError()
            data+=part
        return data
    def event(self,timeout=5):
        self.sock.settimeout(timeout)
        while True:
            try:first=self.read(2)
            except EOFError:return 'closed'
            opcode=first[0]&15;length=first[1]&127
            if length==126:length=struct.unpack('!H',self.read(2))[0]
            if length==127:length=struct.unpack('!Q',self.read(8))[0]
            assert length<=8192
            data=self.read(length)
            if opcode==8:return 'closed'
            if opcode==9:
                mask=secrets.token_bytes(4)
                self.sock.sendall(bytes([0x8a,0x80|length])+mask+bytes(c^mask[i%4] for i,c in enumerate(data)))
            if opcode==1:return json.loads(data)
    def close(self):self.stream.close();self.sock.close()

def isolation():
    cfg=urllib.parse.urlparse(envfile()['SHIELD_DATABASE_URL'])
    check('dedicated database and role',cfg.path=='/shield_prod' and cfg.username=='shield_app')
    databases=pg("SELECT datname FROM pg_database WHERE datname LIKE 'gps_tracker%' ORDER BY datname;",'postgres').splitlines()
    for db in databases:
        result=subprocess.run(['psql','-XAt','-h','127.0.0.1','-U','shield_app','-d',db,'-c','select 1'],env={**os.environ,'PGPASSWORD':cfg.password,'PGCONNECT_TIMEOUT':'3'},text=True,capture_output=True)
        check('Shield rejected from '+db,result.returncode!=0 and 'pg_hba.conf rejects' in result.stderr)
    for role in ('gps_tracker_app','gps_tracker_dev_app'):
        check(role+' cannot connect to Shield',pg(f"SELECT has_database_privilege('{role}','shield_prod','CONNECT');")=='f')
    check('no Shield cluster admin privileges',pg("SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname='shield_app';")=='f')

def save_fixture(f):
    with os.fdopen(os.open(FIXTURE,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600),'w') as stream:json.dump(f,stream,indent=2)
    u=pwd.getpwnam('mmm');os.chown(FIXTURE,u.pw_uid,u.pw_gid)

def smoke():
    assert not FIXTURE.exists(),'Existing fixture requires inspection, not blind recreation'
    isolation()
    anon=Client()
    for path in ('/','/data','/examples','/usim','/downloads/send_sample.py'):
        check('HTTPS route '+path,anon.call(path)[0]==200)
    check('anonymous readings rejected',anon.call('/api/devices')[0]==401)
    a,b=Client(),Client()
    suffix=secrets.token_hex(6)
    f={'email':f'launch-smoke-{suffix}@example.test','other_email':f'launch-other-{suffix}@example.test','password':secrets.token_urlsafe(28),'invites':[]}
    save_fixture(f)
    for client,email in ((a,f['email']),(b,f['other_email'])):
        invite=cli('invite')['invite_code'];f['invites'].append(hashlib.sha256(invite.encode()).hexdigest());save_fixture(f)
        status,body,headers=client.call('/api/auth/register',{'email':email,'password':f['password'],'display_name':'배포 검증 · 합성 데이터','invite_code':invite})
        cookie=next((v for k,v in headers.items() if k.lower()=='set-cookie'),'')
        check('production invite and secure host cookie',status==200 and '__Host-shield_session=' in cookie and 'Secure' in cookie and 'HttpOnly' in cookie and 'SameSite=Strict' in cookie and 'Domain=' not in cookie)
    check('cross-domain mutation rejected',a.call('/api/auth/logout',{}, {'Origin':'https://gps.serial.kr'})[0]==403)
    device=cli('provision','배포 검증 전용 · 합성 데이터');f['device']=device;save_fixture(f)
    status,claimed,_=a.call('/api/devices/claim',{'claim_code':device['claim_code'],'display_name':'배포 검증 전용 · 합성 데이터'})
    check('production device claim',status==200);f['device_id']=claimed['id'];save_fixture(f)
    foreign=WS(a,'https://gps.serial.kr');check('foreign WebSocket origin rejected',foreign.status==401);foreign.close()
    wa,wb=WS(a),WS(b);check('authenticated WSS upgraded',wa.status==101 and wb.status==101)
    now=int(time.time())
    payload={'shield_v':2,'device_uid':device['device_uid'],'build_tag':'shield-launch-synthetic','ts':1,'csq':20,'reg':5,'diag':{'pv_mv':3300,'gnss':1},'points':[[now-10+i*2,37566500+i*50,126978000,8] for i in range(5)],'sensors':[{'at':now-2,'temp_c':24.8,'hum_pct':58}]}
    key={'X-Device-Key':device['device_key']}
    check('keyless ingest rejected',anon.call('/ingest/shield',payload)[0]==401)
    status,body,_=anon.call('/ingest/shield',payload,key)
    check('authenticated GPS and sensor ingest',status==200 and body['accepted']==5)
    check('owning account receives WSS event',wa.event()=={'kind':'device_changed','device_id':f['device_id']})
    try:wb.event(0.5);raise AssertionError('Cross-account WebSocket leak')
    except TimeoutError:check('other account receives no event',True)
    check('retry deduplicated',anon.call('/ingest/shield',payload,key)[1]['duplicate'] is True)
    iso=lambda n:dt.datetime.fromtimestamp(n,dt.timezone.utc).isoformat()
    period=urllib.parse.urlencode({'since':iso(now-3600),'until':iso(now+1)})
    for endpoint in ('summary','readings','locations'):
        path=f"/api/devices/{f['device_id']}/{endpoint}?{period}"
        check('owner can read '+endpoint,a.call(path)[0]==200)
        check('other account cannot read '+endpoint,b.call(path)[0]==404)
    check('logout succeeds',a.call('/api/auth/logout',{})[0]==200)
    payload['ts']=2
    check('status retry accepted',anon.call('/ingest/shield',payload,key)[0]==200)
    check('revoked session closes stream',wa.event()=='closed')
    check('logged-out REST rejected',a.call('/api/devices')[0]==401)
    wa.close();wb.close()
    (ROOT/'launch-results.json').write_text(json.dumps({'passed':len(checks),'checks':checks},indent=2))
    print(json.dumps({'passed':len(checks),'fixture_file':str(FIXTURE)}))

def cleanup():
    f=json.loads(FIXTURE.read_text())
    # Exact generated identities, never a wildcard delete or an account supplied by a user.
    import re
    for email in (f['email'],f['other_email']):assert re.fullmatch(r'launch-(smoke|other)-[0-9a-f]{12}@example\.test',email)
    ids=','.join("'"+s+"'" for s in (f['email'],f['other_email']))
    assert pg(f'SELECT count(*) FROM users WHERE email IN ({ids});')=='2'
    pg(f'''BEGIN;
DELETE FROM daily_stats WHERE device_id IN (SELECT id FROM devices WHERE owner_id IN (SELECT id FROM users WHERE email IN ({ids})));
DELETE FROM devices WHERE owner_id IN (SELECT id FROM users WHERE email IN ({ids}));
DELETE FROM invites WHERE consumed_by IN (SELECT id FROM users WHERE email IN ({ids}));
DELETE FROM users WHERE email IN ({ids});
COMMIT;''')
    FIXTURE.unlink()
    print('Only the two recorded synthetic accounts and their test device/data removed')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('step',choices=['smoke','isolation','cleanup']);args=parser.parse_args()
    assert os.geteuid()==0
    {'smoke':smoke,'isolation':isolation,'cleanup':cleanup}[args.step]()
