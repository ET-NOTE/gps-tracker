"""Paired113/prototype114 on the same restored fixture, no production writes."""
import json
import os
from pathlib import Path
import threading
import time
import psycopg
import verify_runtime126 as v

ctx=json.loads(v.CONTEXT.read_text());dsn=ctx['dsn'];rows=[]
expected={}


def probe(label):
    v.boot_settled(dict(RUNTIME_DSN=ctx['runtime'],STORAGE='pilot'))
    try:
        for name in ('month_aggregate','month_history','month_page'):
            stopped=threading.Event();samples=[]
            def watch():
                while not stopped.wait(.025):
                    s=os.statvfs('/run/gps121/sort');samples.append((s.f_blocks-s.f_bfree)*s.f_frsize)
            thread=threading.Thread(target=watch);thread.start()
            try:row=v.request(ctx['uid'],ctx['did'],name)
            finally:stopped.set();thread.join()
            row.update(phase=label,temp_peak_bytes=max(samples,default=0),temp_cap_bytes=256*1024**2)
            if label=='before-uncompressed':
                assert row['status']==200,row
                expected[name]=row['sha256']
            elif row['status']==200:assert row['sha256']==expected[name],row
            rows.append(row);v.load.save('paired-probe127',dict(queries=rows,expected=expected))
            print(label,row,flush=True)
    finally:v.stop_api()


v.stop_api()
with psycopg.connect(dsn,autocommit=True) as db:
    names=['location_query_records_between','location_points_between','location_speed_points_between',
           'location_speed_metrics_between','location_history_points_between','location_sample_keys_between']
    definitions=dict(db.execute("SELECT proname,pg_get_functiondef(oid) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY(%s)",(names,)).fetchall())
    assert len(definitions)==len(names)
    (v.ROOT/'out/oracle113-functions.json').write_text(json.dumps(definitions,indent=2))
    for (jid,) in db.execute("SELECT job_id FROM timescaledb_information.jobs WHERE proc_name='policy_compression'").fetchall():
        db.execute('SELECT alter_job(%s,scheduled=>false)',(jid,))
    for (chunk,) in db.execute("SELECT format('%I.%I',chunk_schema,chunk_name) FROM timescaledb_information.chunks WHERE hypertable_name='location_records' AND is_compressed").fetchall():
        db.execute('SELECT decompress_chunk(%s::regclass)',(chunk,))
    assert db.execute("SELECT count(*) FROM timescaledb_information.chunks WHERE hypertable_name='location_records' AND is_compressed").fetchone()==(0,)
v.transition(dsn,ctx['ring'],str(v.ROOT/'test-storage/uploads'),str(v.ROOT/'test-storage/private'),'resume')
probe('before-uncompressed')
with psycopg.connect(dsn,autocommit=True) as db:
    for (chunk,) in db.execute("SELECT show_chunks('location_records')::text").fetchall():
        db.execute('SELECT compress_chunk(%s::regclass,if_not_compressed=>true)',(chunk,))
probe('before-compressed')
with psycopg.connect(dsn,autocommit=True) as db:
    with db.transaction():db.execute((v.ROOT/'prototype114.sql').read_text())
probe('prototype-compressed')
v.load.save('prototype127',dict(schema=113,unregistered_function_prototype=True,
    expected=expected,queries=rows,production_modified=False))
print('PROTOTYPE127 finished; actual114 release still required',flush=True)
