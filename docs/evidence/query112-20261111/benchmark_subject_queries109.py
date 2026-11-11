"""Measure actual list/projection SQL against the fixed synthetic 32k-row job.

Run after check_cumulative109.py. No production endpoint or messages are used.
Read query text from Rust sources, so this is not a simplified count benchmark.
"""
import datetime as dt
import hashlib
import json
import pathlib
import re
import subprocess
import time

import psycopg

JOB=pathlib.Path('/home/etcom-hub/build/gps-provision22-20261111cumulative112')
assert pathlib.Path(__file__).resolve().parent==JOB
NET='gps-provision22-test-20261111cumulative112'
DB='gps-provision22-db-20261111cumulative112'
inspect=lambda kind,name:json.loads(subprocess.check_output(['docker',kind,'inspect',name]))[0]
assert inspect('network',NET)['Internal']
info=inspect('container',DB)
assert '/var/lib/postgresql/data' in info['HostConfig']['Tmpfs'] and not info['HostConfig']['PortBindings']
host=info['NetworkSettings']['Networks'][NET]['IPAddress']
db=psycopg.connect('postgres://postgres:closure-test-only@'+host+'/gps_closure_test',autocommit=True)
db.execute("SET statement_timeout='60s'; SET jit=off")
owner,subject=db.execute("SELECT owner_id,subject_id FROM location_subject_mappings WHERE device_id=900000 AND status='confirmed'").fetchone()
assert db.execute('SELECT count(*) FROM location_subject_mappings WHERE owner_id=%s',(owner,)).fetchone()==(32000,)
# Make every synthetic mapping's existing identifiers resolve to actual vehicle
# and SIM assets. Projection would otherwise exit early on empty joins.
db.execute("INSERT INTO devices(id,owner_id,device_uid,api_key_hash) SELECT i,%s,'mapping109-sim-'||i,'' FROM generate_series(900000,900999) i",(owner,))
db.execute("INSERT INTO fleet_vehicles(id,owner_id,name) SELECT i,%s,'Synthetic '||i FROM generate_series(900000,900999) i",(owner,))
db.execute("INSERT INTO fleet_vehicle_bindings(id,owner_id,vehicle_id,device_id,terminal_name,is_primary,started_at) SELECT i,%s,i,i,'Synthetic',true,'2026-10-01' FROM generate_series(900000,900999) i",(owner,))
for uid in (owner,subject):
    db.execute('INSERT INTO privacy_account_controls(user_id,restricted) VALUES(%s,false) ON CONFLICT(user_id) DO UPDATE SET restricted=false',(uid,))
for table in ('devices','fleet_vehicles','fleet_vehicle_bindings','location_subject_mappings','fleet_staff_accounts'):
    db.execute('ANALYZE '+table)
routes=(JOB/'src/gps-tracker-api/src/routes/subject_provision.rs').read_text()
lists=re.findall(r'query_scalar\("(SELECT to_jsonb\(m\).*?)"\)',routes)
assert len(lists)==2
projection=(JOB/'src/gps-tracker-api/src/services/subject_projection.rs').read_text().split('query_as::<_, Span>(r#"',1)[1].split('"#)',1)[0]
utc=dt.timezone.utc
start=dt.datetime(2026,11,1,tzinfo=utc);end=start+dt.timedelta(days=1)
queries=[('subject_list_200',lists[0],{'p1':subject,'p2':None},200),
         ('company_list_200',lists[1],{'p1':owner},200),
         ('company_projection_1000',projection,dict(p1=owner,p2=owner,p3=start,p4=end,p5=None,p6=None),1000),
         ('company_projection_one',projection,dict(p1=owner,p2=owner,p3=start,p4=end,p5=900000,p6=None),1)]
result={'environment':'isolated synthetic; DB 2 CPU tmpfs','schema':112,'production_modified':False,
        'external_messages':0,'synthetic_mapping_rows':32000,'queries':[],'all_passed':False}
for name,source,args,count in queries:
    query=re.sub(r'\$(\d+)',lambda m:'%(p'+m[1]+')s',source)
    samples=[]
    for _ in range(3):
        before=time.monotonic();rows=db.execute(query,args).fetchall()
        samples.append(round(time.monotonic()-before,4))
        assert len(rows)==count,(name,len(rows))
        if 'list' in name:
            assert sum(bool(r[0]['effective']) for r in rows)==7
    plan=db.execute('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+query,args).fetchone()[0]
    (JOB/'out'/('mapping109-'+name+'-plan.json')).write_text(json.dumps(plan,indent=2)+'\n')
    result['queries'].append({'name':name,'rows':count,'source_sql_sha256':hashlib.sha256(source.encode()).hexdigest(),
        'seconds':samples,'budget_seconds':2 if name.endswith('_one') else 5})
    (JOB/'out/mapping109-queries.json').write_text(json.dumps(result,indent=2)+'\n')
    assert max(samples)<result['queries'][-1]['budget_seconds'],name+' exceeds acceptance budget'
result['all_passed']=True
(JOB/'out/mapping109-queries.json').write_text(json.dumps(result,indent=2)+'\n')
db.close()
print(json.dumps(result,indent=2))
