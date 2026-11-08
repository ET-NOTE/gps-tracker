"""Read-only query experiment on cumulative108 synthetic history, not a migration.

Compare a confirmed-leaf seed with the existing schema108 view. A future change
still needs a NEW migration and the full consent/revocation regression suite.
"""
import hashlib
import json
import pathlib
import subprocess
import time
import psycopg

job = pathlib.Path('/home/etcom-hub/build/gps-provision22-20261108cumulative')
assert pathlib.Path.cwd() == job
net = 'gps-provision22-test-20261108cumulative'
info = json.loads(subprocess.check_output(['docker', 'network', 'inspect', net]))[0]
assert info['Internal']
info = json.loads(subprocess.check_output(['docker', 'inspect', 'gps-provision22-db-20261108cumulative']))[0]
assert '/var/lib/postgresql/data' in info['HostConfig']['Tmpfs']
dsn = 'postgres://postgres:closure-test-only@' + info['NetworkSettings']['Networks'][net]['IPAddress'] + '/gps_closure_test'
source = (job / 'src/gps-tracker-api/migrations/0108_subject_revisions.sql').read_text()
query = source.split('CREATE VIEW location_subject_effective AS\n', 1)[1].split(';', 1)[0]
needle = 'FROM location_subject_mappings WHERE replaces_id IS NOT NULL'
assert query.count(needle) == 1
proposal = query.replace(needle, needle + " AND status='confirmed'")
with psycopg.connect(dsn, autocommit=True) as db:
    db.execute("SET default_transaction_read_only=on; SET statement_timeout='60s'; SET jit=off")
    owner = db.execute('SELECT owner_id FROM location_subject_mappings GROUP BY owner_id HAVING count(*)=32000').fetchone()[0]
    result = {'read_only': True, 'schema_changed': False, 'proposal_implemented': False,
              'scope': 'one synthetic history shape; consent/revocation regression still required'}
    values = []
    for name, q in [('existing', 'SELECT * FROM location_subject_effective'), ('confirmed_seed_proposal', proposal)]:
        started = time.monotonic()
        ids = db.execute('SELECT id FROM (' + q + ') x WHERE owner_id=%s ORDER BY id', (owner,)).fetchall()
        result[name + '_seconds'] = round(time.monotonic() - started, 4)
        values.append(ids)
    assert values[0] == values[1] and len(values[0]) == 1000
    result['same_effective_ids'] = True
    result['count'] = len(values[0])
    result['ids_sha256'] = hashlib.sha256(json.dumps(values[0]).encode()).hexdigest()
    (job / 'out/ancestry-proposal108.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
