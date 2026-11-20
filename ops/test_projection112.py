"""Independent old view/context oracle, exact scalars and denied key access."""
import datetime as dt
import json
import psycopg
from psycopg.types.json import Jsonb
from benchmark_location112 import JOB,OUT,connect,save


def main():
    checks=0
    with connect() as db,db.transaction(force_rollback=True):
        original=json.loads((OUT/'baseline-view.json').read_text())['definition']
        db.execute('CREATE TEMP VIEW before_location_records AS '+original)
        uid=db.execute("INSERT INTO users(phone,email,password_hash) VALUES('projection112','projection112@example.invalid','') RETURNING id").fetchone()[0]
        did=db.execute("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,'projection112','') RETURNING id",(uid,)).fetchone()[0]
        at=dt.datetime(2026,10,31,15,0,0,123456,tzinfo=dt.timezone.utc)
        for encrypted in (False,True):
            db.execute('UPDATE location_storage_policy SET enabled=%s',(encrypted,))
            for i,(lat,lng,raw,fixes) in enumerate([
              (37.123456789,127.987654321,{'boot_id':'x','cbc_mv':4100},None),
              (None,None,None,None),(0.0,-0.0,[],[]),(90.,-180.,{},{}),
              (-90.,180.,'text',[{'lat':37,'lng':127,'at_ms':-1000}]),
              (1e-12,-1e-12,Jsonb(None),Jsonb(None))]):
                db.execute('INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,raw,fixes_jsonb) VALUES(%s,%s,%s,%s,false,%s,%s,%s,%s)',
                  (did,uid,at+dt.timedelta(seconds=i),f'mode{encrypted}',lat,lng,
                   raw if raw is None or isinstance(raw,Jsonb) else Jsonb(raw),
                   fixes if fixes is None or isinstance(fixes,Jsonb) else Jsonb(fixes)))
        for zone in ('UTC','Asia/Seoul','America/New_York','Pacific/Kiritimati'):
            db.execute("SELECT set_config('TimeZone',%s,true)",(zone,))
            for style in ('ISO, MDY','SQL, DMY'):
                db.execute("SELECT set_config('DateStyle',%s,true)",(style,))
                for field in ('lat','lng','raw','fixes_jsonb'):
                    # Compare the authenticated identity bytes, not only successful
                    # decryption. UTC and microsecond precision must be identical.
                    n=db.execute("""SELECT count(*) FROM location_records t WHERE device_id=%s AND
                     gps_cell_context('location_records',jsonb_build_object('device_id',t.device_id,'recorded_at',t.recorded_at,'source',t.source),ARRAY['device_id','recorded_at','source'],%s)
                     IS DISTINCT FROM jsonb_build_array('gps-location-v1','location_records',%s::text,jsonb_build_object('device_id',t.device_id,'recorded_at',t.recorded_at AT TIME ZONE 'UTC','source',t.source))::text""",(did,field,field)).fetchone()[0]
                    assert n==0;checks+=1
                query='SELECT to_jsonb(r),float8send(lat),float8send(lng) FROM {} r WHERE device_id=%s ORDER BY recorded_at,source'
                assert db.execute(query.format('before_location_records'),(did,)).fetchall()==db.execute(query.format('gps_read_location_records'),(did,)).fetchall();checks+=1
        db.execute("SET LOCAL DateStyle='ISO, MDY'")
        ring=(JOB/'test-keys.json').read_text()
        db.execute("SELECT set_config('gps.storage_keys','',false)")
        for view in ('before_location_records','gps_read_location_records'):
            try:
                with db.transaction():
                    db.execute(f"SELECT lat FROM {view} WHERE device_id=%s AND source='modeTrue' ORDER BY recorded_at LIMIT 1",(did,)).fetchall()
                raise AssertionError('missing key accepted')
            except psycopg.Error:checks+=1
        db.execute("SELECT set_config('gps.storage_keys',%s,false)",(ring,))
    save('projection112.json',{'passed':True,'checks':checks,'oracle':'unchanged111 view definition + authenticated context bytes',
      'cases':['mixed plaintext/ciphertext','NULL/JSON null','JSON array/object/scalar','coordinate boundaries and float bits','microseconds','four timezones','two DateStyles','missing key denied'],
      'fixture_rolled_back':True,'production_modified':False})
    print('PROJECTION PASS',checks,flush=True)


if __name__=='__main__':main()
