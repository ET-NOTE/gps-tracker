"""Hold the table lock across a real concurrent insert and verify one snapshot."""
import concurrent.futures
import datetime as dt
import time

from benchmark_location111 import connect, save
from test_location111 import selector


def main():
    lo = dt.datetime(2026, 10, 1, tzinfo=dt.timezone.utc)
    hi = lo + dt.timedelta(days=31)
    label = 'snapshot111-' + str(time.time_ns())
    with connect() as setup:
        uid = setup.execute("INSERT INTO users(phone,email,password_hash) VALUES(%s,%s,'') RETURNING id",(label,label+'@example.invalid')).fetchone()[0]
        did = setup.execute("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,%s,'') RETURNING id", (uid,label)).fetchone()[0]
        setup.execute("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng) SELECT %s,%s,%s::timestamptz+i*interval '1 day','l80',true,35,127 FROM generate_series(0,29) i", (did,uid,lo))
    args = (did,uid,lo,hi,None,None,None,None,5001)
    with connect() as query, connect() as writer, connect() as observer:
        before = selector(query,args)
        pid = query.execute('SELECT pg_backend_pid()').fetchone()[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            with writer.transaction():
                writer.execute('LOCK TABLE location_records IN ACCESS EXCLUSIVE MODE')
                future = executor.submit(selector,query,args)
                for _ in range(100):
                    waiting = observer.execute("SELECT wait_event_type='Lock' FROM pg_stat_activity WHERE pid=%s", (pid,)).fetchone()
                    if waiting == (True,):
                        break
                    time.sleep(.05)
                else:
                    raise AssertionError('query did not wait at the controlled snapshot boundary')
                writer.execute("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng) VALUES(%s,%s,%s,'l80',true,36,128)", (did,uid,lo+dt.timedelta(hours=12)))
            during = future.result(timeout=30)
        after = selector(query,args)
        assert during == before and len(after) == len(before)+1
    save('page-snapshot111.json', {'passed':True,'rows_before':len(before),'rows_during':len(during),
        'rows_after':len(after),'verified_statement_snapshot':True,'concurrent_commit_visible_next_request':True,
        'scope':'single page statement; separate HTTP pages retain existing read-committed semantics'})
    print('SNAPSHOT PASS',len(before),len(during),len(after),flush=True)


if __name__ == '__main__':
    main()
