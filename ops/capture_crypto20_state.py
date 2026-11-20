"""Read-only, redacted core-field evidence from the isolated round20 fixture."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import psycopg

job = Path(__file__).resolve().parent
assert str(job).startswith('/home/etcom-hub/build/gps-crypto20-')
net='gps-crypto20-test-20261105'
assert json.loads(subprocess.check_output(['docker','network','inspect',net]))[0]['Internal']
state=json.loads(subprocess.check_output(['docker','inspect','gps-crypto20-db-20261105']))[0]
assert '/var/lib/postgresql/data' in state['HostConfig']['Tmpfs']
ip=state['NetworkSettings']['Networks'][net]['IPAddress']
with psycopg.connect(f'postgres://postgres:closure-test-only@{ip}/gps_closure_test') as db:
    with db.cursor() as c:
        c.execute("SET TRANSACTION READ ONLY")
        c.execute("SELECT set_config('gps.storage_keys',%s,false)",((job/'test-keys.json').read_text(),))
        c.execute("""SELECT t.lat,t.lng,t.raw,t.fixes_jsonb,
          t.lat_sealed->>'v',t.lat_sealed->>'kid',left(t.lat_sealed->>'cipher',24),r.lat,r.lng
          FROM location_records t JOIN gps_read_location_records r
          USING(device_id,recorded_at,source) WHERE t.lat_sealed IS NOT NULL LIMIT 1""")
        sample=dict(zip(['stored_lat','stored_lng','stored_raw','stored_fixes','envelope_version',
                         'key_id','ciphertext_prefix','decoded_lat','decoded_lng'],c.fetchone()))
        c.execute("SELECT table_name,fields FROM location_storage_fields ORDER BY table_name")
        fields=dict(c.fetchall())
        c.execute("SELECT current_setting('log_parameter_max_length'),current_setting('log_parameter_max_length_on_error')")
        logging=list(c.fetchone())
result={'environment':'isolated synthetic fixture; NOT production',
        'at':datetime.now(timezone.utc).isoformat(),'schema':103,
        'encrypted_fields':fields,'sample':sample,'db_parameter_logging_limits':logging,
        'api_sha256':hashlib.sha256((job/'out/gps-tracker-api').read_bytes()).hexdigest()}
(job/'out/crypto20-storage-state.json').write_text(json.dumps(result,indent=2)+'\n')
print('Redacted synthetic storage evidence written; no key material included.')
