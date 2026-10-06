#!/usr/bin/env python3
"""User-approved enrollment of the existing UNO bench into independent Shield.

Creates a new password; never copies GPS credentials. No SIM charge is called.
The private state permits safe resumption after an uncertain API response.
"""
import importlib.util
import json
import os
from pathlib import Path
import pwd
import secrets

ROOT=Path('/home/mmm/shield-deploy')
STATE=ROOT/'bench-enrollment.json'
spec=importlib.util.spec_from_file_location('checks',ROOT/'verify-production.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)

def save(v):
    with os.fdopen(os.open(STATE,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600),'w') as f:json.dump(v,f,indent=2)
    u=pwd.getpwnam('mmm');os.chown(STATE,u.pw_uid,u.pw_gid)

def main():
    assert os.geteuid()==0
    old=json.loads(c.pg("SELECT json_build_object('id',d.id,'device_uid',d.device_uid,'owner_email',u.email,'last_seen_at',d.last_seen_at) FROM devices d JOIN users u ON u.id=d.owner_id WHERE d.device_uid='uno-shield-test';",'gps_tracker'))
    assert old['id']==3015 and old['owner_email']=='user@user.com'
    if STATE.exists():v=json.loads(STATE.read_text())
    else:
        assert c.pg("SELECT count(*) FROM users WHERE email='user@user.com';")=='0','Existing Shield account requires owner verification'
        v={'email':'user@user.com','password':secrets.token_urlsafe(20),'source_device':old,'phase':'prepared'};save(v)
    client=c.Client()
    if c.pg("SELECT count(*) FROM users WHERE email='user@user.com';")=='0':
        invitation=json.loads((ROOT/'owner-invitation.json').read_text())
        code=invitation['invite_code']
        status,_,_=client.call('/api/auth/register',{'email':v['email'],'password':v['password'],'display_name':'쉴드 테스트','invite_code':code})
        assert status==200,f'Registration status {status}'
    else:
        assert client.call('/api/auth/login',{'email':v['email'],'password':v['password']})[0]==200
    v['user_id']=client.call('/api/auth/session')[1]['id'];v['phase']='registered';save(v)
    if 'device' not in v:
        v['device']=c.cli('provision','실물 Arduino 쉴드');save(v)
    owned=client.call('/api/devices')[1]
    match=[d for d in owned if d['device_uid']==v['device']['device_uid']]
    if not match:
        status,claimed,_=client.call('/api/devices/claim',{'claim_code':v['device']['claim_code'],'display_name':'실물 Arduino 쉴드'})
        assert status==200,f'Claim status {status}'
        v['device_id']=claimed['id']
    else:v['device_id']=match[0]['id']
    v['phase']='claimed';save(v)
    assert client.call('/api/auth/logout',{})[0]==200
    print(json.dumps({'email':v['email'],'user_id':v['user_id'],'device_id':v['device_id'],'phase':v['phase'],'password':'saved privately, not printed'}))

if __name__=='__main__':main()
