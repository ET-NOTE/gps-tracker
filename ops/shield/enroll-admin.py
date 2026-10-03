#!/usr/bin/env python3
"""Create the requested separate Shield administrator using the normal signup.

Resumable private credentials, no copied GPS password, no ownership or credits
changed, and no provider purchase endpoints are invoked.
"""
import importlib.util
import json
import os
from pathlib import Path
import pwd
import secrets

ROOT=Path('/home/mmm/shield-deploy')
STATE=ROOT/'admin-enrollment.json'
spec=importlib.util.spec_from_file_location('checks',ROOT/'verify-production.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)

def save(v):
    with os.fdopen(os.open(STATE,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600),'w') as f:json.dump(v,f,indent=2)
    u=pwd.getpwnam('mmm');os.chown(STATE,u.pw_uid,u.pw_gid)

def main():
    assert os.geteuid()==0
    if STATE.exists():v=json.loads(STATE.read_text())
    else:
        assert c.pg("SELECT count(*) FROM users WHERE email='admin@user.com'")=='0'
        v={'email':'admin@user.com','password':secrets.token_urlsafe(24),'phase':'prepared'};save(v)
    client=c.Client()
    if c.pg("SELECT count(*) FROM users WHERE email='admin@user.com'")=='0':
        code=c.cli('invite')['invite_code']
        assert client.call('/api/auth/register',{'email':v['email'],'password':v['password'],'display_name':'Shield 관리자','invite_code':code})[0]==200
    assert client.call('/api/auth/login',{'email':v['email'],'password':v['password']})[0]==200
    if client.call('/api/auth/session')[1]['role']!='admin':c.cli('grant-admin',v['email'])
    assert client.call('/api/auth/login',{'email':v['email'],'password':v['password']})[0]==200
    session=client.call('/api/auth/session')[1];assert session['role']=='admin'
    v.update(user_id=session['id'],phase='admin');save(v)
    assert client.call('/api/admin/users')[0]==200
    assert client.call('/api/admin/posts')[0]==200
    assert client.call('/api/auth/logout',{})[0]==200
    print(json.dumps({'email':v['email'],'role':'admin','password':'saved privately','user_id':v['user_id']}))

if __name__=='__main__':main()
