"""Compile the actual sketch printf format into a synthetic request for the isolated Shield preview."""
import importlib.util,json,re,secrets,time,urllib.parse
from pathlib import Path
ROOT=Path('/home/etcom-hub/build/gps-tracker/shield-platform')
spec=importlib.util.spec_from_file_location('integration',ROOT/'ops/shield/test-integration.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
assert c.BASE=='http://127.0.0.1:3043' and c.sql('select current_database()')=='shield_test'
source=(Path(__file__).resolve().parents[1]/'04_shield_upload/04_shield_upload.ino').read_text()
section=re.search(r'int\s+n\s*=\s*snprintf_P([\s\S]*?)SHIELD_UID\s*,\s*millis\(\)',source)[1]
template=''.join(json.loads(s) for s in re.findall(r'"(?:\\.|[^"\\])*"',section)).replace('%lu','%d')
owner,anon=c.Client(),c.Client();suffix=secrets.token_hex(5)
assert owner.call('/api/auth/register',{'email':f'example-{suffix}@example.test','password':secrets.token_urlsafe(24),
    'display_name':'Example contract fixture','invite_code':c.cli('invite')['invite_code']})[0]==200
device=c.cli('provision','UNO example synthetic fixture')
identifier=owner.call('/api/devices/claim',{'claim_code':device['claim_code'],'display_name':'UNO example test'})[1]['id']
now=int(time.time());raw=template%(device['device_uid'],100,20,5,now,'24.8','58.0')
assert len(raw)<448;payload=json.loads(raw)
assert anon.call('/ingest/shield',payload)[0]==401
status,result,_=anon.call('/ingest/shield',payload,{'X-Device-Key':device['device_key']})
assert status==200,(status,result)
period=urllib.parse.urlencode({'since':c.iso(now-60),'until':c.iso(now+5)})
status,data,_=owner.call(f'/api/devices/{identifier}/summary?{period}')
assert status==200 and '24.8' in json.dumps(data) and 'temperature' in json.dumps(data) and 'humidity' in json.dumps(data)
assert owner.call('/api/auth/logout',{})[0]==200
print('Actual UNO payload template: authentication, ingest and owner sensor summary passed; preview only')
