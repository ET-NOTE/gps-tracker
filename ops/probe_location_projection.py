"""Read-only, bounded speed-query experiments; print hashes, never GPS samples."""
import hashlib, json, pathlib, re, statistics, sys, time
import psycopg2

config = {k: v.strip().strip('"').strip("'") for k, v in
          (line.split('=', 1) for line in pathlib.Path(sys.argv[1]).read_text().splitlines()
           if '=' in line and not line.startswith('#'))}
definition = pathlib.Path(sys.argv[2]).read_text()
columns = ','.join(part.strip().split()[0] for part in definition.split('RETURNS TABLE (',1)[1].split(') LANGUAGE',1)[0].split(','))
source = definition.split('AS $$', 1)[1].split('$$;', 1)[0]
with psycopg2.connect(config['DATABASE_URL']) as db:
    db.set_session(readonly=True, autocommit=True)
    q = db.cursor()
    q.execute("SET statement_timeout='20s'; SET jit=off")
    q.execute("SELECT d.id,d.owner_id FROM devices d JOIN users u ON u.id=d.owner_id WHERE u.email='user@user4.com' AND d.display_name LIKE '%520211%' LIMIT 1")
    did, owner = q.fetchone()
    for name, value in {'wanted_device': did, 'wanted_user': owner,
                        'from_time': '2026-10-19T15:00:00Z',
                        'to_time': '2026-10-20T15:00:00Z'}.items():
        literal = q.mogrify('%s', (value,)).decode()
        if name.endswith('_time'): literal += '::timestamptz'
        source = re.sub(r'\b' + name + r'\b', literal, source)
    variants = {'current': source}
    variants['materialized'] = source.replace('), measurement AS (', '), measurement AS MATERIALIZED (').replace('), classified AS (', '), classified AS MATERIALIZED (')
    variants['narrow_materialized'] = variants['materialized'].replace('SELECT r.*,', 'SELECT r.device_id,r.user_id,r.recorded_at,r.source,r.fix,r.lat,r.lng,r.sat,r.ttff_s,r.csq,r.reg,r.vbat_mv,r.device_uptime_s,r.heading,r.speed_kmh,r.fixes_jsonb,')
    result = {}
    for name, query in variants.items():
        seconds=[]
        for _ in range(3):
            started=time.monotonic()
            q.execute('SELECT to_jsonb(p) FROM ('+query+') p('+columns+') ORDER BY recorded_at,source')
            rows=[r[0] for r in q.fetchall()]
            seconds.append(round(time.monotonic()-started, 3))
        raw=json.dumps(rows,sort_keys=True,separators=(',',':')).encode()
        result[name]={'seconds':seconds,'median':statistics.median(seconds),'rows':len(rows),'sha256':hashlib.sha256(raw).hexdigest()}
        print(json.dumps({name:result[name]}),flush=True)
    assert len({r['sha256'] for r in result.values()})==1, 'Projection differs'
