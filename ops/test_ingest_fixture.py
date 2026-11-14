"""Explicit legacy enrollment for disposable tests, never an API security bypass."""
def allow_legacy_fixture(cursor, body, run):
    cursor.execute('SELECT current_database()')
    assert cursor.fetchone()[0].startswith('gps_tracker_dev')
    uid=body.get('device_uid','')
    assert run in uid and len(run)>=24, 'Only this test run can enroll a synthetic device'
    cursor.execute("INSERT INTO devices(device_uid,api_key_hash,ingest_legacy_allowed) VALUES(%s,'',true) ON CONFLICT(device_uid) DO UPDATE SET ingest_legacy_allowed=true",(uid,))
