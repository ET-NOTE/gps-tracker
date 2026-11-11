"""Exact month result oracle: original SQL in disjoint days vs materialized SQL."""
import ast
import datetime as dt
import hashlib
import json
from pathlib import Path
import time
import benchmark_location115 as b

# Read query constants without executing the separate timeout benchmark.
queries = {}
for node in ast.parse((Path(__file__).parent / 'probe_location115_sql.py').read_text()).body:
    if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and node.targets[0].id in ('OLD', 'NEW'):
        queries[node.targets[0].id] = ast.literal_eval(node.value)
results = []
start = dt.datetime.fromisoformat('2026-10-01T00:00:00+09:00')
for device in b.fixture()['devices']:
    did, uid = device['device_id'], device['user_id']
    began = time.monotonic()
    def args(a, z): return (did, uid, a, z, did, uid, a, z)
    expected = []
    for d in range(31):
        a = start + dt.timedelta(days=d)
        expected.extend(b.sql(queries['OLD'], args(a, a + dt.timedelta(days=1))))
    actual = b.sql(queries['NEW'], args(start, start + dt.timedelta(days=31)))
    assert expected == actual and len(actual) == 89280
    row = {'device': did, 'points': len(actual), 'all_fields_equal': True,
           'sha256': hashlib.sha256(json.dumps(actual, default=str, separators=(',', ':')).encode()).hexdigest(),
           'seconds': time.monotonic() - began}
    results.append(row); b.save('sql-exact-oracle', results); print(row, flush=True)
