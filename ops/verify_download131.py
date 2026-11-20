"""Bounded functional TLS checks for corporate download admission and cancel."""
import http.client
import json
import socket
import time
import psycopg2
import load_runtime131 as l
from run_runtime131 import select, digest


def verify():
    select();client=l.Client();data=l.b.fixture()
    device=data['devices'][4];uid=device['user_id']
    path=dict(l.b.routes(device['device_id']))['fleet_xlsx']
    connections=[]
    def active():
        return l.sql("SELECT pid,wait_event_type FROM pg_stat_activity WHERE application_name LIKE 'gps-read-%'")
    def wait(predicate):
        started=time.monotonic()
        while time.monotonic()-started<5:
            if predicate():return time.monotonic()-started
            time.sleep(.02)
        raise AssertionError('Download cancel/slot deadline')
    def request():
        connection=http.client.HTTPSConnection('127.0.0.1',8443,context=client.tls,timeout=30)
        connection.request('GET',path,headers={'Authorization':'Bearer '+l.b.token(uid)})
        connections.append(connection);return connection
    def close(connection):
        if connection.sock:connection.sock.shutdown(socket.SHUT_RDWR)
        connection.close()
    lock=psycopg2.connect(l.DSN)
    try:
        with lock.cursor() as q:
            q.execute("SET LOCAL lock_timeout='5s'; LOCK TABLE location_records IN ACCESS EXCLUSIVE MODE")
        first,second=request(),request()
        wait(lambda:len(active())==2 and all(row[1]=='Lock' for row in active()))
        status,body,headers,_=client.get(path,uid)
        assert status==429 and json.loads(body)['code']=='location_read_busy'
        assert headers['retry-after']=='2' and not body.startswith(b'PK')
        close(first);elapsed=wait(lambda:len(active())==1)
        replacement=request();wait(lambda:len(active())==2)
        close(second);close(replacement);wait(lambda:not active())
    finally:
        for connection in connections:connection.close()
        lock.rollback();lock.close()
    # Follow the returned delay and retry after capacity is released. The XLSX
    # contents must still match the original baseline, including every ZIP member
    # other than creation metadata. A rejected request is never an empty workbook.
    time.sleep(int(headers['retry-after']))
    success,workbook,_,_=client.get(path,uid)
    assert success==200 and workbook.startswith(b'PK')
    before=json.loads((l.ROOT/'out/equivalence131-before.json').read_text())['queries']
    expected=next(row['semantic_sha256'] for row in before if row['device']==device['device_id'] and row['route']=='fleet_xlsx')
    assert digest('fleet_xlsx',workbook)==expected
    foreign=next(user for user in data['users'] if user!=uid)
    foreign_status,foreign_body,_,_=client.get(path,foreign)
    # The existing export filters by the caller's ownership and returns a blank
    # template when no vehicle matches. Verify every workbook member against an
    # impossible-ID request by that same caller, rather than inventing a403 gate.
    marker='device_ids='+str(device['device_id'])
    assert path.count(marker)==1
    empty_status,empty_body,_,_=client.get(path.replace(marker,'device_ids=-1'),foreign)
    assert foreign_status==empty_status==200
    assert foreign_body.startswith(b'PK') and empty_body.startswith(b'PK')
    assert digest('fleet_xlsx',foreign_body)==digest('fleet_xlsx',empty_body)
    l.save('download131',dict(rejected_status=429,retry_after_seconds=2,rejected_workbook=False,
        cancelled_slot_reused_seconds=elapsed,remaining_queries=len(active()),retry_status=success,
        workbook_matches_baseline=True,foreign_status=foreign_status,foreign_matches_empty_scope=True,
        foreign_workbook_sha256=digest('fleet_xlsx',foreign_body),production_modified=False))
    assert not active()
    print('PASS131 XLSX429 JSON/Retry-After, cancel/reuse, retry equality, foreign data excluded',flush=True)


if __name__=='__main__':verify()
