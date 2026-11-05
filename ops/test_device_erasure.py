"""Destructive regression exclusively on the named internal Docker test network."""
import base64
import concurrent.futures
import hashlib
import hmac
import json
import subprocess
import time
import urllib.error
import urllib.request
import uuid

import psycopg2
from erase_device_data import AGGREGATES, run

NETWORK = 'gps-rights-test-20261105'
DB = 'gps-rights-db-20261105'
API = 'gps-rights-api-20261105'
inspect = lambda kind, name: json.loads(subprocess.check_output(['docker', kind, 'inspect', name]))[0]
assert inspect('network', NETWORK)['Internal']
db_info = inspect('container', DB)
api_info = inspect('container', API)
assert db_info['Config']['Image'] == 'timescale/timescaledb:2.19.3-pg14'
assert 'APP_ENV=test' in api_info['Config']['Env']
assert 'DATABASE_URL=postgres://postgres:rights-test-only@rights-db:5432/gps_rights_test' in api_info['Config']['Env']
DSN = f"postgres://postgres:rights-test-only@{db_info['NetworkSettings']['Networks'][NETWORK]['IPAddress']}/gps_rights_test"
BASE = f"http://{api_info['NetworkSettings']['Networks'][NETWORK]['IPAddress']}:3043"


def connect():
    db = psycopg2.connect(DSN)
    db.autocommit = True
    return db


db = connect()


def sql(query, args=(), connection=db):
    with connection.cursor() as q:
        q.execute(query, args)
        return q.fetchone()[0] if q.description else None


def fails(query, args=(), code=None):
    try:
        sql(query, args)
    except psycopg2.Error as e:
        assert code is None or e.pgcode == code, (e.pgcode, code, str(e))
        return
    raise AssertionError('Expected rejection: '+query[:80])


tag = uuid.uuid4().hex
users = [sql("INSERT INTO users(email,password_hash,phone) VALUES(%s,'fixture-only','01000000000') RETURNING id",
             (f'{tag}-{n}@example.invalid',)) for n in range(2)]
owner, previous = users


def device(n):
    sim = '89882'+str(int(tag[:9], 16)).zfill(13)+str(n)
    did = sql("INSERT INTO devices(device_uid,iccid,owner_id,display_name,api_key_hash) VALUES(%s,%s,%s,%s,'') RETURNING id",
              (f'erasure-{tag}-{n}', sim, owner, f'fixture-{n}'))
    return did, sim


target, sim = device(1)
other, other_sim = device(2)
window = sql("SELECT date_trunc('day',now())-interval '35 days'")
for did in (target, other):
    for i, uid in enumerate((owner, previous, None)):
        sql("""INSERT INTO location_records(device_id,recorded_at,source,fix,lat,lng,user_id,raw)
               VALUES(%s,%s+%s*interval '1 minute','l80',true,37.1,127.1,%s,'{"test":"raw"}')""", (did, window, i, uid))
    sql('INSERT INTO daily_stats(device_id,date,user_id,fix_count) VALUES(%s,%s::date,%s,3)', (did, window, owner))
    sql("UPDATE devices SET last_lat=37.1,last_lng=127.1,last_fix_at=%s,last_seen_at=%s WHERE id=%s", (window, window, did))
for view in AGGREGATES:
    sql('CALL refresh_continuous_aggregate(%s,%s,%s+interval \'1 day\')', (view, window, window))
chunks = sql("SELECT array_agg(format('%%I.%%I',chunk_schema,chunk_name)) FROM timescaledb_information.chunks WHERE hypertable_name='location_records' AND range_start<=%s AND range_end>%s", (window, window))
for chunk in chunks:
    sql('SELECT compress_chunk(%s,if_not_compressed=>true)', (chunk,))

baseline = {t: sql(f"SELECT md5(string_agg(to_jsonb(r)::text,',' ORDER BY to_jsonb(r)::text)) FROM {t} r WHERE device_id=%s", (other,))
            for t in ['location_records', 'daily_stats', *AGGREGATES]}
vehicle = sql("INSERT INTO fleet_vehicles(owner_id,name) VALUES(%s,'Fixture vehicle') RETURNING id", (owner,))
binding = sql("INSERT INTO fleet_vehicle_bindings(vehicle_id,owner_id,device_id,terminal_name,started_at,is_primary) VALUES(%s,%s,%s,'Fixture terminal',%s,true) RETURNING id", (vehicle, owner, target, window))
site = sql("INSERT INTO fleet_sites(owner_id,name,geometry) VALUES(%s,'Fixture site','{}') RETURNING id", (owner,))
visit = sql("""INSERT INTO fleet_site_visits(owner_id,site_id,vehicle_id,binding_id,site_name,vehicle_name,first_inside_at,last_inside_at,start_kind)
 VALUES(%s,%s,%s,%s,'Fixture site','Fixture vehicle',%s,%s,'observed') RETURNING id""", (owner, site, vehicle, binding, window, window))
sql('INSERT INTO fleet_site_states(site_id,binding_id,last_at,inside,visit_id) VALUES(%s,%s,%s,true,%s)', (site, binding, window, visit))
sql('INSERT INTO fleet_site_cursors(binding_id,last_at) VALUES(%s,%s)', (binding, window))
sql("""INSERT INTO fleet_trip_corrections(owner_id,vehicle_id,source_device_id,binding_id,started_at,ended_at,action,reason,sources,outputs,evidence_hash)
 VALUES(%s,%s,%s,%s,%s,%s+interval '1 hour','adjust','fixture','[]','[]','fixture')""", (owner, vehicle, target, binding, window, window))
sql("INSERT INTO fleet_trip_assignment_audit(owner_id,vehicle_id,action,after_value) VALUES(%s,%s,'fixture',jsonb_build_object('device_id',%s))", (owner, vehicle, target))
ai = sql("INSERT INTO ai_analyses(user_id,device_id,target_date,analysis) VALUES(%s,%s,%s::date,'fixture location description') RETURNING id", (owner, target, window))
sql("INSERT INTO ai_analysis_requests(user_id,request_id,device_id,target_date,analysis_id) VALUES(%s,'fixture',%s,%s::date,%s)", (owner, target, window, ai))
sql('INSERT INTO share_tokens(token,device_id,created_by,expires_at) VALUES(%s,%s,%s,now()+interval \'1 day\')', (tag, target, owner))
ev = sql("INSERT INTO events(device_id,occurred_at,kind,user_id,data,notified_at) VALUES(%s,%s,'wake',%s,'{"+'"location":"fixture"'+"}',now()) RETURNING id", (target, window, owner))
ft = sql("INSERT INTO fcm_tokens(user_id,token,platform,active) VALUES(%s,%s,'android',false) RETURNING id", (owner, tag))
outbox = sql("INSERT INTO fcm_outbox(event_id,token_id,user_id,message,lease_until,available_at) VALUES(%s,%s,%s,jsonb_build_object('data',jsonb_build_object('device_id',%s::text)),now()+interval '1 hour',now()+interval '2 hours') RETURNING id", (ev, ft, owner, target))
job = uuid.uuid4()
report = run(db, target, owner, 'fixture-1', sim, owner, job)
assert not report['executed'] and sql('SELECT count(*) FROM location_records WHERE device_id=%s', (target,)) == 3
try:
    run(db, target, previous, 'fixture-1', sim, owner, job, True)
    raise AssertionError('Wrong owner accepted')
except RuntimeError:
    pass
assert not sql('SELECT blocked FROM device_data_controls WHERE device_id=%s', (target,))
print('PASS exact target guard and read-only preview', flush=True)

# A worker already writing must commit before begin can acquire its barrier.
writer = connect(); writer.autocommit = False
sql('SELECT privacy_assert_device_writable(%s)', (target,), writer)
with concurrent.futures.ThreadPoolExecutor() as pool:
    def begin():
        with connect() as c:
            return sql('SELECT privacy_begin_device_erasure(%s,%s,%s,%s,%s)', (str(job), target, owner, 'fixture-1', owner), c)
    future = pool.submit(begin)
    time.sleep(.3)
    assert not future.done()
    writer.commit(); writer.close()
    assert future.result(timeout=10) == str(job)
fails('SELECT privacy_erase_device_primary(%s)', (str(job),))
assert sql('SELECT count(*) FROM location_records WHERE device_id=%s', (target,)) == 3
# Delivery completion cannot write stale notification data after the barrier.
fails("UPDATE fcm_outbox SET status='sent' WHERE id=%s", (outbox,), '55000')
sql('DELETE FROM fcm_outbox WHERE id=%s', (outbox,))
doc = sql("INSERT INTO device_documents(user_id,device_id,kind,filename,stored_path,mime,size_bytes) VALUES(%s,%s,'other','fixture','/fixture/not-a-file','text/plain',1) RETURNING id", (owner, target))
fails('SELECT privacy_erase_device_primary(%s)', (str(job),))
assert sql('SELECT state FROM device_data_erasure_jobs WHERE id=%s', (str(job),)) == 'blocked'
sql('DELETE FROM device_documents WHERE id=%s', (doc,))
print('PASS concurrent writer fence; inflight delivery/file refusal preserves source rows', flush=True)

counts = sql('SELECT privacy_erase_device_primary(%s)', (str(job),))
assert counts['location_records'] == 3 and counts['ai_analyses'] == 1 and counts['fleet_site_visits'] == 1
assert sql('SELECT analysis_id FROM ai_analysis_requests WHERE user_id=%s AND request_id=\'fixture\'', (owner,)) is None
fails('SELECT privacy_verify_device_erasure(%s)', (str(job),))
assert sql('SELECT state FROM device_data_erasure_jobs WHERE id=%s', (str(job),)) == 'primary_erased'
assert sql('SELECT privacy_erase_device_primary(%s)', (str(job),)) == counts
report = run(db, target, owner, 'fixture-1', sim, owner, job, True)
assert report['state'] == 'active_db_verified' and not report['external_copies_verified']
assert run(db, target, owner, 'fixture-1', sim, owner, job, True)['deleted_counts'] == counts
for table, before in baseline.items():
    assert sql(f"SELECT md5(string_agg(to_jsonb(r)::text,',' ORDER BY to_jsonb(r)::text)) FROM {table} r WHERE device_id=%s", (other,)) == before, table
assert sql('SELECT device_id FROM fleet_vehicle_bindings WHERE id=%s', (binding,)) == target
assert sql('SELECT iccid FROM devices WHERE id=%s', (target,)) == sim
print('PASS compressed raw/owner/NULL erasure, derived rows, aggregate failure/resume, other SIM unchanged', flush=True)

late_queries = [
 ('INSERT INTO location_records(device_id,recorded_at,source,fix) VALUES(%s,now(),\'l80\',false)', (target,)),
 ('INSERT INTO daily_stats(device_id,date,user_id) VALUES(%s,current_date,%s)', (target, owner)),
 ("INSERT INTO ai_analyses(user_id,device_id,target_date,analysis) VALUES(%s,%s,current_date,'late')", (owner, target)),
 ('INSERT INTO fleet_site_cursors(binding_id,last_at) VALUES(%s,now())', (binding,)),
 ('UPDATE devices SET last_lat=38 WHERE id=%s', (target,)),
 ('UPDATE devices SET owner_id=%s WHERE id=%s', (previous, target)),
 ('INSERT INTO share_tokens(token,device_id,created_by,expires_at) VALUES(%s,%s,%s,now())', (tag+'late', target, owner)),
]
for query, args in late_queries:
    fails(query, args, '55000')
print('PASS stale raw/stat/AI/site/cache/share writers and ownership transfer rejected', flush=True)

key = hashlib.sha256(b'fixture-only-hmac-key').digest()
auth = 'hw-'+tag
sql('INSERT INTO hardware_credentials(auth_uid,key_digest,authorized_owner_id) VALUES(%s,%s,%s)', (auth, key, owner))


def send(sim_number, n, valid=True, expected=200):
    raw = json.dumps({'iccid': sim_number, 'l80': {'fix': True, 'lat': 37.5, 'lng': 127.5}}, separators=(',', ':')).encode()
    signature = hmac.new(key, f'{auth}\n{n}\n'.encode()+raw, hashlib.sha256).hexdigest()
    headers = {'Content-Type': 'application/json', 'X-GPS-Auth-Version': '2', 'X-GPS-UID': auth,
               'X-GPS-Counter': str(n), 'X-GPS-Signature': signature if valid else '0'*64}
    try:
        with urllib.request.urlopen(urllib.request.Request(BASE+'/gps-tracker/ingest', data=raw, headers=headers), timeout=10) as r:
            status, body = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, body = e.code, e.read()
    assert status == expected, (status, expected, body[:150])
    if status != 200:
        return
    out = json.loads(body)
    signed = f"response\n{auth}\n{n}\n{out['payload']}".encode()
    assert hmac.compare_digest(out['signature'], hmac.new(key, signed, hashlib.sha256).hexdigest())
    return json.loads(base64.b64decode(out['payload']))


for n in (1, 2):
    response = send(sim, n)
    assert response['ok'] and response['stored'] is False and response['privacy_blocked']
send(sim, 2, expected=409)
send(sim, 3, valid=False, expected=401)
assert send(other_sim, 3)['ok']
assert sql('SELECT count(*) FROM location_records WHERE device_id=%s', (target,)) == 0
assert sql('SELECT count(*) FROM location_records WHERE device_id=%s', (other,)) == 4
assert sql('SELECT key_digest FROM hardware_credentials WHERE auth_uid=%s', (auth,)).tobytes() == key
print('PASS signed blocked ACK, replay/forgery denial, unchanged key and another SIM receiving', flush=True)

# Retained aggregates can outlive their raw source. Rebuilding the entire time
# window must never silently erase another SIM's only remaining history.
stale, stale_sim = device(3)
neighbor, neighbor_sim = device(4)
old = sql("SELECT date_trunc('day',now())-interval '90 days'")
insert_old = "INSERT INTO location_records(device_id,recorded_at,source,fix,lat,lng,user_id) VALUES(%s,%s,'l80',true,37.1,127.1,%s)"
for did in (stale, neighbor):
    sql(insert_old, (did, old, owner))
for view in AGGREGATES:
    sql('CALL refresh_continuous_aggregate(%s,%s,%s+interval \'1 day\')', (view, old, old))
sql('DELETE FROM location_records WHERE device_id IN (%s,%s)', (stale, neighbor))
stale_job = uuid.uuid4()
try:
    run(db, stale, owner, 'fixture-3', stale_sim, owner, stale_job, True)
    raise AssertionError('Retention-expired other SIM history was exposed to refresh')
except RuntimeError as e:
    assert 'aggregate inputs differ' in str(e)
assert sql('SELECT state FROM device_data_erasure_jobs WHERE id=%s', (str(stale_job),)) == 'blocked'
assert sql('SELECT count(*) FROM location_1min WHERE device_id=%s', (neighbor,)) == 1
sql(insert_old, (neighbor, old, owner))
assert run(db, stale, owner, 'fixture-3', stale_sim, owner, stale_job, True)['state'] == 'active_db_verified'
assert sql('SELECT count(*) FROM location_1min WHERE device_id=%s', (stale,)) == 0
assert sql('SELECT count(*) FROM location_1min WHERE device_id=%s', (neighbor,)) == 1
print('PASS orphan target aggregates removed; other SIM retained-only aggregate blocks refresh', flush=True)
db.close()
