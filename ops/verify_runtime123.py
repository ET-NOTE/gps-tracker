"""Live synthetic TLS admission/cancellation, result equivalence and consent tests."""
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import zipfile
import psycopg2
import load_runtime122 as l
from load_runtime123 import select

b, sql, save, ROOT = l.b, l.sql, l.save, l.ROOT


def equivalence(previous):
    select(previous)
    tests=[]; client=l.Client(); data=b.fixture()
    for d in data['devices']:
        for name,path in (b.routes(d['device_id'])[:3] if d in data['devices'][:4] else b.routes(d['device_id'])[2:]):
            status,body,_,elapsed=client.get(path,d['user_id'])
            assert status==200,(name,status,body[:80])
            if name=='fleet_xlsx':
                with zipfile.ZipFile(io.BytesIO(body)) as z:
                    # Excel ZIP timestamps and document creation metadata vary;
                    # compare every other member (cells, styles, sheets, links).
                    normalized={n:hashlib.sha256(z.read(n)).hexdigest() for n in sorted(z.namelist()) if n!='docProps/core.xml'}
            elif name=='fleet_csv': normalized=body.decode('utf-8-sig')
            else: normalized=json.loads(body)
            digest=hashlib.sha256(json.dumps(normalized,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            tests.append(dict(device=d['device_id'],route=name,status=status,seconds=elapsed,semantic_sha256=digest))
    label='before' if previous else 'after'
    save('equivalence123-'+label,dict(api_sha256=b.SHA,queries=tests,xlsx_excluded='docProps/core.xml creation metadata only'))
    if not previous:
        before=json.loads((ROOT/'out/equivalence123-before.json').read_text())['queries']
        assert [(x['device'],x['route'],x['semantic_sha256']) for x in tests]==[(x['device'],x['route'],x['semantic_sha256']) for x in before]
    print('PASS28 semantic responses',label,flush=True)


def fairness():
    select(); client=l.Client(); d=b.fixture()['devices'][0]
    def active():return sql("SELECT pid,wait_event_type FROM pg_stat_activity WHERE application_name LIKE 'gps-read-%'")
    def wait(predicate):
        began=time.monotonic()
        while time.monotonic()-began<5:
            if predicate():return time.monotonic()-began
            time.sleep(.02)
        raise AssertionError('query/cancel deadline')
    connections=[]
    def request(path):
        c=http.client.HTTPSConnection('127.0.0.1',8443,context=client.tls,timeout=30)
        c.request('GET',path,headers={'Authorization':'Bearer '+b.token(d['user_id'])});connections.append(c);return c
    def close(c):
        if c.sock: c.sock.shutdown(socket.SHUT_RDWR)
        c.close()
    history=b.routes(d['device_id'])[1][1];page=b.routes(d['device_id'])[2][1]
    lock=psycopg2.connect(l.DSN)
    try:
        with lock.cursor() as q:q.execute("LOCK TABLE location_records IN ACCESS EXCLUSIVE MODE")
        first=request(history);wait(lambda:len(active())==1 and active()[0][1]=='Lock')
        first_pid=active()[0][0]
        waiting=request(history);time.sleep(.02);assert len(active())==1
        interactive=request(page);wait(lambda:len(active())==2 and all(x[1]=='Lock' for x in active()))
        close(waiting);time.sleep(.02);assert len(active())==2
        replacement=request(history);time.sleep(.02);assert len(active())==2
        close(first);elapsed=wait(lambda:len(active())==2 and first_pid not in [x[0] for x in active()])
        close(replacement);close(interactive);wait(lambda:not active())
    finally:
        for c in connections:c.close()
        lock.rollback();lock.close()
    assert client.get(page,d['user_id'])[0]==200
    save('fairness123',dict(history_max_one=True,global_max_two=True,history_waiter_borrows_no_read_connection=True,
        page_progresses_while_history_queued=True,queued_cancel_releases_capacity=True,
        active_cancel_reuses_slot_seconds=elapsed,remaining_queries=len(active())))
    # Preserve the old two-slot cancel regression for regular classes; history
    # has a distinct one-slot regression above, not a weakened old assertion.
    import verify_runtime122 as v
    original=b.routes
    b.routes=lambda did:[x for x in original(did)[:3] if x[0]!='month_history']
    try:v.cancellation()
    finally:b.routes=original
    print('PASS history fairness, queued/active cancellation and regular read429',flush=True)


def rights():
    # Keep the reviewed native121 transport adapter, execute all three subject
    # suites with this binary; the unrelated PDF suite is not claimed again.
    source=(ROOT/'verify_runtime121.py').read_text()
    source=source[:source.index('# Existing seven PDF business groups')]
    path=ROOT/'rights123.py';path.write_text(source)
    p=subprocess.run([sys.executable,str(path)],capture_output=True,text=True)
    (ROOT/'out/rights123.log').write_text(p.stdout+p.stderr)
    assert p.returncode==0,p.stdout[-1000:]+p.stderr[-2000:]
    select()
    # Checkpoint regression deliberately disabled subject policy. Restore only
    # the isolated test policy to continue final mapped-reader verification.
    sql("UPDATE location_subject_policy SET enabled=true,push_enabled=false")
    print('PASS22/22B/22D encrypted consent/pause/withdrawal/correction/checkpoint suites',flush=True)


if __name__=='__main__':
    action=sys.argv[1]
    if action=='before':equivalence(True)
    elif action=='after':equivalence(False)
    elif action=='fairness':fairness()
    elif action=='rights':rights()
    elif action=='final':
        fairness()
        from verify_runtime122 import final
        final()
    else:raise ValueError(action)
