"""Dev-only owner selector tests; no production writes or external notifications."""
import base64
import hashlib
import hmac
import json
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import psycopg2

env_path, base = sys.argv[1:3]
assert base in ('http://127.0.0.1:3042', 'https://dev-gps.serial.kr')
env = dict(l.split('=',1) for l in pathlib.Path(env_path).read_text().splitlines() if '=' in l and not l.startswith('#'))
env = {k:v.strip().strip('"').strip("'") for k,v in env.items()}
assert urllib.parse.urlparse(env['DATABASE_URL']).path.startswith('/gps_tracker_dev')
db=psycopg2.connect(env['DATABASE_URL']);db.autocommit=True;c=db.cursor()
run=uuid.uuid4().hex;users=[];devices=[]

def sql(statement,args=()):
    c.execute(statement,args)
    return c.fetchall() if c.description else []

def token(user):
    encode=lambda x:base64.urlsafe_b64encode(json.dumps(x,separators=(',',':')).encode()).rstrip(b'=')
    text=encode({'alg':'HS256','typ':'JWT'})+b'.'+encode({'sub':str(user),'iat':int(time.time()),'exp':int(time.time())+600,'typ':'access'})
    return (text+b'.'+base64.urlsafe_b64encode(hmac.new(env['JWT_SECRET'].encode(),text,hashlib.sha256).digest()).rstrip(b'=')).decode()

def get(path,user=None,status=200):
    headers={} if user is None else {'Authorization':'Bearer '+token(user)}
    req=urllib.request.Request(base+path,headers=headers)
    try:
        with urllib.request.urlopen(req,timeout=10) as response: code,body,cache=response.status,response.read(),response.headers.get('Cache-Control')
    except urllib.error.HTTPError as error: code,body,cache=error.code,error.read(),error.headers.get('Cache-Control')
    assert code==status,(path,code,status,body[:150])
    if status==200 and path.startswith('/gps-tracker/api/v1/shield-monitor'):assert cache=='no-store'
    return json.loads(body) if body[:1] in (b'{',b'[') else body

def device(user,label,prefix='uno-shield-',kind='hardware'):
    uid=prefix+run+'-'+label
    did=sql("INSERT INTO devices(device_uid,api_key_hash,owner_id,display_name,device_kind) VALUES(%s,'',%s,%s,%s) RETURNING id",(uid,user,label,kind))[0][0]
    devices.append(did);return did

try:
    for label in ('a','b','empty'):
        users.append(sql("INSERT INTO users(email,password_hash,phone,display_name) VALUES(%s,'test-only','01000000000','Shield selector test') RETURNING id",(f'selector-{run}-{label}@example.invalid',))[0][0])
    a,b,empty=users
    first=device(a,'one');second=device(a,'two');other=device(b,'private');legacy=device(a,'kc','esp-');phone=device(a,'phone',kind='phone')
    sql("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,raw,fixes_jsonb) VALUES(%s,%s,now()-interval '1 minute','lte_gnss',true,%s,%s)",
        (first,a,json.dumps({'diag':{'pv_mv':4100},'build_tag':'mine','iccid':'never-publish','lat':37}),json.dumps([{'at_ms':-10000,'lat':37,'lng':127},{'at_ms':0,'lat':37,'lng':127}])))
    sql("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,raw) VALUES(%s,%s,now()-interval '2 minutes','lte_gnss',false,'{\"build_tag\":\"previous-owner\"}')",(first,b))
    api='/gps-tracker/api/v1/shield-monitor/devices'
    get(api,status=401);get(api+'/'+str(first),status=401)
    listed=get(api,a);assert {x['id'] for x in listed}=={first,second}
    assert all(set(x)=={'id','device_uid','display_name','last_seen_at'} for x in listed)
    assert {x['id'] for x in get(api,b)}=={other};assert get(api,empty)==[]
    data=get(api+'/'+str(first),a)
    assert data['available'] and data['count_24h']==1 and len(data['items'])==1
    assert data['items'][0]['point_count']==2 and data['items'][0]['build_tag']=='mine'
    assert not {'lat','lng','raw','iccid','owner_id','user_id'} & data['items'][0].keys()
    assert get(api+'/'+str(second),a)['items']==[]
    for hidden in (other,legacy,phone,999999999):get(api+'/'+str(hidden),a,status=404)
    get(api+'/'+str(first),b,status=404)
    print('PASS owned shield list, no cross-account/IDF/phone access, empty device, safe status and point count')
    sql('UPDATE devices SET owner_id=%s WHERE id=%s',(b,first))
    get(api+'/'+str(first),a,status=404)
    assert first not in {x['id'] for x in get(api,a)}
    reassigned=get(api+'/'+str(first),b)
    assert reassigned['count_24h']==1 and reassigned['items'][0]['build_tag']=='previous-owner'
    print('PASS ownership changes revoke access and never expose another account history')
    public='/arduino-shield/data' if base.startswith('https://') else '/gps-tracker/arduino-shield/data'
    assert get(public)['device_uid']=='uno-shield-test'
    get(public+'?uid=uno-shield-'+run+'-private',status=400)
    print('PASS fixed public bench endpoint remains separate and rejects arbitrary device selection')
finally:
    for did in devices:sql('DELETE FROM devices WHERE id=%s',(did,))
    for user in users:sql('DELETE FROM users WHERE id=%s',(user,))
    db.close()
