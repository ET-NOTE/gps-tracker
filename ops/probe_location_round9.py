"""GET-only timing for a fixed historic day; output hashes/counts, never telemetry or tokens."""
import base64,hashlib,hmac,json,pathlib,sys,time,urllib.request
import psycopg2
c={k:v.strip().strip('"').strip("'") for k,v in (s.split('=',1) for s in pathlib.Path(sys.argv[1]).read_text().splitlines() if '=' in s and not s.startswith('#'))}
with psycopg2.connect(c['DATABASE_URL']) as db:
 db.set_session(readonly=True,autocommit=True)
 with db.cursor() as q:
  q.execute("SELECT d.id,d.owner_id FROM devices d JOIN users u ON u.id=d.owner_id WHERE u.email='user@user4.com' AND d.display_name LIKE '%520211%' LIMIT 1")
  did,owner=q.fetchone()
  q.execute('SELECT vehicle_id FROM fleet_vehicle_bindings WHERE device_id=%s AND owner_id=%s AND is_primary ORDER BY started_at LIMIT 1',(did,owner));vehicle=q.fetchone()[0]
enc=lambda v:base64.urlsafe_b64encode(json.dumps(v).encode()).rstrip(b'=')
raw=enc({'alg':'HS256','typ':'JWT'})+b'.'+enc({'sub':str(owner),'typ':'access','iat':int(time.time()),'exp':int(time.time())+600})
token=(raw+b'.'+base64.urlsafe_b64encode(hmac.new(c['JWT_SECRET'].encode(),raw,hashlib.sha256).digest()).rstrip(b'=')).decode()
queries={
 'history_20261020':f'/devices/{did}/locations?since=2026-10-19T15%3A00%3A00Z&until=2026-10-20T15%3A00%3A00Z&limit=10000',
 'daily_20261020':f'/devices/{did}/stats/daily?from=2026-10-20&to=2026-10-20',
 'active_dates':f'/devices/{did}/active-dates',
 'page_20261020':f'/devices/{did}/locations/page?since=2026-10-19T15%3A00%3A00Z&until=2026-10-20T15%3A00%3A00Z&limit=5000',
 'fleet_trips_october':f'/corporate/vehicles/{vehicle}/trips?from=2026-10-01&to=2026-10-30',
}
result={}
for name,path in queries.items():
 samples=[]
 for _ in range(3):
  start=time.monotonic()
  request=urllib.request.Request('https://gps.serial.kr/api/v1'+path,headers={'Authorization':'Bearer '+token})
  with urllib.request.urlopen(request,timeout=45) as r:data=r.read()
  samples.append(round(time.monotonic()-start,3))
  rows=json.loads(data)
 result[name]={'seconds':samples,'sha256':hashlib.sha256(data).hexdigest(),'rows':len(rows.get('items',[])) if isinstance(rows,dict) else len(rows)}
print(json.dumps(result),flush=True)
