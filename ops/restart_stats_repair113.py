"""Real process interruption: baseline112 fails catchup; repair113 resumes.
All data and credentials are synthetic in an internal disposable Docker network.
"""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import time
from urllib.parse import quote
import psycopg2

JOB=pathlib.Path('/home/etcom-hub/build/gps-provision22-20261111repair113')
NET='gps-provision22-test-20261111repair113'
API='gps-provision22-api-20261111repair113'
DB='gps-provision22-db-20261111repair113'
report={'scope':'synthetic isolated build host; no production','schema':112,'checks':{}}

def ip(name):
    return subprocess.check_output(['docker','inspect','-f','{{(index .NetworkSettings.Networks "'+NET+'").IPAddress}}',name],text=True).strip()

def sql(query,args=()):
    with conn.cursor() as c:
        c.execute(query,args)
        return c.fetchall() if c.description else []

def count(table):
    assert table in ('daily_stats','stats_rebuild_queue')
    return sql('SELECT count(*) FROM '+table+' WHERE device_id=%s',(did,))[0][0]

def wait(check,seconds=45):
    start=time.monotonic()
    while time.monotonic()-start<seconds:
        if check():return round(time.monotonic()-start,3)
        time.sleep(.2)
    raise AssertionError('timed out waiting for isolated worker')

def api(command):
    subprocess.run(['bash',str(JOB/'dev22.sh'),command],env=env,check=True,stdout=subprocess.DEVNULL)

def seed(start,end):
    sql("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng) SELECT %s,%s,'2026-10-01 00:00+09'::timestamptz+d*interval '1 day'+p*interval '1 minute','l80',true,37+p*0.001,127 FROM generate_series(%s,%s) d CROSS JOIN generate_series(0,2) p",(did,uid,start,end))

def digest():
    return sql("SELECT md5(string_agg(row_to_json(r)::text,'' ORDER BY recorded_at,source)) FROM location_records r WHERE device_id=%s",(did,))[0][0]

assert JOB.resolve()==JOB
assert json.loads(subprocess.check_output(['docker','network','inspect',NET]))[0]['Internal']
creds=json.loads((JOB/'test-runtime.json').read_text())
env=os.environ.copy()
env.update(STORAGE='pilot',RUNTIME_DSN='postgres://gps_runtime:'+quote(creds['password'])+'@closure-db:5432/gps_closure_test')
conn=psycopg2.connect('postgres://postgres:closure-test-only@'+ip(DB)+'/gps_closure_test');conn.autocommit=True
sql("SELECT set_config('gps.storage_keys',%s,false)",((JOB/'test-keys.json').read_text(),))
sql('UPDATE location_storage_policy SET enabled=true')
sql('UPDATE devices SET owner_id=NULL')
sql('DELETE FROM stats_rebuild_queue')
uid=sql("INSERT INTO users(email,password_hash,phone) VALUES('restart113@example.invalid','no-login','restart113') RETURNING id")[0][0]
did=sql("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,'restart113-sim','') RETURNING id",(uid,))[0][0]
seed(0,2)
candidate=JOB/'out/gps-tracker-api.repair113'
shutil.copy2(JOB/'out/gps-tracker-api',candidate)
shutil.copy2(JOB/'out/gps-tracker-api.baseline112',JOB/'out/gps-tracker-api')
try:
    api('api');wait(lambda:count('daily_stats')==3);api('stop')
    seed(3,30)
    api('api');time.sleep(7)
    assert count('daily_stats')==3 and count('stats_rebuild_queue')==0
    report['checks']['baseline112_partial_stays3']=True
    api('stop')
    shutil.copy2(candidate,JOB/'out/gps-tracker-api')
    raw_before=digest()
    first_updated=sql('SELECT updated_at FROM daily_stats WHERE device_id=%s ORDER BY date LIMIT 3',(did,))
    sql("CREATE FUNCTION repair113_crash_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(30); RETURN NEW; END $$")
    sql("CREATE TRIGGER repair113_crash_gate BEFORE INSERT OR UPDATE ON daily_stats FOR EACH ROW WHEN(NEW.device_id="+str(did)+" AND NEW.date='2026-10-05') EXECUTE FUNCTION repair113_crash_gate()")
    api('api')
    wait(lambda:count('daily_stats')==4 and bool(sql("SELECT 1 FROM pg_stat_activity WHERE wait_event='PgSleep'")))
    api('kill')
    wait(lambda:not sql("SELECT 1 FROM pg_stat_activity WHERE wait_event='PgSleep'"),40)
    assert count('daily_stats')==4 and count('stats_rebuild_queue')==27
    report['checks']['sigkill_committed4_pending27']=True
    sql('DROP TRIGGER repair113_crash_gate ON daily_stats');sql('DROP FUNCTION repair113_crash_gate()')
    started=time.monotonic();api('api');wait(lambda:count('daily_stats')==31 and count('stats_rebuild_queue')==0)
    report['restart_to_complete_seconds']=round(time.monotonic()-started,3)
    rows=sql('SELECT count(*),sum(fix_count),min(distance_m),max(distance_m) FROM daily_stats WHERE device_id=%s AND user_id=%s',(did,uid))[0]
    assert rows[0:2]==(31,93) and 220<rows[2]<225 and 220<rows[3]<225
    assert digest()==raw_before
    assert first_updated==sql('SELECT updated_at FROM daily_stats WHERE device_id=%s ORDER BY date LIMIT 3',(did,))
    assert sql('SELECT bool_and(lat IS NULL AND lng IS NULL AND lat_sealed IS NOT NULL AND lng_sealed IS NOT NULL) FROM location_records WHERE device_id=%s',(did,))[0][0]
    report['checks'].update(restart_completed31=True,fixes93=True,encrypted_original_unchanged=True,existing3_not_rewritten=True)
    report['daily_stats']={'days':rows[0],'fix_count':rows[1],'min_distance_m':rows[2],'max_distance_m':rows[3]}
    report['api_sha256']=hashlib.sha256(candidate.read_bytes()).hexdigest()
    report['resources']=subprocess.check_output(['docker','stats','--no-stream','--format','{{.Name}} {{.MemUsage}} {{.CPUPerc}}',API,DB],text=True).strip()
    api('stop')
    report['passed']=True
finally:
    shutil.copy2(candidate,JOB/'out/gps-tracker-api')
    (JOB/'out/process-restart.json').write_text(json.dumps(report,indent=2))
    conn.close()
print(json.dumps(report,indent=2))
