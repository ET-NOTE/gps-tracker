"""Content-limited encryption evidence from the disposable synthetic DB only."""
import datetime, hashlib, json, pathlib, subprocess
from crypto20b_transition import connect, files, MAGIC

job = pathlib.Path(__file__).resolve().parent
assert str(job).startswith('/home/etcom-hub/build/gps-crypto20b-')
network = 'gps-crypto20b-test-20261105'
assert json.loads(subprocess.check_output(['docker', 'network', 'inspect', network]))[0]['Internal']
container = json.loads(subprocess.check_output(['docker', 'inspect', 'gps-crypto20b-db-20261105']))[0]
assert '/var/lib/postgresql/data' in container['HostConfig']['Tmpfs']
dsn = 'postgres://postgres:closure-test-only@' + container['NetworkSettings']['Networks'][network]['IPAddress'] + '/gps_closure_test'
ring = json.loads((job / 'test-keys.json').read_text())
db = connect(dsn, ring)
row = db.execute("""SELECT g.center_lat, g.center_lng, g.center_lat_sealed->>'v',
 g.center_lat_sealed->>'kid',left(g.center_lat_sealed->>'cipher',32),r.center_lat,r.center_lng
 FROM geofences g JOIN gps_read_geofences r USING(id) WHERE g.center_lat_sealed IS NOT NULL ORDER BY g.id LIMIT 1""").fetchone()
assert row and row[0] is None and row[1] is None
inventory = db.execute('SELECT count(*),sum(cardinality(fields)) FROM location_storage_fields').fetchone()
triggers = db.execute("SELECT count(*) FROM pg_trigger WHERE tgrelid IN (SELECT table_name::regclass FROM location_storage_fields) AND tgenabled='D' AND NOT tgisinternal").fetchone()[0]
assert triggers == 0
file_samples = []
for path, ctx in files(str(job / 'test-storage/uploads'), str(job / 'test-storage/private')):
    stored = path.read_bytes()
    assert stored.startswith(MAGIC)
    env = json.loads(stored[len(MAGIC):])
    file_samples.append({'header': 'GPSFILE1', 'key_id': env['kid'], 'stored_bytes': len(stored),
                         'sha256': hashlib.sha256(stored).hexdigest()})
assert file_samples
report = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'synthetic': True,
          'production_modified': False, 'schema': 104, 'registered_tables': inventory[0],
          'registered_fields': inventory[1], 'disabled_business_triggers': triggers,
          'sample': dict(zip(('stored_lat','stored_lng','version','key_id','cipher_prefix','decoded_lat','decoded_lng'), row)),
          'files': file_samples}
(job / 'out/storage-state.json').write_text(json.dumps(report, indent=2, default=str))
db.close()
print('Saved synthetic encryption evidence; no keys or user identities included.')
