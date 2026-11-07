"""User-authorized fixture for user@user4.com. Never creates GPS points or sends FCM.

Run on seriallog with --apply. Keeps a manifest of inserted IDs and original
device settings; reruns only verify the existing fixture. No credentials printed.
"""
import base64, datetime as dt, hashlib, hmac, json, pathlib, sys, time, urllib.request
import psycopg2
from psycopg2.extras import Json

assert sys.argv[1:] == ['--apply']
MARK = '[테스트] 내보내기 검증 2026-10-10'
root = pathlib.Path('/home/mmm/gps-artifacts/business-export-review')
root.mkdir(exist_ok=True)
env = {k:v.strip().strip('"').strip("'") for k,v in (line.split('=',1) for line in pathlib.Path('/home/mmm/projects/gps-tracker-api/.env').read_text().splitlines() if '=' in line and not line.startswith('#'))}
base = 'http://' + env.get('BIND_ADDR','127.0.0.1:3000').replace('0.0.0.0','127.0.0.1') + '/gps-tracker/api/v1'
uid = 28
def api(path):
    enc = lambda x: base64.urlsafe_b64encode(json.dumps(x).encode()).rstrip(b'=')
    data = enc({'alg':'HS256','typ':'JWT'}) + b'.' + enc({'sub':str(uid),'iat':int(time.time()),'exp':int(time.time())+300,'typ':'access'})
    token = (data+b'.'+base64.urlsafe_b64encode(hmac.new(env['JWT_SECRET'].encode(),data,hashlib.sha256).digest()).rstrip(b'=')).decode()
    return urllib.request.urlopen(urllib.request.Request(base+path,headers={'Authorization':'Bearer '+token}),timeout=30).read()

manifest = root/'seed-manifest.json'
if not manifest.exists():
    with psycopg2.connect(env['DATABASE_URL']) as db:
        with db.cursor() as c:
            c.execute('SELECT pg_advisory_xact_lock(%s)',(1010202628,))
            c.execute('SELECT email FROM users WHERE id=%s FOR UPDATE',(uid,))
            assert c.fetchone()==('user@user4.com',)
            c.execute('SELECT id,account_type_override FROM devices WHERE owner_id=%s ORDER BY id FOR UPDATE',(uid,))
            before = c.fetchall(); assert [d[0] for d in before]==[3005,3163]
            for table in ['rental_contracts','vehicle_reservations','staff','trip_annotations']:
                c.execute('SELECT count(*) FROM '+table+' WHERE user_id=%s',(uid,)); assert c.fetchone()[0]==0, 'Existing data changed: '+table
            staff=[]; rentals=[]; reservations=[]; subs=[]
            for name,role in [('가상 운전자 A','영업 테스트'),('가상 운전자 B','관리 테스트')]:
                c.execute('INSERT INTO staff(user_id,name,role) VALUES(%s,%s,%s) RETURNING id',(uid,'[테스트] '+name,role)); staff.append(c.fetchone()[0])
            c.execute('INSERT INTO corporate_info(user_id,company_name) VALUES(%s,%s) ON CONFLICT(user_id) DO NOTHING RETURNING user_id',(uid,'[테스트] 차량 운영'))
            info_added=bool(c.fetchone())
            # A temporary test entitlement, no credit debit and no billing transaction.
            for kind in ['corporate_report','rentcar_report']:
                c.execute('SELECT count(*) FROM subscriptions WHERE user_id=%s AND kind=%s AND expires_at>now()',(uid,kind))
                if c.fetchone()[0]==0:
                    c.execute("INSERT INTO subscriptions(user_id,kind,expires_at,note) VALUES(%s,%s,now()+interval '7 days',%s) RETURNING id",(uid,kind,MARK));subs.append(c.fetchone()[0])
            kst=dt.timezone(dt.timedelta(hours=9)); today=dt.datetime.now(kst).replace(hour=9,minute=0,second=0,microsecond=0)
            for i,(status,offset,amount,deposit) in enumerate([('returned',-5,150000,200000),('returned',-3,50000,30000),('active',0,0,100000),('draft',3,0,100000)],1):
                start=today+dt.timedelta(days=offset);end=start+dt.timedelta(days=1)
                done=status=='returned';extra=10000 if i==1 else 0;fee=amount-extra
                lines=[{'kind':'base','label':'[테스트] 기본 대여료','amount':fee}]
                if extra: lines.append({'kind':'extra','label':'[테스트] 세차 비용','amount':extra})
                c.execute('''INSERT INTO rental_contracts(user_id,device_id,renter_name,starts_at,ends_at,status,rate_amount_krw,deposit_krw,note,
                  settled_amount_krw,settled_at,returned_at,base_fee_krw,late_fee_krw,over_km_fee_krw,extra_fee_krw,refund_krw,settlement_json,ending_alerted_at,overdue_alerted_at)
                  VALUES(%s,3005,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now(),now()) RETURNING id''',
                  (uid,f'[테스트] 가상 임차인 {i}',start,end,status,fee if done else 70000,deposit,MARK,amount if done else None,end if done else None,end if done else None,fee if done else None,0 if done else None,0 if done else None,extra if done else None,deposit-amount if done else None,Json({'lines':lines}) if done else None))
                rentals.append(c.fetchone()[0])
            for i,(status,offset) in enumerate([('completed',-2),('planned',1),('planned',2)]):
                start=today+dt.timedelta(days=offset)
                c.execute('''INSERT INTO vehicle_reservations(user_id,device_id,driver_staff_id,starts_at,ends_at,purpose,note,status)
                  VALUES(%s,3163,%s,%s,%s,%s,%s,%s) RETURNING id''',(uid,staff[i%2],start,start+dt.timedelta(hours=2),'[테스트] 고객사 방문' if i%2==0 else '[테스트] 차량 점검',MARK,status))
                reservations.append(c.fetchone()[0])
            trips=json.loads((root/'trips-before.json').read_text())
            target=next(t for t in trips if not t.get('annotation'))
            c.execute('''INSERT INTO trip_annotations(device_id,user_id,trip_started_at,purpose,driver_staff_id,fuel_liters,fuel_cost,note)
              VALUES(3163,%s,%s,'business',%s,2,3400,%s) RETURNING id''',(uid,target['started_at'],staff[0],MARK))
            annotations=[c.fetchone()[0]]
            record={'marker':MARK,'user_id':uid,'device_before':before,'staff':staff,'rentals':rentals,'reservations':reservations,'subscriptions':subs,'annotations':annotations,'corporate_info_added':info_added}
            # Write before commit: a failed commit must be reviewed, never blindly retried.
            manifest.write_text(json.dumps(record,ensure_ascii=False,indent=2));manifest.chmod(0o600)
    print('Created fixture:',json.dumps(record,ensure_ascii=False))
else:
    record=json.loads(manifest.read_text());assert record['user_id']==uid
    print('Fixture already exists; collecting current API results.')

paths={'devices':'/devices','rentals':'/rentcar/contracts?view=operations&from=2026-10-01T00%3A00%3A00%2B09%3A00&to=2026-11-01T00%3A00%3A00%2B09%3A00',
 'staff':'/corporate/staff','reservations':'/corporate/reservations?from=2026-10-01&to=2026-11-01','info':'/corporate/info',
 'corporateSubscription':'/corporate/subscription','rentalSubscription':'/rentcar/subscription',
 'fleetStats':'/corporate/fleet/trip-stats?from=2026-10-01&to=2026-10-10'}
snapshot={name:json.loads(api(path)) for name,path in paths.items()}
snapshot['tripsByDevice']={str(d):json.loads(api(f'/corporate/devices/{d}/trips?from=2026-10-01&to=2026-10-10')) for d in [3005,3163]}
(root/'snapshot.json').write_text(json.dumps(snapshot,ensure_ascii=False,indent=2));(root/'snapshot.json').chmod(0o600)
for name,path in [('corporate-nts.xlsx','/corporate/report.xlsx?type=nts&month=2026-10&device_ids=3163'),('corporate-ours.xlsx','/corporate/report.xlsx?type=ours&month=2026-10&device_ids=3163'),('rental-invoice.xlsx',f"/rentcar/contracts/{record['rentals'][0]}/invoice.xlsx")]:
    data=api(path);assert data[:2]==b'PK';(root/name).write_bytes(data)
print('API download OK: 2 corporate XLSX, 1 rental invoice; snapshot saved')
