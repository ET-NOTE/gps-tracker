"""Measured multi-terminal114 workload, exact responses, and rights regressions."""
from collections import Counter
import hashlib
import io
import json
import math
import os
from pathlib import Path
import pwd
import resource
import shutil
import subprocess
import sys
import threading
import time
import zipfile
import load_runtime131 as l

# Reviewed122/124 verification functions run against this current transport and
# fixture. Their archived original files are not edited or used as old results.
sys.modules['load_runtime122']=l


def select():
    active=json.loads((l.ROOT/'active131.json').read_text()) if (l.ROOT/'active131.json').exists() else dict(sha=l.b.SHA,release='runtime130-20261115-r1')
    l.b.SHA=active['sha']
    assert hashlib.sha256((l.ROOT/'out/gps-tracker-api').read_bytes()).hexdigest()==l.b.SHA
    l.start(300)
    status,body,_,_=l.Client().get('/gps-tracker/health')
    assert status==200 and json.loads(body)['release']==active['release']


def digest(name,body):
    if name=='fleet_xlsx':
        with zipfile.ZipFile(io.BytesIO(body)) as z:
            normalized={n:hashlib.sha256(z.read(n)).hexdigest() for n in sorted(z.namelist()) if n!='docProps/core.xml'}
    elif name=='fleet_csv':normalized=body.decode('utf-8-sig')
    else:normalized=json.loads(body)
    return hashlib.sha256(json.dumps(normalized,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def equivalence(label,compare=True):
    rows=[];client=l.Client()
    for i,d in enumerate(l.b.fixture()['devices']):
        for name,path in (l.b.routes(d['device_id'])[:3] if i<4 else l.b.routes(d['device_id'])[2:]):
            status,body,_,seconds=client.get(path,d['user_id'])
            assert status==200,(name,status)
            rows.append(dict(device=d['device_id'],route=name,status=status,seconds=seconds,semantic_sha256=digest(name,body)))
    if compare:
        original=json.loads((l.ROOT/'out/equivalence131-before.json').read_text())['queries']
        assert [(r['device'],r['route'],r['semantic_sha256']) for r in rows]==[(r['device'],r['route'],r['semantic_sha256']) for r in original]
    l.save('equivalence131-'+label,dict(queries=rows,api_sha256=l.b.SHA,xlsx_excluded='docProps/core.xml creation metadata only'))
    print('PASS13128 semantic responses',label,flush=True)


def fingerprint():
    ids=[d['device_id'] for d in l.b.fixture()['devices']]
    return l.sql("SELECT count(*),md5(string_agg(md5(to_jsonb(r)::text),'' ORDER BY device_id,recorded_at,source)) FROM location_records r WHERE device_id=ANY(%s)",(ids,))[0]


def prepare():
    l.seed();l.stop_api()
    for jid, in l.sql("SELECT job_id FROM timescaledb_information.jobs WHERE proc_name='policy_compression'"):
        l.sql('SELECT alter_job(%s,scheduled=>false)',(jid,))
    chunks=l.sql("SELECT format('%I.%I',chunk_schema,chunk_name),is_compressed FROM timescaledb_information.chunks WHERE hypertable_name='location_records'")
    for name,compressed in chunks:
        if compressed:l.sql('SELECT decompress_chunk(%s::regclass)',(name,))
    l.sql('ANALYZE location_records');select();equivalence('before',False);l.stop_api()
    before=fingerprint()
    for name,_ in chunks:l.sql('SELECT compress_chunk(%s::regclass)',(name,))
    assert fingerprint()==before
    from runtime121_control import transition,drain
    drain();ring=json.loads((l.ROOT/'test-keys.json').read_text())
    for mode in ('fence','resume'):
        result=transition(l.DSN,ring,str(l.ROOT/'test-storage/uploads'),str(l.ROOT/'test-storage/private'),mode)
    l.save('fixture131',dict(ciphertext_fingerprint=before,compressed_chunks=len(chunks),
        rows=119040,unique_points=714240,sim_count=8,personal=4,mapped_company=4,schema=114,
        statistics=result['query_statistics'],api_sha256=l.b.SHA,production_modified=False))
    select();equivalence('compressed')
    print('PASS131 seeded114 encrypted8SIM,248 daily rows; compression hash unchanged',flush=True)


def load(label,readers=8):
    select();shared='shared' in label;ended=threading.Event();peaks=[]
    def monitor():
        began=time.monotonic();high=-1
        while not ended.wait(.02):
            used=shutil.disk_usage('/run/gps121/sort').used
            if used>high:high=used;peaks.append(dict(seconds=time.monotonic()-began,bytes=used))
    try:
        if shared:
            l.shared(True)
            import verify_runtime122 as v
            v.limits()
        thread=threading.Thread(target=monitor);thread.start()
        failure=None
        try:l.load(label+'-131',300,readers)
        except AssertionError as error:failure=error
        finally:
            ended.set();thread.join()
            l.save('temp131-'+label,dict(interval_ms=20,cap_bytes=256*1024**2,peaks=peaks,
                peak_bytes=max((p['bytes'] for p in peaks),default=0)))
        import load_runtime124 as timing
        timing.timings(label+'-131')
        from profile_ingest131 import capture
        capture(label)
        result=json.loads((l.ROOT/'out'/('temp131-'+label+'.json')).read_text())
        assert result['peak_bytes']<result['cap_bytes']
        assert tuple(json.loads((l.ROOT/'out/fixture131.json').read_text())['ciphertext_fingerprint'])==fingerprint()
        equivalence(label)
        if failure is not None:raise failure
    finally:
        if shared:l.shared(False)
        l.stop_api()


def finish():
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    binary=l.ROOT/'out/gps-read131-tests';os.chown(binary,0,0);binary.chmod(0o555)
    user=pwd.getpwnam('gps-api')
    def demote():
        os.setgroups([]);os.setgid(user.pw_gid);os.setuid(user.pw_uid)
    env=dict(os.environ,GPS_READ_TEST_DATABASE_URL=l.runtime(),LD_PRELOAD='/usr/local/lib/gps-nodump.so')
    with (l.ROOT/'out/read-settings131.log').open('w') as log:
        checked=subprocess.run([str(binary),'services::location_read_budget::tests::read_settings_are_transaction_local_and_do_not_escape_pool',
            '--exact','--ignored','--nocapture'],env=env,preexec_fn=demote,stdout=log,stderr=subprocess.STDOUT,timeout=60)
    assert checked.returncode==0,'Unprivileged read settings regression'
    import verify_runtime124 as v
    v.select=select
    v.rights();v.fairness()
    from verify_download131 import verify as downloads
    downloads()
    from verify_runtime122 import contention,reference_guard,final
    contention();reference_guard();select();equivalence('final')
    final(expected_schema=114)
    assert tuple(json.loads((l.ROOT/'out/fixture131.json').read_text())['ciphertext_fingerprint'])==fingerprint()
    assert l.sql('SELECT count(*) FROM location_records WHERE raw IS NOT NULL OR NOT query_bounds_ready')==[(0,)]
    l.save('final131',dict(schema=114,api_sha256=l.b.SHA,original_month_ciphertext_unchanged=True,
        read_settings_runtime_role_passed=True,
        plaintext_raw=0,pending_bounds=0,external_messages=0,production_modified=False,activation_ready=False))
    print('PASS131 rights/cleanup/28responses/TLS/cancellation and final state',flush=True)


if __name__=='__main__':
    action=sys.argv[1]
    if action=='seed':prepare()
    elif action.startswith('guards-'):
        from test_ingest131 import run
        run(action.removeprefix('guards-'))
    elif action.startswith(('baseline-','candidate-')):load(action)
    elif action=='final':finish()
    else:raise ValueError(action)
