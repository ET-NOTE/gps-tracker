"""Requires a demo-only isolated Firebase emulator and synthetic fixture key. No cloud account."""
import json,os,time,urllib.request,urllib.error
origin=os.environ.get('EXAMPLE_FUNCTION_ORIGIN','http://127.0.0.1:5001')
firestore=os.environ.get('FIRESTORE_EMULATOR_HOST','127.0.0.1:8080')
assert origin.startswith('http://127.0.0.1:') and firestore.startswith('127.0.0.1:')
base=origin+'/demo-shield-examples/asia-northeast3/shieldIngest'
key='a'*64
def call(body,token=key):
    req=urllib.request.Request(base,json.dumps(body).encode(),{'Content-Type':'application/json','X-Device-Key':token})
    try:
        with urllib.request.urlopen(req,timeout=30) as r:return r.status,r.read()
    except urllib.error.HTTPError as e:return e.code,e.read()
sample={'device_id':'test-shield','at':int(time.time()),'temperature_c':24.8,'humidity_pct':58}
assert call(sample,'b'*64)[0]==401
assert call({**sample,'device_id':'other'})[0]==400
assert call(sample)[0]==200
assert call(sample)[0]==200
assert call({**sample,'humidity_pct':59})[0]==409
assert call({**sample,'at':sample['at']+1})[0]==429
url='http://'+firestore+'/v1/projects/demo-shield-examples/databases/(default)/documents/shieldDevices/test-shield/latest/sample'
# Emulator owner token only, never used against a cloud endpoint.
with urllib.request.urlopen(urllib.request.Request(url,headers={'Authorization':'Bearer owner'})) as r:doc=json.load(r)
assert doc['fields']['humidity_pct'].get('integerValue')=='58'
assert doc['fields']['temperature_c'].get('doubleValue')==24.8
try:urllib.request.urlopen(url)
except urllib.error.HTTPError as e:assert e.code==403
else:raise AssertionError('Anonymous Firestore read was allowed')
print('8 Firebase emulator checks passed: auth, shape, write/read, duplicate, conflict, throttle, DB privacy')
