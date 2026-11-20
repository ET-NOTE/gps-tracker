"""Actual TLS/API/runtime-role checks on fewer than100 synthetic source records.

No production endpoint, export, sustained workload, attribution or deletion.
"""
import base64
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import pwd
import ssl
import subprocess
import time
from urllib.parse import urlencode
import psycopg2
from runtime121_control import ROOT, DSN, secret, migrate, stop_api, journal
from admin_db_roles import run as separate
from load_runtime131 import tls

assert Path('/etc/runtime121-test-only').read_text().strip() == 'synthetic'
BASE = '/gps-tracker/api/v1'
ROUTE = '/admin/privacy/unattributed'
PASSWORD = 'Synthetic-only-132!'
passed = []
db = psycopg2.connect(DSN)
db.autocommit = True


def sql(query, args=()):
    with db.cursor() as c:
        c.execute(query, args)
        return c.fetchall() if c.description else None


def ok(message):
    passed.append(message)
    print('PASS '+message, flush=True)


def start(enforced=True):
    stop_api()
    link = ROOT/'active-api'
    link.unlink(missing_ok=True)
    link.symlink_to('/opt/gps-tracker-api')
    credentials = json.loads((ROOT/'test-runtime.json').read_text())
    values = dict(APP_ENV='test', DATABASE_URL=DSN.replace('postgres:closure-test-only', credentials['user']+':'+credentials['password']),
        GPS_DATABASE_MODE='runtime', JWT_SECRET='synthetic132-only', BIND_ADDR='127.0.0.1:3043', SMS_DEV_MODE='1',
        GPS_PDF_SOCKET='/run/gps-pdf-render/render.sock', GPS_PDF_RENDERER='/opt/gps-pdf-render',
        GPS_LOCATION_ENCRYPTION='pilot', GPS_LOCATION_KEYRING_FILE=str(ROOT/'api-keyring.json'), GPS_LOCATION_TEMP_TABLESPACE='gps121_sort',
        UPLOAD_DIR=str(ROOT/'test-storage/uploads'), PRIVATE_UPLOAD_DIR=str(ROOT/'test-storage/private'),
        GPS_LOCATION_ACCESS_LOG='on', GPS_SUBJECT_PROVISION='off', GPS_STATS_POLL_SECONDS='3600',
        GPS_ADMIN_SECURITY='on' if enforced else 'off', GPS_ADMIN_MFA_KEY=(ROOT/'mfa-key.txt').read_text(),
        GPS_INGEST_TLS_REQUIRED='on', GPS_TLS_TRUSTED_PROXIES='127.0.0.1/32')
    secret('/etc/gps121/api.env', '\n'.join(k+'='+v for k,v in values.items()))
    subprocess.run(['systemctl', 'reset-failed', 'gps121-api'], capture_output=True)
    subprocess.run(['systemctl', 'start', 'gps121-api'], check=True)
    for _ in range(100):
        try:
            c = http.client.HTTPConnection('127.0.0.1', 3043, timeout=1)
            c.request('GET', '/gps-tracker/health'); r = c.getresponse(); data = r.read(); c.close()
            if r.status == 200 and json.loads(data)['db']:
                return
        except OSError:
            pass
        time.sleep(.2)
    raise AssertionError(journal('gps121-api'))


def connection():
    context = ssl.create_default_context(cafile='/etc/gps122-tls/cert.pem')
    context.minimum_version = context.maximum_version = ssl.TLSVersion.TLSv1_2
    return http.client.HTTPSConnection('127.0.0.1', 8443, context=context, timeout=30)


def headers(who=None):
    h = {'Content-Type': 'application/json'}
    if who:
        h['Authorization'] = 'Bearer '+who['access_token']
        if who.get('session'):
            h['X-Admin-Session'] = who['session']
    return h


def call(method, path, body=None, who=None, extra=None):
    c = connection()
    try:
        c.request(method, BASE+path, json.dumps(body) if body is not None else None, {**headers(who), **(extra or {})})
        r = c.getresponse(); raw = r.read()
        return r.status, json.loads(raw) if 'application/json' in r.getheader('content-type', '') else raw.decode(), dict(r.getheaders())
    finally:
        c.close()


def account(n):
    phone = '0101320'+str(n).zfill(4)
    s, otp, _ = call('POST', '/auth/send-otp', {'phone': phone}); assert s == 200, (s, otp)
    s, user, _ = call('POST', '/auth/register', dict(phone=phone, email=f'round132-{n}@example.invalid', otp_code=otp['dev_code'],
        display_name='Synthetic132', password=PASSWORD)); assert s == 200, (s, user)
    return user


def enroll(who):
    s, value, _ = call('POST', '/admin/security/enroll', {'password': PASSWORD}, who); assert s == 200, (s, value)
    seed = value['secret']
    raw = hmac.new(base64.b32decode(seed+'='*((8-len(seed)%8)%8)), (int(time.time())//30).to_bytes(8,'big'), hashlib.sha256).digest()
    offset = raw[-1]&15
    code = str((int.from_bytes(raw[offset:offset+4], 'big')&0x7fffffff)%1000000).zfill(6)
    s, value, _ = call('POST', '/admin/security/verify', {'password': PASSWORD, 'code': code}, who); assert s == 200, (s, value)
    who['session'] = value['session']


def fingerprint():
    return {table: sql(f"SELECT md5(coalesce(string_agg(to_jsonb(t)::text,',' ORDER BY to_jsonb(t)::text),'')) FROM {table} t")[0][0]
            for table in ('location_records', 'events')}


def main():
    migrate('migration132', DSN)
    assert sql('SELECT max(version) FROM _sqlx_migrations') == [(114,)]
    ring = json.dumps({'active': 'synthetic132', 'keys': {'synthetic132': base64.b64encode(os.urandom(32)).decode()}})
    secret(ROOT/'api-keyring.json', ring); os.chown(ROOT/'api-keyring.json', 1000, 1000)
    secret(ROOT/'mfa-key.txt', base64.b64encode(os.urandom(32)).decode())
    sql("SELECT set_config('gps.storage_keys',%s,false)", (ring,))
    sql('UPDATE location_storage_policy SET enabled=true,activated_at=now()')
    for job_id, in sql("SELECT job_id FROM timescaledb_information.jobs WHERE proc_name='policy_retention' AND hypertable_schema='public'"):
        sql('SELECT alter_job(%s,scheduled=>false)', (job_id,))
    report = separate(DSN, True, ROOT/'test-runtime.json')
    sql('GRANT CREATE ON TABLESPACE gps121_sort TO gps_runtime')
    sql("ALTER ROLE gps_runtime IN DATABASE gps_closure_test SET temp_tablespaces='gps121_sort'")
    for name in ('uploads','private'):
        path = ROOT/'test-storage'/name; path.mkdir(exist_ok=True); os.chown(path,1000,1000)
    start(); tls()
    # systemctl start returns before nginx has opened its listening socket.
    for _ in range(80):
        try:
            c=connection();c.request('GET','/gps-tracker/health');r=c.getresponse();r.read();c.close()
            if r.status==200:break
        except OSError:pass
        time.sleep(.1)
    else:raise AssertionError('synthetic TLS proxy not ready')
    officer, operator, handler, user, other = [account(n) for n in range(5)]
    for who, role in ((officer,'officer'), (operator,'operator'), (handler,'handler')):
        sql("UPDATE users SET role='admin' WHERE id=%s", (who['user_id'],))
        sql("INSERT INTO admin_principals(user_id,role,allowed_cidrs) VALUES(%s,%s,ARRAY['127.0.0.1/32'])", (who['user_id'],role))
    filters = dict(kind='location', **{'from':'2026-10-01T15:00:00Z','until':'2026-10-03T15:00:00Z'},limit=100)
    path = ROUTE+'?'+urlencode(filters)
    assert call('GET',path)[0] == 401
    assert call('GET',path,who=user)[0] == 403
    assert call('GET',path,who=operator)[0] == 403
    for who in (officer,operator,handler): enroll(who)
    assert call('GET',path,who=handler)[0] == 403
    assert call('GET',path,who=officer)[0] == 200
    assert call('GET',path,who=operator,extra={'X-Fleet-Owner':str(other['user_id'])})[0] == 403
    ok('personal MFA required; anonymous, ordinary user, handler and delegated scope denied; officer allowed')

    devices = [sql("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,%s,'') RETURNING id",
                   (owner,f'synthetic132-{i}'))[0][0] for i,owner in enumerate((user['user_id'],None,other['user_id']))]
    for i, did in enumerate(devices):
        for n, source in enumerate(('l80','lte_gnss','phone','private-source@example.invalid')):
            sql("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng) VALUES(%s,NULL,'2026-10-02T01:00:00Z'::timestamptz+%s*interval '1 minute',%s,true,35.132,127.132)", (did,n,source))
        sql("INSERT INTO events(device_id,user_id,kind,occurred_at,data) VALUES(%s,NULL,'wake','2026-10-02T01:00:00Z','{\"private\":\"do-not-return\"}'),(%s,NULL,'sleep_enter','2026-10-03T01:00:00Z','{}'),(%s,NULL,'private-event@example.invalid','2026-10-03T01:00:00Z','{}')", (did,did,did))
    # Exact half-open date boundaries and known collection-owner exclusion.
    for at, uid in [('2026-10-01T15:00:00Z',None),('2026-10-01T14:59:59Z',None),('2026-10-03T15:00:00Z',None),('2026-10-02T02:00:00Z',user['user_id'])]:
        sql("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng) VALUES(%s,%s,%s,'l80',true,35.132,127.132)", (devices[0],uid,at))
    before = fingerprint()
    assert sql('SELECT count(*),count(*) FILTER(WHERE lat IS NOT NULL OR lng IS NOT NULL),count(lat_sealed) FROM location_records') == [(16,0,16)]
    s, all_rows, h = call('GET',path,who=operator); assert s == 200, (s,all_rows)
    assert 'no-store' in {k.lower():v for k,v in h.items()}['cache-control']
    assert len(all_rows['items']) == 12 and sum(x['records'] for x in all_rows['items']) == 13
    assert all_rows['read_only'] and not all_rows['deletion_ready'] and all_rows['attribution'] == 'unknown'
    assert {x['current_link'] for x in all_rows['items']} == {'linked','unlinked'}
    assert {x['day'] for x in all_rows['items']} == {'2026-10-02'}
    for x in all_rows['items']:
        assert set(x) == {'day','device_id','category','records','first_at','last_at','current_link'}
    raw = json.dumps(all_rows)
    for forbidden in ('35.132','127.132','private-source','example.invalid','owner_id','user_id','lat_sealed','do-not-return'): assert forbidden not in raw, forbidden
    ok('encrypted physical rows grouped without coordinates, source free-text or owners; exact KST boundaries and NULL-only counts; no-store')

    collected=[]; cursor=None; first_cursor=None
    for _ in range(10):
        q={**filters,'limit':2,**({'cursor':cursor} if cursor else {})}
        s, page, _=call('GET',ROUTE+'?'+urlencode(q),who=operator); assert s==200,(s,page)
        collected.extend(page['items']);cursor=page['next_cursor'];first_cursor=first_cursor or cursor
        if not cursor:break
    assert collected==all_rows['items'] and cursor is None
    for change in ({'kind':'event','cursor':first_cursor},{'device_id':devices[0],'cursor':first_cursor},
                   {'from':filters['until']},{'until':'2026-12-01T00:00:00Z'},{'limit':101},{'device_id':-1},{'cursor':'!'}, {'unknown':'x'}):
        assert call('GET',ROUTE+'?'+urlencode({**filters,**change}),who=operator)[0] == 400, change
    s, only, _=call('GET',ROUTE+'?'+urlencode({**filters,'device_id':devices[1]}),who=operator)
    assert s==200 and len(only['items'])==4 and {x['device_id'] for x in only['items']}=={devices[1]}
    s, empty, _=call('GET',ROUTE+'?'+urlencode({**filters,'device_id':99999999}),who=operator)
    assert s==200 and not empty['items'] and empty['next_cursor'] is None
    s, events, _=call('GET',ROUTE+'?'+urlencode({**filters,'kind':'event'}),who=operator)
    assert s==200 and len(events['items'])==9 and sum(x['records'] for x in events['items'])==9
    assert {x['category'] for x in events['items']}=={'wake','sleep_enter','other'}
    ok('six keyset pages equal full result; filter-bound cursor, 31-day/size/device bounds, empty and event categories verified')

    sql('UPDATE devices SET owner_id=%s WHERE id=%s',(other['user_id'],devices[0]))
    assert call('GET',path,who=operator)[1]['items']==all_rows['items']
    assert fingerprint()==before
    # Runtime decryption denied: this metadata endpoint must still function.
    routines=sql("SELECT oid::regprocedure::text FROM pg_proc WHERE proname LIKE 'gps_open_%' AND pronamespace='public'::regnamespace")
    assert routines
    for routine, in routines:sql('REVOKE EXECUTE ON FUNCTION '+routine+' FROM gps_runtime')
    assert call('GET',path,who=operator)[0]==200
    for routine, in routines:sql('GRANT EXECUTE ON FUNCTION '+routine+' TO gps_runtime')
    ok('current-owner reassignment never rewrites historical attribution; physical source hashes unchanged; works with decryption EXECUTE revoked')

    sql("UPDATE admin_principals SET allowed_cidrs=ARRAY['203.0.113.9/32'] WHERE user_id=%s",(operator['user_id'],))
    assert call('GET',path,who=operator,extra={'X-Real-IP':'203.0.113.9','X-Forwarded-For':'203.0.113.9'})[0]==403
    sql("UPDATE admin_principals SET allowed_cidrs=ARRAY['127.0.0.1/32'] WHERE user_id=%s",(operator['user_id'],))
    sql("CREATE FUNCTION synthetic132_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.route='/admin/privacy/unattributed' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$")
    sql('CREATE TRIGGER synthetic132_failure BEFORE INSERT ON admin_security_events FOR EACH ROW EXECUTE FUNCTION synthetic132_audit_failure()')
    assert call('GET',path,who=operator)[0]==500
    sql('DROP TRIGGER synthetic132_failure ON admin_security_events');sql('DROP FUNCTION synthetic132_audit_failure()')
    assert sql("SELECT count(*) FROM admin_security_events WHERE route=%s AND action='access'",(ROUTE,))[0][0]>0
    ok('IP denial ignores spoofed forwarding headers; audit write failure denies access; successful requests leave admin evidence')

    # Two deliberately blocked reads exercise the existing limit once, not a load test.
    lock=psycopg2.connect(DSN); lock.autocommit=False
    with lock.cursor() as c:c.execute('LOCK TABLE location_records IN ACCESS EXCLUSIVE MODE')
    clients=[]
    try:
        for _ in range(2):
            c=connection();c.request('GET',BASE+path,headers=headers(operator));clients.append(c)
        for _ in range(80):
            if sql("SELECT count(*) FROM pg_stat_activity WHERE usename='gps_runtime' AND wait_event_type='Lock' AND query LIKE 'WITH grouped AS (%'")[0][0]==2:break
            time.sleep(.05)
        else:raise AssertionError('two bounded reads did not reach lock')
        assert call('GET',path,who=operator)[0]==429
        for c in clients:c.close()
        for _ in range(100):
            if sql("SELECT count(*) FROM pg_stat_activity WHERE usename='gps_runtime' AND query LIKE 'WITH grouped AS (%' AND state<>'idle'")[0][0]==0:break
            time.sleep(.05)
        else:raise AssertionError('disconnect left a live metadata query')
    finally:
        for c in clients:c.close()
        lock.rollback();lock.close()
    assert call('GET',path,who=operator)[0]==200
    assert fingerprint()==before
    ok('existing read limit returns429; TLS disconnect cancels blocked SQL and releases slots; retry succeeds; sources unchanged')
    start(False)
    assert call('GET',path,who=operator)[0]==403
    assert fingerprint()==before
    ok('security OFF fails closed for legacy admin; no new schema, ownership or deletion writes')
    stop_api()
    evidence=dict(at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),schema=114,
        api_sha256=hashlib.sha256((ROOT/'out/gps-tracker-api').read_bytes()).hexdigest(),
        environment='internal synthetic native PostgreSQL14/Timescale2.19.3; TLS1.2; restricted gps_runtime',
        passed=passed,fixture=dict(location_rows=16,event_rows=9),source_hashes_before=before,source_hashes_after=fingerprint(),
        db_role_report=report,production_accessed=False,sustained_load_executed=False)
    (ROOT/'out/functional132.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
    print('PASS all',len(passed),'functional groups',flush=True)


if __name__=='__main__':main()
