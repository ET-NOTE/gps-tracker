"""Hash every projected history row against 109, without saving location values."""
import hashlib
import json
import time

from benchmark_location110 import OUT, connect, save
from load_location110 import request, token


def main():
    fixture = json.loads((OUT / 'fixture.json').read_text())
    args = (fixture['device_id'], fixture['user_id'])
    definitions = json.loads((OUT / 'baseline-functions.json').read_text())
    name = 'location_history_points_between'
    hashes = {}
    with connect() as db, db.transaction(force_rollback=True):
        db.execute(definitions[name].replace('FUNCTION public.' + name, 'FUNCTION pg_temp.before_history'))
        for label, fn in [('schema109', 'pg_temp.before_history'), ('schema110', name)]:
            digest, count = hashlib.sha256(), 0
            began = time.monotonic()
            with db.cursor(name=label) as cursor:
                cursor.itersize = 1000
                cursor.execute("SELECT to_jsonb(p)::text FROM " + fn + "(%s,%s,'2026-10-01','2026-11-01') p ORDER BY recorded_at,source", args)
                for row in cursor:
                    digest.update(row[0].encode() + b'\n')
                    count += 1
            hashes[label] = {'rows': count, 'sha256': digest.hexdigest(), 'elapsed_s': time.monotonic() - began}
        assert hashes['schema109']['rows'] == hashes['schema110']['rows'] == 283001
        assert hashes['schema109']['sha256'] == hashes['schema110']['sha256']
        db.execute('SET LOCAL enable_seqscan=off')
        plan = db.execute("EXPLAIN(FORMAT JSON,ANALYZE,BUFFERS) SELECT device_id,recorded_at,source FROM location_records WHERE device_id=%s AND user_id=%s AND query_bounds_ready AND query_last_at>='2026-10-10 12:00' AND query_first_at<='2026-10-10 12:10'", args).fetchone()[0]
        # Force-off is diagnostic eligibility only, not a production timing claim.
        assert 'location_query_' in json.dumps(plan)
        save('bounds-index-plan.json', {'diagnostic_enable_seqscan_off': True, 'plan': plan})
    auth = token(args[1])
    with connect() as db:
        other = db.execute("INSERT INTO users(phone,email,password_hash) VALUES('load-other','load-other@example.invalid','') RETURNING id").fetchone()[0]
        empty = db.execute("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,'query110-empty','') RETURNING id", (args[1],)).fetchone()[0]
    prefix = '/gps-tracker/api/v1/devices/'
    code, body, seconds = request(prefix + str(empty) + '/locations/latest', auth)
    assert code == 200 and json.loads(body) is None and seconds < 2
    denied = request(prefix + str(args[0]) + '/locations/latest', token(other))[0]
    assert denied == 404
    save('dataset110.json', {'passed': True, 'full_history': hashes, 'empty_latest': {'status': code, 'seconds': seconds},
                            'existing_other_account_status': denied, 'production_modified': False})
    print('FULL DATASET PASS 283001 rows, exact SHA-256 equality; empty/other-account API checks passed', flush=True)


if __name__ == '__main__':
    main()
