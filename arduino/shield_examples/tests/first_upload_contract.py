"""Check the actual first-upload printf template against the isolated preview, never production."""
import importlib.util,json,re,secrets,time,urllib.parse
from pathlib import Path
ROOT=Path('/home/etcom-hub/build/gps-tracker/shield-platform')
spec=importlib.util.spec_from_file_location('integration',ROOT/'ops/shield/test-integration.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
assert c.BASE=='http://127.0.0.1:3043' and c.sql('select current_database()')=='shield_test'
source=(Path(__file__).resolve().parents[1]/'06_first_upload/06_first_upload.ino').read_text()
section=re.search(r'int\s+n\s*=\s*snprintf_P([\s\S]*?)SHIELD_UID\s*,\s*millis\(\)',source)[1]
template=''.join(json.loads(s) for s in re.findall(r'"(?:\\.|[^"\\])*"',section)).replace('%lu','%d')
assert len(template%('a'*64,4294967,99,5))<256
owner,anon=c.Client(),c.Client();suffix=secrets.token_hex(5)
assert owner.call('/api/auth/register',{'email':f'first-upload-{suffix}@example.test','password':secrets.token_urlsafe(24),
    'display_name':'First upload fixture','invite_code':c.cli('invite')['invite_code']})[0]==200
device=c.cli('provision','First upload synthetic fixture')
payload=json.loads(template%(device['device_uid'],100,20,5));headers={'X-Device-Key':device['device_key']}
assert anon.call('/ingest/shield',payload)[0]==401
assert anon.call('/ingest/shield',payload,headers)[0]==409
identifier=owner.call('/api/devices/claim',{'claim_code':device['claim_code'],'display_name':'First upload fixture'})[1]['id']
status,result,_=anon.call('/ingest/shield',payload,headers);assert status==200,(status,result)
now=int(time.time());period=urllib.parse.urlencode({'since':c.iso(now-60),'until':c.iso(now+5)})
status,data,_=owner.call(f'/api/devices/{identifier}/summary?{period}')
assert status==200 and data['latest']['csq']==20 and data['latest']['reg']==5
assert data['position'] is None and data['channels']==[]
assert anon.call(f'/api/devices/{identifier}/summary?{period}')[0]==401
assert owner.call('/api/auth/logout',{})[0]==200
print('First-upload template: buffer bound, authentication, claim-before-send, ingest, owner summary and no fabricated channels/coordinates passed; shield_test only')
