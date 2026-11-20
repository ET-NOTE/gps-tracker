"""Run existing encrypted boundary/write oracle against pinned113 functions."""
import contextlib
import json
from pathlib import Path
import sys
import types
import psycopg
import verify_runtime126 as v
from runtime121_control import DSN

ctx=json.loads(v.CONTEXT.read_text())
ctx['dsn']=DSN


@contextlib.contextmanager
def connect():
    with psycopg.connect(ctx['dsn'],autocommit=True) as db:
        db.execute("SET statement_timeout='60s'; SET jit=off; SET temp_tablespaces='gps121_sort'")
        db.execute("SELECT set_config('gps.storage_keys',%s,false)",(json.dumps(ctx['ring']),))
        old=json.loads((v.ROOT/'out/oracle113-functions.json').read_text())
        db.execute(old['location_query_records_between'].replace('FUNCTION public.location_query_records_between',
            'FUNCTION pg_temp.before_query_records'))
        try:yield db
        finally:
            # Socket close alone lets the server release session locks
            # asynchronously. The blocker test needs an acknowledged release.
            db.rollback()
            db.execute('SELECT pg_advisory_unlock_all()')


v.stop_api()
v.transition(DSN,ctx['ring'],str(v.ROOT/'test-storage/uploads'),str(v.ROOT/'test-storage/private'),'resume')
oracle=json.loads((v.ROOT/'out/oracle113-functions.json').read_text())
names=['location_points_between','location_speed_points_between','location_speed_metrics_between',
       'location_history_points_between','location_sample_keys_between']
definitions={n:oracle[n].replace('FROM location_query_records_between(', 'FROM pg_temp.before_query_records(') for n in names}
folder=v.ROOT/'oracle128';folder.mkdir(exist_ok=True)
(folder/'baseline-functions.json').write_text(json.dumps(definitions))
mock=types.ModuleType('benchmark_location112')
mock.JOB=v.ROOT;mock.OUT=folder;mock.connect=connect


def save(name,result):
    result['oracle']='pinned schema113 functions, independent113 row-source implementation'
    result['schema']=114
    v.load.save('boundary128',result)


mock.save=save;sys.modules['benchmark_location112']=mock
import test_location112
test_location112.main()
