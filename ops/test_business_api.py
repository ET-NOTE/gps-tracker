"""Synthetic rental read regression, isolated clone only. No payment or external calls."""
import base64, hashlib, hmac, json, pathlib, sys, time, urllib.error, urllib.parse, urllib.request, uuid
import psycopg2

env_path, base = sys.argv[1:3]
assert base == 'http://127.0.0.1:3042'
env = {k:v.strip().strip('"').strip("'") for k,v in (line.split('=',1) for line in pathlib.Path(env_path).read_text().splitlines() if '=' in line and not line.startswith('#'))}
assert urllib.parse.urlsplit(env['DATABASE_URL']).path.startswith('/gps_tracker_dev')
run = uuid.uuid4().hex
db = psycopg2.connect(env['DATABASE_URL']); db.autocommit = True
cur = db.cursor(); users=[]
def scalar(sql,args=()):
    cur.execute(sql,args); return cur.fetchone()[0]
def token(uid):
    enc=lambda obj: base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b'=')
    data=enc({'alg':'HS256','typ':'JWT'})+b'.'+enc({'sub':str(uid),'iat':int(time.time()),'exp':int(time.time())+1800,'typ':'access'})
    return (data+b'.'+base64.urlsafe_b64encode(hmac.new(env['JWT_SECRET'].encode(),data,hashlib.sha256).digest()).rstrip(b'=')).decode()
def get(uid,expected=200,**params):
    query=dict(from_='2026-10-01T00:00:00+09:00',to='2026-11-01T00:00:00+09:00')
    query['from']=query.pop('from_'); query.update(params)
    req=urllib.request.Request(base+'/gps-tracker/api/v1/rentcar/contracts?'+urllib.parse.urlencode(query),headers={'Authorization':'Bearer '+token(uid)})
    try:
        with urllib.request.urlopen(req,timeout=20) as r: status=r.status; data=r.read()
    except urllib.error.HTTPError as e: status=e.code; data=e.read()
    assert status==expected,(status,expected,data[:100])
    return json.loads(data)
try:
    for label in ('a','b'):
        users.append(scalar("INSERT INTO users(email,password_hash,display_name,phone) VALUES(%s,'test-only','Business regression','01000000000') RETURNING id",(f'business-{run}-{label}@example.invalid',)))
    a,b=users
    device=scalar("INSERT INTO devices(device_uid,owner_id,api_key_hash) VALUES(%s,%s,'') RETURNING id",('business-'+run,a))
    def contract(owner,status,start,end,settled=None):
        return scalar("INSERT INTO rental_contracts(user_id,device_id,renter_name,status,starts_at,ends_at,settled_at,settled_amount_krw) VALUES(%s,%s,'Synthetic',%s,%s,%s,%s,150000) RETURNING id",(owner,device,status,start,end,settled))
    old=contract(a,'active','2026-04-01','2026-04-02')
    late=contract(a,'overdue','2026-03-01','2026-03-02')
    settled=contract(a,'returned','2026-08-01','2026-08-02','2026-10-08')
    draft=contract(a,'draft','2026-10-10','2026-10-11')
    contract(a,'cancelled','2026-06-01','2026-06-02')
    foreign=contract(b,'returned','2026-10-10','2026-10-11','2026-10-12')
    ids=lambda rows:{r['id'] for r in rows}
    assert ids(get(a,view='operations'))=={old,late,settled,draft}
    assert ids(get(a))=={draft} # Existing date-bounded clients keep their behavior.
    assert ids(get(a,view='operations',status='returned',device_id=device))=={settled}
    assert get(a,view='operations',device_id=device+1000000)==[]
    assert ids(get(b,view='operations'))=={foreign}
    get(a,expected=400,view='invalid')
    print('PASS business operations: old overdue, settlement month, legacy window, status/device filters, tenant isolation')
finally:
    if users:
        cur.execute('DELETE FROM rental_contracts WHERE user_id=ANY(%s)',(users,))
        cur.execute('DELETE FROM devices WHERE owner_id=ANY(%s)',(users,))
        cur.execute('DELETE FROM users WHERE id=ANY(%s)',(users,))
    db.close()
