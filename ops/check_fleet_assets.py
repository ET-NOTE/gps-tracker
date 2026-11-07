"""Read-only production migration preflight; no account or telemetry changes."""
import json,pathlib,sys,urllib.parse
import psycopg2
p=pathlib.Path(sys.argv[1])
env=dict(line.split('=',1) for line in p.read_text().splitlines() if '=' in line and not line.startswith('#'))
url=env['DATABASE_URL'].strip().strip('"').strip("'")
with psycopg2.connect(url) as db:
 db.set_session(readonly=True,autocommit=True)
 with db.cursor() as c:
  c.execute("SELECT max(version) FROM _sqlx_migrations WHERE success");version=c.fetchone()[0]
  c.execute("SELECT count(*) FROM devices d JOIN users u ON u.id=d.owner_id WHERE d.owner_id IS NOT NULL");count=c.fetchone()[0]
  c.execute("SELECT count(*) FROM (SELECT d.owner_id,replace(COALESCE(NULLIF(d.license_plate,''),d.car_plate),' ','') FROM devices d JOIN users u ON u.id=d.owner_id WHERE d.owner_id IS NOT NULL AND NULLIF(btrim(COALESCE(NULLIF(d.license_plate,''),d.car_plate)),'') IS NOT NULL GROUP BY d.owner_id,replace(COALESCE(NULLIF(d.license_plate,''),d.car_plate),' ','') HAVING count(*)>1) x");duplicates=c.fetchone()[0]
  c.execute("SELECT count(*) FROM vehicle_reservations a JOIN vehicle_reservations b ON a.id<b.id AND a.device_id=b.device_id AND a.user_id=b.user_id AND a.starts_at<b.ends_at AND a.ends_at>b.starts_at JOIN devices d ON d.id=a.device_id AND d.owner_id=a.user_id JOIN users u ON u.id=d.owner_id WHERE a.status IN ('planned','in_progress') AND b.status IN ('planned','in_progress') AND d.owner_id IS NOT NULL");overlaps=c.fetchone()[0]
  c.execute("SELECT count(*) FROM device_documents doc JOIN devices d ON d.id=doc.device_id AND d.owner_id=doc.user_id JOIN users u ON u.id=d.owner_id WHERE d.owner_id IS NOT NULL");docs=c.fetchone()[0]
  print(json.dumps(dict(schema=version,existing_vehicles=count,duplicate_plates=duplicates,overlapping_bookings=overlaps,documents_to_retain=docs)))
  assert not duplicates and not overlaps,'Resolve collisions before migrating'
