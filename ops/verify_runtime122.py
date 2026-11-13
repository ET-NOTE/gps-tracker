"""Synthetic native122 resource/privacy acceptance; no production connection."""
import hashlib
import http.client
import json
import os
import socket
import pwd
import time
import uuid
from pathlib import Path
import sys
from unittest.mock import patch
import psycopg
import psycopg2
from load_runtime122 import ROOT, DSN, runtime, sql, save, job, start, stop_api, Client, b, cgroups
from privacy_worker_db import connect
from privacy_file_cleanup import process_one


def cfg():
    return dict(DATABASE_URL=runtime(),GPS_LOCATION_ENCRYPTION='pilot',
        GPS_LOCATION_KEYRING_FILE=str(ROOT/'test-keys.json'),
        UPLOAD_DIR=str(ROOT/'test-storage/uploads'),PRIVATE_UPLOAD_DIR=str(ROOT/'test-storage/private'))


def drain():
    stop_api()
    results=[]
    for _ in range(100):
        value=job('cleanup',worker=cfg())['processed']
        if value is None:break
        assert not value.get('deferred'),value
        results.append(value)
    else:raise AssertionError('queue did not drain')
    assert sql("SELECT count(*) FROM privacy_file_cleanup WHERE state IN ('pending','retry')")==[(0,)]
    return results


def contention():
    drained=drain();items=[]
    for legacy in (False,True):
        path=ROOT/'test-storage/uploads/device_documents/1/1'/('contention122-'+uuid.uuid4().hex+'.bin')
        path.write_bytes(b'GPSFILE1\nsynthetic-contention-fixture')
        uid=pwd.getpwnam('gps-api').pw_uid;os.chown(path,uid,uid)
        qid=sql("INSERT INTO privacy_file_cleanup(storage_kind,storage_key,reason,source_table,source_id) VALUES('document',%s,'runtime122','synthetic',122) RETURNING id",(str(path),))[0][0]
        # Both supported adapters: psycopg3 encrypted worker and legacy2 caller.
        worker=psycopg2.connect(runtime()) if legacy else connect(cfg())
        lock=psycopg2.connect(DSN)
        try:
            with lock.cursor() as q:q.execute('LOCK TABLE devices IN ROW EXCLUSIVE MODE')
            began=time.monotonic();result=process_one(worker,cfg());elapsed=time.monotonic()-began
            assert result=={'deferred':True,'reason':'lock_busy'} and 1.8<elapsed<5
            assert path.exists() and sql('SELECT state,attempts FROM privacy_file_cleanup WHERE id=%s',(qid,))==[('pending',0)]
            assert sql('SELECT count(*) FROM privacy_file_cleanup_events WHERE job_id=%s',(qid,))==[(0,)]
            lock.rollback()
            # Failure outside lock contention must not become a successful retry.
            with patch('privacy_file_cleanup._process_one',side_effect=psycopg.errors.InsufficientPrivilege('synthetic')):
                try:process_one(worker,cfg())
                except psycopg.errors.InsufficientPrivilege:pass
                else:raise AssertionError('unrelated failure swallowed')
            result=process_one(worker,cfg())
            assert result['job_id']==qid and result['state']=='local_absent' and not path.exists()
            assert sql('SELECT count(*) FROM privacy_file_cleanup_events WHERE job_id=%s',(qid,))==[(1,)]
            assert process_one(worker,cfg()) is None
            items.append(dict(adapter='psycopg2' if legacy else 'psycopg3',deferred_seconds=elapsed,
                pending_unchanged=True,transaction_usable_after_rollback=True,retry_deleted_once=True,other_errors_propagate=True))
        finally:lock.rollback();lock.close();worker.close()
    save('cleanup-contention122',dict(passed=items,previous_synthetic_jobs_drained=len(drained)))
    start(300);print('PASS both worker adapters: lock deferral, rollback, durable job, retry, unrelated errors')


def limits():
    # Called while the24-client stand-in is running. No real project roles.
    count=sql("SELECT count(*) FROM pg_stat_activity WHERE usename='other122' AND backend_type='client backend'")[0][0]
    assert count==24,count
    denied=False
    try:
        extra=psycopg2.connect(DSN.replace('postgres:closure-test-only','other122:synthetic-only'))
    except psycopg2.OperationalError as e:
        assert 'too many connections for role' in str(e);denied=True
    else:extra.close()
    assert denied
    assert sql('SELECT 1')==[(1,)]
    save('connection-boundary122',dict(other_clients=count,client25_rejected=True,operations_connection_available=True))
    print('PASS24-client cap,25th denied, operations remains available')


def reference_guard():
    drain()
    d=b.fixture()['devices'][0]
    path=ROOT/'test-storage/uploads/device_documents/1/1'/('reference122-'+uuid.uuid4().hex+'.bin')
    path.write_bytes(b'GPSFILE1\nsynthetic-shared-reference')
    uid=pwd.getpwnam('gps-api').pw_uid;os.chown(path,uid,uid)
    qid=sql("INSERT INTO privacy_file_cleanup(storage_kind,storage_key,reason,source_table,source_id) VALUES('document',%s,'runtime122','synthetic',122) RETURNING id",(str(path),))[0][0]
    lock=psycopg2.connect(DSN);worker=connect(cfg())
    try:
        with lock.cursor() as q:
            q.execute("INSERT INTO device_documents(user_id,device_id,kind,filename,stored_path,mime,size_bytes) VALUES(%s,%s,'other','synthetic.bin',%s,'application/octet-stream',36) RETURNING id",(d['user_id'],d['device_id'],str(path)))
            doc=q.fetchone()[0]
        assert process_one(worker,cfg())=={'deferred':True,'reason':'lock_busy'}
        assert path.exists()
        lock.commit()
        result=process_one(worker,cfg());assert result['state']=='shared' and path.exists()
        assert sql('SELECT local_verified_at FROM privacy_file_cleanup WHERE id=%s',(qid,))==[(None,)]
        sql('DELETE FROM device_documents WHERE id=%s',(doc,))
        sql('UPDATE privacy_file_cleanup SET next_attempt_at=now() WHERE id=%s',(qid,))
        result=process_one(worker,cfg());assert result['state']=='local_absent' and not path.exists()
    finally:lock.rollback();lock.close();worker.close()
    save('reference-guard122',dict(uncommitted_reference_deferred=True,committed_reference_preserved=True,
        not_reported_deleted_while_shared=True,deleted_after_last_reference_removed=True))
    start(300);print('PASS reference added during contention survives; deleted only after final reference removed')


def final():
    client=Client();tests=[]
    data=b.fixture()
    for d in data['devices']:
        for name,path in (b.routes(d['device_id'])[:3] if d in data['devices'][:4] else b.routes(d['device_id'])[2:]):
            status,body,_,elapsed=client.get(path,d['user_id'])
            assert status==200,(name,status,body[:100])
            if name=='fleet_xlsx':assert body[:2]==b'PK'
            elif name=='fleet_csv':assert len(body.decode('utf-8-sig').splitlines())>=32
            elif name=='fleet_trips':assert len(json.loads(body))==31
            tests.append(dict(device=d['device_id'],route=name,status=status,seconds=elapsed,bytes=len(body),sha256=hashlib.sha256(body).hexdigest()))
        foreign=next(x for x in data['users'] if x!=d['user_id'])
        assert client.get(b.routes(d['device_id'])[2][1],foreign)[0]==404
    clear=http.client.HTTPConnection('127.0.0.1',3043,timeout=5)
    clear.request('POST','/gps-tracker/ingest',b'{}',{'Content-Type':'application/json'})
    response=clear.getresponse();response.read();assert response.status==426;clear.close()
    # TLS present is not authentication; unknown/signed-invalid hardware stays rejected.
    status,_,_,_=client.get('/gps-tracker/ingest',body=b'{}',headers={'Content-Type':'application/json',
        'X-GPS-Auth-Version':'2','X-GPS-Uid':'unregistered-runtime122','X-GPS-Counter':'1','X-GPS-Signature':'00'*32})
    assert status==401,status
    cleaned=drain()
    state=dict(schema=sql('SELECT max(version) FROM _sqlx_migrations')[0][0],
        plaintext_locations=sql('SELECT count(*) FROM location_records WHERE lat IS NOT NULL OR lng IS NOT NULL OR fixes_jsonb IS NOT NULL')[0][0],
        idle_transactions=sql("SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction'")[0][0],
        images=sql('SELECT count(*) FROM privacy_image_payloads')[0][0],
        pending_cleanup=sql("SELECT count(*) FROM privacy_file_cleanup WHERE state IN ('pending','retry')")[0][0],
        cleanup_tail=len(cleaned),foreign_denied=8,cleartext_denied=426,invalid_hardware_denied=status,
        renderers=sum(p.read_text().strip()=='gps-pdf-render' for p in Path('/proc').glob('[0-9]*/comm') if p.exists()),
        ready_days=sql("SELECT count(*) FROM daily_stats WHERE date BETWEEN '2026-10-01' AND '2026-10-31'")[0][0],
        queries=tests,production_modified=False,activation_ready=False)
    assert state['schema']==112 and state['ready_days']==248
    assert all(state[k]==0 for k in ('plaintext_locations','idle_transactions','images','pending_cleanup','renderers'))
    save('final-state122',state);print('PASS28 queries,8 foreign denials,TLS/auth gates,encrypted DB and drained queues')


def cancellation():
    def active():return sql("SELECT pid,wait_event_type FROM pg_stat_activity WHERE application_name LIKE 'gps-read-%'")
    def wait(predicate):
        began=time.monotonic()
        while time.monotonic()-began<5:
            if predicate():return time.monotonic()-began
            time.sleep(.025)
        raise AssertionError('cancel/slot reuse deadline')
    data=b.fixture()['devices'][0];client=Client();results=[]
    for name,path in b.routes(data['device_id'])[:3]:
        lock=psycopg2.connect(DSN);connections=[]
        def open_read():
            c=http.client.HTTPSConnection('127.0.0.1',8443,context=client.tls,timeout=10)
            c.request('GET',path,headers={'Authorization':'Bearer '+b.token(data['user_id'])});connections.append(c)
            return c
        def close_read(c):c.sock.shutdown(socket.SHUT_RDWR);c.close()
        try:
            with lock.cursor() as q:q.execute("SET LOCAL lock_timeout='5s'; LOCK TABLE location_records IN ACCESS EXCLUSIVE MODE")
            first,second=open_read(),open_read()
            wait(lambda:len(active())==2 and all(x[1]=='Lock' for x in active()))
            status,body,headers,_=client.get(path,data['user_id'])
            assert status==429 and json.loads(body)['code']=='location_read_busy' and headers['retry-after']=='2'
            close_read(first);elapsed=wait(lambda:len(active())==1)
            replacement=open_read();wait(lambda:len(active())==2)
            close_read(second);close_read(replacement);wait(lambda:not active())
        finally:
            for c in connections:c.close()
            lock.rollback();lock.close()
        assert client.get(path,data['user_id'])[0]==200
        results.append(dict(route=name,cancel_seconds=elapsed,retry_after_respected=True,slot_reused=True))
    save('cancellation122',dict(passed=results,remaining_queries=len(active())))
    print('PASS TLS cancel/429/slot reuse for3 encrypted paths')


if __name__=='__main__':
    {'contention':contention,'limits':limits,'final':final,'cancellation':cancellation,'reference':reference_guard}[sys.argv[1]]()
