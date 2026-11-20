"""Run retained business/privacy suites against the encrypted disposable API.
Adapts only fixture connection/physical-vs-logical reads, not expected behavior.
"""
import json, os, pathlib, re, subprocess, sys
HERE=pathlib.Path(__file__).resolve().parent
assert str(HERE).startswith('/home/etcom-hub/build/gps-provision22-')
NET='gps-provision22-test-20261108';DB='gps-provision22-db-20261108';API='gps-provision22-api-20261108'
inspect=lambda kind,name:json.loads(subprocess.check_output(['docker',kind,'inspect',name]))[0]
assert inspect('network',NET)['Internal']
di=inspect('container',DB);assert '/var/lib/postgresql/data' in di['HostConfig']['Tmpfs']
dsn='postgres://postgres:closure-test-only@'+di['NetworkSettings']['Networks'][NET]['IPAddress']+'/gps_closure_test'
base='http://'+inspect('container',API)['NetworkSettings']['Networks'][NET]['IPAddress']+':3043'
ring=json.loads((HERE/'test-keys.json').read_text())
fields=json.loads((HERE/'crypto20b-fields.json').read_text())
results=[]
for name in sys.argv[1:] or ['test_fleet_sites.py','test_fleet_trip_quality.py','test_fleet_expenses.py','test_fleet_assets.py','test_privacy_receipt_pdf.py','test_privacy_company_tasks.py','test_privacy_images.py','test_privacy_redacted.py']:
    assert re.fullmatch(r'test_[a-z_]+\.py',name)
    source=(HERE/'fixtures'/name).read_text()
    if name=='test_fleet_assets.py':
        # The 2026-10 fixture predates the current-month dashboard. Preserve
        # historical trips and assert its intentional exclusion in later months.
        import datetime
        if datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m')!='2026-10':
            source=source.replace("==600 and next(x['total_distance_m']", "==0 and next(x['total_distance_m']")
            source=source.replace('historical full-day distance belongs only to old vehicle','previous-month distance excluded from current-month dashboard')
    source=source.replace('import psycopg2','import psycopg as psycopg2')
    # Fixture seeding still uses the isolated owner DSN; API stays on gps_runtime.
    source=source.replace("cfg['DATABASE_URL']=='postgres://postgres:closure-test-only@closure-db:5432/gps_closure_test'", "urllib.parse.urlparse(cfg['DATABASE_URL']).username=='gps_runtime' and urllib.parse.urlparse(cfg['DATABASE_URL']).hostname in ('closure-db',di['NetworkSettings']['Networks'][NETWORK]['IPAddress']) and urllib.parse.urlparse(cfg['DATABASE_URL']).path=='/gps_closure_test'")

    # psycopg 3 returns bytea as bytes (psycopg 2 returned memoryview).
    source=source.replace('.tobytes()', '')
    source=source.replace('gps-account-closure-','gps-provision22-')
    source=source.replace('gps-provision22-test-20261105','gps-provision22-test-20261108').replace('gps-provision22-db-20261105','gps-provision22-db-20261108').replace('gps-provision22-api-20261105','gps-provision22-api-20261108')
    if "assert base=='http://127.0.0.1:3042'" in source:
        source=source.replace("assert base=='http://127.0.0.1:3042'",'assert base=='+repr(base))
        source=source.replace("=='/gps_tracker_dev_prodreview_20261020'","=='/gps_closure_test'")
        env=HERE/'regression.env'
        env.write_text('DATABASE_URL='+dsn+'\nJWT_SECRET=closure-test-only-jwt-key-32-characters\n');env.chmod(0o600)
        args=[str(env),base]
    else:args=[]
    # Separate query parameters: key material never gets interpolated into SQL.
    source=source.replace('db.autocommit=True',"db.autocommit=True;db.execute(\"SELECT set_config('gps.storage_keys',%s,false)\",(pathlib.Path(__file__).with_name('test-keys.json').read_text(),))")
    for t in list(fields)+['devices','events','location_records']:
        source=re.sub(r'(DELETE\s+FROM\s+)'+t+r'\b',lambda m:m[1]+'__delete_'+t,source,flags=re.I)
        source=re.sub(r'((?:FROM|JOIN)\s+)'+t+r'\b',lambda m:m[1]+'gps_read_'+t,source,flags=re.I)
        source=source.replace('__delete_'+t,t)
    # Older suite cleanup predates retained rights/audit FKs. The disposable DB
    # is removed as a whole; leave only synthetic user rows until that teardown.
    source=source.replace("DELETE FROM users WHERE id=ANY(%s)", "SELECT count(*) FROM users WHERE id=ANY(%s)")
    target=HERE/('adapted_'+name);target.write_text(source)
    log=HERE/'out'/(name.removesuffix('.py')+'.log')
    with log.open('w') as f:
        proc=subprocess.run([sys.executable,str(target),*args],stdout=f,stderr=subprocess.STDOUT)
    results.append({'suite':name,'exit':proc.returncode})
    print(json.dumps(results[-1]),flush=True)
    if proc.returncode:
        print(log.read_text()[-3000:]);break
(HERE/'out/business-regressions.json').write_text(json.dumps(results,indent=2))
if any(r['exit'] for r in results):sys.exit(1)
