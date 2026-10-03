#!/usr/bin/env python3
"""Read-only post-upgrade checks apart from routine login/logout; no topup calls."""
import importlib.util
import json
from pathlib import Path
import subprocess
import urllib.error
import urllib.request

ROOT=Path('/home/mmm/shield-deploy')
spec=importlib.util.spec_from_file_location('checks',ROOT/'verify-production.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)

def main():
    a=json.loads((ROOT/'admin-enrollment.json').read_text())
    u=json.loads((ROOT/'bench-enrollment.json').read_text())
    admin,user=c.Client(),c.Client()
    for client,identity in [(admin,a),(user,u)]:
        assert client.call('/api/auth/login',{'email':identity['email'],'password':identity['password']})[0]==200
    try:
        c.check('normal owner retains user role',user.call('/api/auth/session')[1]['role']=='user')
        c.check('administrator uses normal login',admin.call('/api/auth/session')[1]['role']=='admin')
        c.check('normal user cannot read admin',user.call('/api/admin/users')[0]==403)
        for path in ['overview','posts','users','devices','audit']:
            c.check('admin '+path,admin.call('/api/admin/'+path)[0]==200)
        c.check('published dynamic sensor guide',any(p['id']=='dynamic-sensors' for p in user.call('/api/posts')[1]))
        sim=user.call(f"/api/devices/{int(u['device_id'])}/usim")[1]
        c.check('provider connected for read and future explicit execution',sim['provider']['configured'] and sim['provider']['topup_enabled'])
        c.check('actual SIM quota cached',sim['sim']['usage'] is not None and sim['sim']['usage']['remaining_mb']>=0 and not sim['sim']['error'])
        c.check('no production topup request created',c.pg('SELECT count(*) FROM sim_requests')=='0')
        c.check('no production point adjustment or charge',c.pg('SELECT count(*) FROM credit_entries')=='0')
        c.check('administrator bootstrap audited',c.pg("SELECT count(*) FROM audit_log WHERE action='admin.bootstrap'")=='1')
        c.check('legacy bench has no GPS SIM or pending order',c.pg("SELECT iccid IS NULL FROM devices WHERE id=3015 AND device_uid='uno-shield-test'",'gps_tracker')=='t' and c.pg('SELECT count(*) FROM sim_topup_requests WHERE device_id=3015','gps_tracker')=='0')
        for url in ['http://gps.serial.kr/ingest/shield','https://gps.serial.kr/ingest/shield','https://gps.serial.kr/api/v1/shield-monitor/devices','https://dev-gps.serial.kr/ingest/shield','https://dev-gps.serial.kr/gps-tracker/api/v1/shield-monitor/devices','https://seriallog.com/gps-tracker/api/v1/shield-monitor/devices']:
            try:response=urllib.request.urlopen(url,timeout=10)
            except urllib.error.HTTPError as e:response=e
            c.check('retired Shield route '+url,response.status in ((404,410) if 'seriallog.com' in url else (410,)))
        alias=subprocess.check_output(['curl','--silent','--output','/dev/null','--write-out','%{http_code}','--resolve','seriallog.com:443:127.0.0.1','https://seriallog.com/gps-tracker/api/v1/shield-monitor/devices'],text=True)
        c.check('legacy alias explicitly closed on this VPS',alias=='410')
        for url in ['https://gps.serial.kr/arduino-shield','https://dev-gps.serial.kr/arduino-shield']:
            with urllib.request.urlopen(url,timeout=10) as response:c.check('legacy page redirect '+url,response.status==200 and response.url=='https://shield.serial.kr/data')
        print(json.dumps({'passed':len(c.checks),'remaining_mb':sim['sim']['usage']['remaining_mb'],'total_mb':sim['sim']['usage']['total_mb'],'quota_updated_at':sim['sim']['updated_at'],'cost_credits':sim['cost_credits'],'topup_calls':0}))
    finally:
        for client in [admin,user]:assert client.call('/api/auth/logout',{})[0]==200

if __name__=='__main__':main()
