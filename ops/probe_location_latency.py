"""Read-only bounded production query plans; never prints credentials or coordinates."""
import json, pathlib, sys, time
import psycopg2

c = {k:v.strip().strip('"').strip("'") for k,v in (s.split('=',1) for s in pathlib.Path(sys.argv[1]).read_text().splitlines() if '=' in s and not s.startswith('#'))}
db = psycopg2.connect(c['DATABASE_URL'])
db.set_session(readonly=True, autocommit=True)
cur = db.cursor()
cur.execute("SET statement_timeout='20s'")
cur.execute("SELECT d.id,d.owner_id FROM devices d JOIN users u ON u.id=d.owner_id WHERE u.email='user@user4.com' AND d.display_name LIKE '%520211%' LIMIT 1")
identity = cur.fetchone()
if not identity:
 cur.execute("SELECT d.id,d.owner_id FROM devices d JOIN users u ON u.id=d.owner_id WHERE u.email='user@user4.com' ORDER BY d.last_seen_at DESC NULLS LAST LIMIT 1")
 identity = cur.fetchone()
assert identity
did, owner = identity
queries = {
 'points': ("SELECT * FROM location_points_between(%s,%s,'2026-10-20T00:00:00+09','2026-10-21T00:00:00+09')", (did,owner)),
 'speed': ("SELECT recorded_at,lat,lng,speed_kmh FROM location_speed_points_between(%s,%s,'2026-10-20T00:00:00+09','2026-10-21T00:00:00+09')", (did,owner)),
 'legacy': ("SELECT DISTINCT lr.device_id FROM location_points lr WHERE NOT EXISTS (SELECT 1 FROM daily_stats ds WHERE ds.device_id=lr.device_id) LIMIT 50", ()),
}
for jit in ('on','off'):
 cur.execute('SET jit='+jit)
 for name,(sql,args) in queries.items():
  cur.execute('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,args)
  p=cur.fetchone()[0][0]
  def nodes(n):
   yield n
   for child in n.get('Plans',[]): yield from nodes(child)
  slow=sorted(nodes(p['Plan']),key=lambda n:n.get('Actual Total Time',0)*n.get('Actual Loops',1),reverse=True)[:6]
  print(json.dumps(dict(query=name,jit=jit,execution_ms=p['Execution Time'],planning_ms=p['Planning Time'],jit_detail=p.get('JIT'),rows=p['Plan']['Actual Rows'],nodes=[{k:n.get(k) for k in ('Node Type','Relation Name','Index Name','Actual Total Time','Actual Rows','Actual Loops','Shared Hit Blocks','Shared Read Blocks')} for n in slow])))
db.close()
