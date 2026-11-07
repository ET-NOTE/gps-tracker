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
def get(uid):
    from datetime import datetime, timezone, timedelta
    today=(datetime.now(timezone.utc)+timedelta(hours=9)).date()
    query=urllib.parse.urlencode({'from':str(today)+'T00:00:00+09:00','to':str(today+timedelta(days=1))+'T00:00:00+09:00'})
    req=urllib.request.Request(base+'/gps-tracker/api/v1/corporate/fleet/trip-stats?'+query,headers={'Authorization':'Bearer '+token(uid)})
    with urllib.request.urlopen(req,timeout=20) as r:return json.loads(r.read())['per_device']
try:
    for label in ('a','b'):
        users.append(scalar("INSERT INTO users(email,password_hash,display_name,phone) VALUES(%s,'test-only','Coverage regression','01000000000') RETURNING id",(f'coverage-{run}-{label}@example.invalid',)))
    a,b=users
    devices=[scalar("INSERT INTO devices(device_uid,owner_id,api_key_hash) VALUES(%s,%s,'') RETURNING id",(f'coverage-{run}-{i}',a if i<4 else b)) for i in range(5)]
    # missing row; measured stationary; positive distance; one fix; other tenant.
    for i,count,distance in [(1,2,0),(2,20,1500),(3,1,0),(4,30,900000)]:
        cur.execute("INSERT INTO daily_stats(device_id,user_id,date,fix_count,distance_m,last_fix_at) VALUES(%s,%s,(now() AT TIME ZONE 'Asia/Seoul')::date,%s,%s,now())",(devices[i],a if i<4 else b,count,distance))
    rows={r['device_id']:r for r in get(a)}
    assert set(rows)==set(devices[:4])
    assert rows[devices[0]]['today_fix_count']==0 and rows[devices[0]]['today_updated_at'] is None
    assert rows[devices[1]]['today_distance_m']==0 and rows[devices[1]]['today_fix_count']==2
    assert rows[devices[1]]['today_last_fix_at'] and rows[devices[1]]['today_updated_at']
    assert rows[devices[2]]['today_distance_m']==1500 and rows[devices[2]]['today_fix_count']==20
    assert rows[devices[3]]['today_fix_count']==1
    assert {r['device_id'] for r in get(b)}=={devices[4]}
    # An aggregate belonging to an old owner must not enter the new owner's totals.
    cur.execute('UPDATE daily_stats SET user_id=%s WHERE device_id=%s',(b,devices[2]))
    row=next(r for r in get(a) if r['device_id']==devices[2])
    assert row['today_distance_m']==0 and row['today_fix_count']==0
    print('PASS fleet coverage: missing vs zero, one fix, timestamps, measured distance, account and historical-owner isolation (8 checks)')
finally:
    if users:
        cur.execute('DELETE FROM devices WHERE owner_id=ANY(%s)',(users,))
        cur.execute('DELETE FROM users WHERE id=ANY(%s)',(users,))
    db.close()
