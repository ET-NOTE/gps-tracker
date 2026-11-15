"""A full114 restored DB through the actual restricted API, before diagnostics."""
import json
import psycopg
import verify_runtime126 as v


def restored(dsn,runtime,uid,did,ring):
    v.prepare_restore(dsn,runtime,uid,did,ring)
    with psycopg.connect(dsn,autocommit=True) as db:
        assert db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone()==(114,)
        assert db.execute('SELECT maintenance FROM location_storage_policy').fetchone()==(True,)
    proof=v.transition(dsn,ring,str(v.ROOT/'test-storage/uploads'),str(v.ROOT/'test-storage/private'),'resume')
    v.boot_settled(dict(RUNTIME_DSN=runtime,STORAGE='pilot'))
    try:rows=[v.request(uid,did,name) for name in ('month_aggregate','month_history','month_page')]
    finally:v.stop_api()
    assert all(row['status']==200 for row in rows),rows
    expected=dict(month_aggregate='333b3a5cb6df7cbdf74e5dc69f14cbb32e042e4bf7945d74608f25c037bed6da',
        month_history='ea1b29c7edb68c6cc82c0bffaf42a708ce52fb8066eff1e4acb5962d5aad27f9',
        month_page='4f6370ba7e1f42f43030c88aa51c6c5a902a468968fdb934db1aeb164162e262')
    assert all(row['sha256']==expected[row['route']] for row in rows)
    v.load.save('restored128',dict(schema=114,queries=rows,statistics=proof['query_statistics'],
        expected=expected,reference='127 same114 API/fixture; independent fresh99->114 full dump/restore',
        api_sha256=v.load.b.SHA,production_modified=False))
    v.transition(dsn,ring,str(v.ROOT/'test-storage/uploads'),str(v.ROOT/'test-storage/private'),'fence')
    print('PASS128 full114 restore: actual owner-isolated API monthly3 routes and hashes',flush=True)
