"""Actual signed/TLS fault, replay, pause and advisory-lock checks; synthetic only."""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import json
import os
import sys
import time
import uuid
import run_runtime130 as r
l=r.l


def run(variant):
    assert variant in ('baseline','candidate');r.select()
    key=os.urandom(32);uid='runtime130-guard-'+uuid.uuid4().hex;iccid='89'+str(time.time_ns())[-17:]
    owner=l.b.fixture()['users'][0]
    did=l.sql("INSERT INTO devices(owner_id,device_uid,iccid,api_key_hash) VALUES(%s,%s,%s,'') RETURNING id",(owner,uid,iccid))[0][0]
    l.sql('INSERT INTO hardware_credentials(auth_uid,key_digest,authorized_owner_id) VALUES(%s,%s,%s)',(uid,key,owner))
    l.secret(l.ROOT/('ingest130-keys-guard-'+variant+'-'+uid+'.json'),json.dumps([key.hex()]))
    def send(counter,broken=False,fixes=None):
        payload=dict(device_uid=uid,iccid=iccid,ts=counter,boot=1)
        payload.update(fixes if fixes is not None else dict(l80=dict(fix=True,lat=37.345,lng=127.456,sat=12)))
        body=json.dumps(payload,separators=(',',':')).encode()
        signature=hmac.new(key,f'{uid}\n{counter}\n'.encode()+body,hashlib.sha256).hexdigest()
        if broken:signature='0'*64
        status,data,_,elapsed=l.Client(timeout=10).get('/gps-tracker/ingest',body=body,headers={
            'Content-Type':'application/json','X-GPS-Auth-Version':'2','X-GPS-Uid':uid,
            'X-GPS-Counter':str(counter),'X-GPS-Signature':signature})
        value=None
        if status==200:
            signed=json.loads(data)
            expected=hmac.new(key,f"response\n{uid}\n{counter}\n{signed['payload']}".encode(),hashlib.sha256).hexdigest()
            assert hmac.compare_digest(signed['signature'],expected) and signed['counter']==counter
            value=json.loads(base64.b64decode(signed['payload']))
        return status,value,elapsed
    def count():return l.sql('SELECT count(*) FROM location_records WHERE device_id=%s',(did,))[0][0]
    l.sql(f"CREATE FUNCTION runtime130_reject_stats() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.device_id={did} THEN RAISE EXCEPTION 'synthetic130 stats failure'; END IF; RETURN NEW; END $$")
    l.sql('CREATE TRIGGER runtime130_reject_stats BEFORE INSERT ON stats_rebuild_queue FOR EACH ROW EXECUTE FUNCTION runtime130_reject_stats()')
    try:
        status,_,_=send(1);assert status==500
        remaining=count();expected=1 if variant=='baseline' else 0
        assert remaining==expected,(variant,remaining)
        assert l.sql('SELECT last_counter FROM hardware_credentials WHERE auth_uid=%s',(uid,))==[(0,)]
        latest=l.sql('SELECT last_fix_at IS NOT NULL FROM gps_read_devices WHERE id=%s',(did,))[0][0]
        if variant=='candidate':assert not latest
        assert l.sql('SELECT count(*) FROM stats_rebuild_queue WHERE device_id=%s',(did,))==[(0,)]
    finally:
        l.sql('DROP TRIGGER runtime130_reject_stats ON stats_rebuild_queue');l.sql('DROP FUNCTION runtime130_reject_stats()')
    status,value,_=send(1);assert status==200 and value['stored'];assert count()==remaining+1
    assert send(1)[0]==409 and send(2,True)[0]==401 and count()==remaining+1
    l.sql('UPDATE device_data_controls SET collection_paused=true WHERE device_id=%s',(did,))
    status,value,_=send(2);assert status==200 and not value['stored'] and count()==remaining+1
    l.sql('UPDATE device_data_controls SET collection_paused=false WHERE device_id=%s',(did,))
    lock=l.connect()
    try:
        with lock.cursor() as q:q.execute('SELECT pg_advisory_lock(%s)',(did,))
        with ThreadPoolExecutor(max_workers=1) as executor:
            future=executor.submit(send,3)
            for _ in range(100):
                if l.sql("SELECT count(*) FROM pg_stat_activity WHERE usename='gps_runtime' AND wait_event='advisory'")[0][0]:break
                time.sleep(.01)
            else:raise AssertionError('ingest did not reach held device lock')
            time.sleep(.3)
            assert l.Client().get('/gps-tracker/health')[0]==200
            with lock.cursor() as q:q.execute('SELECT pg_advisory_unlock(%s)',(did,))
            assert future.result()[0]==200
    finally:lock.close()
    paths=[]
    if variant=='candidate':
        # Exercise every single-point caller and the unchanged batched path.
        for counter,source,payload,added in (
            (4,'lte',dict(lte=dict(fix=True,lat=37.346,lng=127.457)),1),
            (6,'no-fix',dict(l80=dict(fix=False)),1),
            (7,'batch',dict(fixes=[dict(lat=37.348,lng=127.459,up_ms=7000,age_ms=100),dict(lat=37.349,lng=127.460,up_ms=7100,age_ms=0)]),1),
        ):
            before=count();status,value,_=send(counter,fixes=payload)
            assert status==200 and value['stored'] and count()==before+added,(source,status,value,count()-before)
            if source=='batch':assert l.sql('SELECT jsonb_array_length(fixes_jsonb) FROM gps_read_location_records WHERE device_id=%s AND device_uptime_s=7',(did,))==[(2,)]
            paths.append(dict(source=source,status=status,added_rows=added,signed_response_verified=True))
        # Hardware credentials must not impersonate the separate phone path.
        assert send(8,fixes=dict(phone=dict(fix=True,lat=37.347,lng=127.458)))[0]==403
        phone_uid='runtime130-phone-'+uuid.uuid4().hex
        phone_id=l.sql("INSERT INTO devices(owner_id,device_uid,api_key_hash,device_kind) VALUES(%s,%s,'','phone') RETURNING id",(owner,phone_uid))[0][0]
        body=json.dumps(dict(device_uid=phone_uid,ts=1,phone=dict(fix=True,lat=37.347,lng=127.458))).encode()
        status,data,_,_=l.Client().get('/gps-tracker/ingest',body=body,headers={'Content-Type':'application/json','Authorization':'Bearer '+l.b.token(owner)})
        assert status==200 and json.loads(data)['stored']
        assert l.sql('SELECT count(*) FROM location_records WHERE device_id=%s AND source=\'phone\' AND raw IS NULL',(phone_id,))==[(1,)]
        paths.append(dict(source='phone',status=status,added_rows=1,owner_token_verified=True,hardware_phone_rejected=403))
        assert l.sql('SELECT count(*) FROM location_records WHERE device_id=%s AND raw IS NOT NULL',(did,))==[(0,)]
    from profile_ingest130 import capture
    capture('guards-'+variant)
    profile=json.loads((l.ROOT/'out'/('ingest-profile130-guards-'+variant+'.json')).read_text())
    assert profile['unfinished']>=3 and any(x['device_lock_ms']>=250 for x in profile['rows'])
    l.save('guards130-'+variant,dict(variant=variant,injected_stats_failure_status=500,
        remaining_location_rows_after_failure=remaining,latest_after_failure=latest,
        auth_counter_rolled_back=True,retry_accepted=True,replay_status=409,bad_signature_status=401,
        paused_stored_false=True,health_during_lock=200,device_lock_phase_observed=True,
        additional_source_paths=paths,
        no_unacknowledged_location_partial_commit=remaining==0,production_modified=False))
    print('PASS130 fault/replay/pause/signature/lock instrumentation',variant,'partial_rows',remaining,flush=True)


if __name__=='__main__':run(sys.argv[1])
