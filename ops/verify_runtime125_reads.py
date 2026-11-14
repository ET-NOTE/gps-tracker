"""Actual API reads from a restored113 DB and HTTPS cancellation after reboot."""
import hashlib
import http.client
import json
from pathlib import Path
import subprocess
import psycopg
from runtime121_control import ROOT, DSN, boot_settled, stop_api, transition, drain
import load_runtime122 as load

load.b.JWT = 'synthetic-cumulative-migration-only'
load.b.SHA = (ROOT/'candidate124.sha256').read_text().strip()


def read(uid, did, tls=False):
    rows=[]
    for name,path in load.b.routes(did)[:3]:
        if tls:
            status,body,_,elapsed=load.Client().get(path,uid)
        else:
            c=http.client.HTTPConnection('127.0.0.1',3043,timeout=60)
            c.request('GET',path,headers={'Authorization':'Bearer '+load.b.token(uid)})
            r=c.getresponse();status=r.status;body=r.read();c.close();elapsed=None
        assert status==200,(name,status,body[:160])
        assert json.loads(body),name
        rows.append(dict(route=name,status=status,bytes=len(body),sha256=hashlib.sha256(body).hexdigest(),seconds=elapsed))
    return rows


def restored(dsn, runtime, uid, did, ring):
    with psycopg.connect(dsn,autocommit=True) as db:
        assert db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone()==(113,)
        assert db.execute('SELECT maintenance FROM location_storage_policy').fetchone()==(True,)
        definition=db.execute("SELECT pg_get_functiondef('location_query_records_between(bigint,bigint,timestamptz,timestamptz)'::regprocedure)").fetchone()[0]
        assert 'AND r.device_id=wanted_device' in definition
    #Clone is still fenced until both restored DB/file hashes have passed in caller.
    transition(dsn,ring,str(ROOT/'test-storage/uploads'),str(ROOT/'test-storage/private'),'resume')
    boot_settled(dict(RUNTIME_DSN=runtime,STORAGE='pilot'))
    try:
        rows=read(uid,did)
        load.save('restored-api125',dict(schema=113,restored113_function=True,queries=rows,
            plaintext_bypass=False,api_sha256=load.b.SHA,transport='isolated loopback HTTP; not TLS evidence'))
    finally:stop_api()
    print('PASS restored113 DB through actual non-owner API: aggregate/history/page',flush=True)


def final():
    cred=json.loads((ROOT/'test-runtime.json').read_text())
    runtime=DSN.replace('postgres:closure-test-only',cred['user']+':'+cred['password'])
    with psycopg.connect(DSN,autocommit=True) as db:
        did,uid=db.execute("SELECT id,owner_id FROM devices WHERE device_uid='cumulative119-sim'").fetchone()
    env=dict(RUNTIME_DSN=runtime,STORAGE='pilot')
    boot_settled(env)
    load.tls()
    rows=read(uid,did,tls=True)
    previous=json.loads((ROOT/'out/restored-api125.json').read_text())['queries']
    assert [(x['route'],x['sha256']) for x in rows]==[(x['route'],x['sha256']) for x in previous]
    load.b.fixture=lambda:dict(devices=[dict(device_id=did,user_id=uid)])
    import verify_runtime124 as verify
    verify.select=lambda:boot_settled(env)
    verify.fairness()
    with psycopg.connect(DSN,autocommit=True) as db:
        foreign=db.execute("SELECT id FROM users WHERE id<>%s LIMIT 1",(uid,)).fetchone()[0]
    assert load.Client().get(load.b.routes(did)[2][1],foreign)[0]==404
    stop_api();drain()
    with psycopg.connect(DSN,autocommit=True) as db:
        state=dict(schema=db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone()[0],
            plaintext_locations=db.execute('SELECT count(*) FROM location_records WHERE lat IS NOT NULL OR lng IS NOT NULL OR fixes_jsonb IS NOT NULL').fetchone()[0],
            idle_transactions=db.execute("SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction'").fetchone()[0],
            images=db.execute('SELECT count(*) FROM privacy_image_payloads').fetchone()[0],
            pending_cleanup=db.execute("SELECT count(*) FROM privacy_file_cleanup WHERE state IN ('pending','retry')").fetchone()[0])
    assert state['schema']==113
    assert all(v==0 for k,v in state.items() if k!='schema'),state
    state.update(queries=rows,restored_and_rebooted_responses_equal=True,foreign_denied=404,
        tls='TLS1.2, verified synthetic localhost certificate',production_modified=False,activation_ready=False)
    load.save('final-state125',state)
    print('PASS post-reboot TLS1.2 read/cancel/429, restored result equality and foreign denial; plaintext/temp/idle0',flush=True)


if __name__=='__main__':final()
