"""Dev-only alignment to verified production artifacts; production is read-only.

Phases: prepare, validate, deploy. Retains dev identities, data, settings and secrets.
"""
import gzip
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess as sp
import sys
import tarfile
import time
import urllib.parse
import urllib.request

import psycopg2
from psycopg2 import sql as pgsql

os.umask(0o077)
HOME = Path('/home/gps-dev')
BACKUP = HOME / 'backups/prod-align-20261025'
STAGE = Path('/home/mmm/gps-artifacts/dev-align-20261025')
API_STAGE = Path('/home/mmm/gps-artifacts/dev-20261021-190449-d541456')
WEB_STAGE = Path('/home/mmm/gps-artifacts/web-report-design-20261023-2126bd4')
DEST = HOME / 'releases/dev-aligned-20261025-2126bd4'
RUNTIME = HOME / 'projects/gps-tracker-api'
WEB = HOME / 'gps-tracker-web-dev'
WORK = HOME / 'workspace/gps-tracker'
NGINX = Path('/etc/nginx/sites-available/dev-gps.serial.kr.conf')
DROPIN = Path('/etc/systemd/system/gps-tracker-api-dev.service.d/private-uploads.conf')
PRIVATE = HOME / 'gps-private-uploads'
DBNAME = 'gps_tracker_dev_next_20260924'
CLONE = 'gps_tracker_dev_sync_20261025'
ROLE = 'gps_tracker_dev_app'
UNIT = 'gps-dev-alignment-20261025-check'
API_HASH = '35323e272cccc81843fa33442fb27dfa08f0f01b3f5133b15d4f9bbf28abd62b'
API_RELEASE = 'dev-20261021-190449-d541456'
SOURCE = '19736ee'
PREVIOUS_SOURCE = '6bc27c2'


def run(args, **kw):
    return sp.run([str(x) for x in args], check=True, **kw)


def out(args):
    return sp.check_output([str(x) for x in args], text=True).strip()


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(name, value):
    (BACKUP / name).write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def config(path):
    return {k: v.strip().strip('"').strip("'") for k, v in
            (line.split('=', 1) for line in path.read_text().splitlines()
             if '=' in line and not line.startswith('#'))}


def dev_env():
    e = config(RUNTIME / '.env.dev')
    u = urllib.parse.urlsplit(e['DATABASE_URL'])
    assert u.path == '/' + DBNAME and u.username == ROLE and u.hostname in ('localhost', '127.0.0.1')
    assert e['APP_ENV'] == 'development' and e['BIND_ADDR'] == '127.0.0.1:3041'
    assert e['UPLOAD_DIR'] == '/home/gps-dev/uploads' and e['SMS_DEV_MODE'] == '1'
    for k in ('FCM_SERVICE_ACCOUNT_PATH', 'TOSS_SECRET_KEY', 'TOSS_WEBHOOK_SECRET', 'OPENAI_API_KEY', 'ONCE_API_TOKEN', 'ONCE_API_CLIENT_SECRET'):
        assert not e.get(k), k + ' must remain disabled in dev'
    return e


def sql(db, query):
    assert db.startswith('gps_tracker_dev') or db == 'postgres'
    return out(['sudo', '-u', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-d', db, '-c', query])


def production():
    w = Path('/home/mmm/gps-tracker-web/dist-root').resolve()
    return dict(api=sha('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api'),
                env=sha('/home/mmm/projects/gps-tracker-api/.env'), web=str(w),
                index=sha(w/'index.html'), version=sha(w/'version.json'),
                nginx=sha('/etc/nginx/sites-available/gps.serial.kr'),
                service=out(['systemctl', 'show', 'gps-tracker-api', '-p', 'MainPID', '-p', 'ActiveEnterTimestamp']))


def verify_prod():
    assert production() == json.loads((BACKUP/'prod-before.json').read_text()), 'Production changed; review before continuing'


def artifacts():
    a = json.loads((API_STAGE/'manifest.json').read_text())
    w = json.loads((WEB_STAGE/'manifest.json').read_text())
    assert a['api_sha256'] == API_HASH and sha(API_STAGE/'gps-tracker-api-dev') == API_HASH
    assert a['git_commit'] == 'd541456315ab56d0fd5ea1167833d23d3a9955c6'
    assert sha(API_STAGE/'source.tar.gz') == a['source_sha256']
    assert w['git_commit'] == '2126bd46e853a154d4a4dbde5684e23523fe60ca'
    assert sha(WEB_STAGE/'web.tar.gz') == w['archive_sha256']
    return a, w


def fingerprints(cur, columns=None, normalize=False):
    cur.execute("SET TIME ZONE 'UTC'")
    if columns is None:
        cur.execute("SELECT table_name,array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name IN (SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_sqlx_migrations') GROUP BY table_name ORDER BY table_name")
        columns = dict(cur.fetchall())
    result = {}
    for table, names in columns.items():
        fields = [pgsql.SQL('coalesce(car_plate,license_plate)') if normalize and table == 'devices' and name in ('car_plate','license_plate') else pgsql.Identifier(name) for name in names]
        query = pgsql.SQL("SELECT count(*),md5(coalesce(string_agg(h,'' ORDER BY h),'')) FROM (SELECT md5(row({})::text) h FROM public.{}) q").format(pgsql.SQL(',').join(fields), pgsql.Identifier(table))
        cur.execute(query); result[table] = list(cur.fetchone())
    return {'columns': columns, 'rows': result}


def snapshot(label):
    with psycopg2.connect(dev_env()['DATABASE_URL']) as db:
        db.set_session(isolation_level='REPEATABLE READ', readonly=True)
        c = db.cursor(); c.execute('SELECT pg_export_snapshot()'); sid = c.fetchone()[0]
        c.execute("SELECT hypertable_schema,hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_schema='public'")
        assert c.fetchall() == [('public','location_records')]
        raw = fingerprints(c); expected = fingerprints(c, raw['columns'], normalize=True)
        with (BACKUP/(label+'.dump')).open('wb') as f, (BACKUP/(label+'.log')).open('w') as log:
            run(['sudo','-u','postgres','pg_dump','-Fc','--no-owner','--no-acl','--snapshot='+sid,'--exclude-table-data=_timescaledb_internal.compress_*',DBNAME],stdout=f,stderr=log)
        with gzip.open(BACKUP/(label+'-locations.csv.gz'),'wb') as f:
            c.copy_expert('COPY (SELECT * FROM public.location_records) TO STDOUT WITH (FORMAT CSV, HEADER)', f)
        save(label+'-data.json', {'raw':raw, 'expected':expected})
        return expected


def check_migrations(url, expected_max):
    with tarfile.open(API_STAGE/'source.tar.gz') as t:
        wanted = {int(Path(m.name).name.split('_')[0]):hashlib.sha384(t.extractfile(m).read()).hexdigest() for m in t.getmembers() if m.isfile() and m.name.startswith('gps-tracker-api/migrations/') and m.name.endswith('.sql')}
    with psycopg2.connect(url) as db:
        c=db.cursor(); c.execute("SELECT version,encode(checksum,'hex') FROM _sqlx_migrations WHERE success ORDER BY version")
        actual=dict(c.fetchall())
    assert max(actual)==expected_max and all(wanted[k]==v for k,v in actual.items())
    if expected_max==72: assert actual==wanted


def prepare():
    e=dev_env(); artifacts(); assert not DEST.exists() and not (BACKUP/'prepare-ok.json').exists()
    assert not sql('postgres',"SELECT 1 FROM pg_database WHERE datname='"+CLONE+"'")
    assert not out(['ss','-H','-ltn','sport = :3042'])
    check_migrations(e['DATABASE_URL'],68)
    BACKUP.mkdir(mode=0o700,exist_ok=True)
    if (BACKUP/'prod-before.json').exists(): verify_prod()
    save('prod-before.json',production())
    save('dev-before.json',dict(web=str((WEB/'dist').resolve()),api=sha(RUNTIME/'bin/gps-tracker-api-dev'),env=sha(RUNTIME/'.env.dev'),source=out(['sudo','-u','gps-dev','git','-C',WORK,'rev-parse','HEAD'])))
    assert not out(['sudo','-u','gps-dev','git','-C',WORK,'status','--porcelain'])
    shutil.copy2(RUNTIME/'.env.dev',BACKUP/'env.dev'); shutil.copy2(RUNTIME/'bin/gps-tracker-api-dev',BACKUP/'api.previous')
    run(['tar','-czf',BACKUP/'dev-files-before.tar.gz','--exclude=node_modules','--exclude=target','-C',HOME,'workspace/gps-tracker','uploads'])
    run(['tar','-czf',BACKUP/'web.previous.tar.gz','-C',(WEB/'dist').resolve(),'.'])
    expected=snapshot('dev-before')
    DEST.mkdir(mode=0o755); shutil.copy2(API_STAGE/'gps-tracker-api-dev',DEST/'gps-tracker-api-dev')
    (DEST/'gps-tracker-api-dev').chmod(0o755)
    (DEST/'web').mkdir(mode=0o755)
    with tarfile.open(WEB_STAGE/'web.tar.gz') as t:
        for m in t.getmembers():
            assert (DEST/'web'/m.name).resolve().is_relative_to(DEST/'web') and (m.isfile() or m.isdir())
        t.extractall(DEST/'web')
    _,w=artifacts()
    for name,digest in w['web_files'].items(): assert sha(DEST/'web'/name)==digest
    manifest=dict(w,target='dev',release=DEST.name,api_git_commit='d541456315ab56d0fd5ea1167833d23d3a9955c6',api_release=API_RELEASE,api_sha256=API_HASH)
    (DEST/'web/version.json').write_text(json.dumps(manifest,indent=2)+'\n')
    run(['chown','-R','gps-dev:gps-dev',DEST]); run(['chmod','-R','a+rX',DEST])
    run(['sudo','-u','postgres','createdb','-O',ROLE,CLONE])
    sql(CLONE,"CREATE EXTENSION timescaledb VERSION '2.19.3'; SELECT timescaledb_pre_restore();")
    with (BACKUP/'restore.log').open('w') as log, (BACKUP/'dev-before.dump').open('rb') as f:
        run(['sudo','-u','postgres','pg_restore','--no-owner','--no-acl','-d',CLONE],stdin=f,stdout=log,stderr=log)
    sql(CLONE,'SELECT timescaledb_post_restore(); SELECT alter_job(job_id,scheduled=>false) FROM timescaledb_information.jobs;')
    # Only the newly-created clone is cleared before loading the complete decompressed export.
    assert CLONE=='gps_tracker_dev_sync_20261025'
    sql(CLONE,'TRUNCATE public.location_records;')
    with gzip.open(BACKUP/'dev-before-locations.csv.gz','rb') as f, (BACKUP/'restore-location.log').open('w') as log:
        p=sp.Popen(['sudo','-u','postgres','psql','-X','-v','ON_ERROR_STOP=1','-d',CLONE,'-c','COPY public.location_records FROM STDIN WITH (FORMAT CSV, HEADER)'],stdin=sp.PIPE,stdout=log,stderr=log)
        shutil.copyfileobj(f,p.stdin); p.stdin.close(); assert p.wait()==0
    owners=sql(CLONE,"SELECT format('ALTER TABLE %I.%I OWNER TO gps_tracker_dev_app;',n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.objid=c.oid AND d.deptype='e')")
    sql(CLONE,owners)
    sql(CLONE,'GRANT ALL ON ALL TABLES IN SCHEMA public TO gps_tracker_dev_app; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO gps_tracker_dev_app;')
    u=urllib.parse.urlsplit(e['DATABASE_URL'])
    v=dict(DATABASE_URL=urllib.parse.urlunsplit(u._replace(path='/'+CLONE)),JWT_SECRET=secrets.token_hex(48),APP_ENV='test',BIND_ADDR='127.0.0.1:3042',UPLOAD_DIR='/home/gps-dev/align-20261025-uploads',SMS_DEV_MODE='1',CORS_ALLOWED_ORIGINS='http://127.0.0.1',RUST_LOG='warn')
    for k in ('DIAG_DEVICE_ALLOWLIST','DIAG_ALLOW_OWNER_EMAILS'):
        if k in e: v[k]=e[k]
    Path(v['UPLOAD_DIR']).mkdir(); run(['chown','gps-dev:gps-dev',v['UPLOAD_DIR']])
    (BACKUP/'validation.env').write_text('\n'.join(k+'='+val for k,val in v.items())+'\n')
    finish_clone()


def finish_clone():
    v=config(BACKUP/'validation.env')
    expected=json.loads((BACKUP/'dev-before-data.json').read_text())['expected']
    with psycopg2.connect(v['DATABASE_URL']) as db:
        assert fingerprints(db.cursor(),expected['columns'])['rows']==json.loads((BACKUP/'dev-before-data.json').read_text())['raw']['rows']
    with (BACKUP/'clone-migration.log').open('w') as log:
        run(['sudo','-u','gps-dev','--preserve-env','--',DEST/'gps-tracker-api-dev'],env={'PATH':os.environ['PATH'],**v,'GPS_MIGRATE_ONLY':'1'},cwd=DEST,stdout=log,stderr=log)
    check_migrations(v['DATABASE_URL'],72)
    with psycopg2.connect(v['DATABASE_URL']) as db:
        assert fingerprints(db.cursor(),expected['columns'])['rows']==expected['rows'], 'Existing values changed beyond plate normalization'
    verify_prod(); save('prepare-ok.json',{'clone':CLONE,'schema':72,'existing_rows_verified':{k:v[0] for k,v in expected['rows'].items()}})
    print('Dev clone prepared, migrations 68→72 verified, original rows preserved (plate aliases normalized).')


def repair_clone_export():
    # COPY a hypertable by SELECT, so Timescale child chunks are included.
    assert CLONE=='gps_tracker_dev_sync_20261025' and not (BACKUP/'prepare-ok.json').exists()
    verify_prod()
    raw=json.loads((BACKUP/'dev-before-data.json').read_text())['raw']
    with psycopg2.connect(dev_env()['DATABASE_URL']) as db:
        db.set_session(isolation_level='REPEATABLE READ',readonly=True)
        c=db.cursor()
        assert fingerprints(c,raw['columns'])['rows']==raw['rows'], 'Dev changed since snapshot'
        with gzip.open(BACKUP/'dev-before-locations.csv.gz','wb') as f:
            c.copy_expert('COPY (SELECT * FROM public.location_records) TO STDOUT WITH (FORMAT CSV, HEADER)',f)
    sql(CLONE,'TRUNCATE public.location_records;')
    with gzip.open(BACKUP/'dev-before-locations.csv.gz','rb') as f, (BACKUP/'restore-location.log').open('w') as log:
        p=sp.Popen(['sudo','-u','postgres','psql','-X','-v','ON_ERROR_STOP=1','-d',CLONE,'-c','COPY public.location_records FROM STDIN WITH (FORMAT CSV, HEADER)'],stdin=sp.PIPE,stdout=log,stderr=log)
        shutil.copyfileobj(f,p.stdin);p.stdin.close();assert p.wait()==0
    finish_clone()


def health(base):
    for _ in range(25):
        try:
            with urllib.request.urlopen(base+'/health',timeout=3) as r: h=json.load(r)
            if h['ok'] and h['db'] and h['release']==API_RELEASE: return h
        except Exception: pass
        time.sleep(1)
    raise RuntimeError('Health check failed')


def validate():
    assert (BACKUP/'prepare-ok.json').exists(); verify_prod()
    if not (BACKUP/'nginx.previous').exists():
        shutil.copy2(NGINX,BACKUP/'nginx.previous')
        assert not DROPIN.exists()
        save('runtime-before.json',{'nginx':sha(NGINX),'dropin_existed':False})
        run(['tar','-czf',BACKUP/'private-uploads-before.tar.gz','-C',HOME,'gps-private-uploads'])
    v=config(BACKUP/'validation.env')
    v.update(GPS_LEGACY_INGEST_ENABLED='1',GPS_KC_INGEST_ENABLED='0',GPS_KC_PAIRING_ENABLED='0',GPS_STATS_POLL_SECONDS='5',PRIVATE_UPLOAD_DIR=str(HOME/'align-20261025-private-uploads'))
    Path(v['PRIVATE_UPLOAD_DIR']).mkdir(mode=0o700,exist_ok=True)
    run(['chown','gps-dev:gps-dev',v['PRIVATE_UPLOAD_DIR']])
    (BACKUP/'validation.env').write_text('\n'.join(k+'='+val for k,val in v.items())+'\n')
    tests=['test_dev_api.py','test_business_api.py','test_battery_runtime_api.py','test_security_boundaries.py','test_sim_hardware.py','test_sim_first_registration.py','test_daily_heartbeat.py','test_remote_report.py']
    testdir=BACKUP/'tests';testdir.mkdir(exist_ok=True)
    for p in (STAGE/'ops').glob('*.py'):
        (testdir/p.name).write_text(p.read_text().replace('gps_tracker_dev_prodreview_20261020',CLONE))
    try:
        run(['systemd-run','--collect','--unit='+UNIT,'-p','User=gps-dev','-p','Group=gps-dev','-p','EnvironmentFile='+str(BACKUP/'validation.env'),'-p','WorkingDirectory='+str(DEST),'-p','MemoryMax=1G','-p','NoNewPrivileges=true','-p','InaccessiblePaths=/home/mmm /etc/gps-tracker',DEST/'gps-tracker-api-dev'])
        health('http://127.0.0.1:3042')
        for name in tests:
            with (BACKUP/(name+'.log')).open('w') as log:
                run(['python3',testdir/name,BACKUP/'validation.env','http://127.0.0.1:3042'],stdout=log,stderr=log,timeout=180)
            print('PASS '+name,flush=True)
        save('tests-ok.json',{'tests':tests,'api_sha256':API_HASH})
    finally:
        sp.run(['systemctl','stop',UNIT],check=False)
    verify_prod()


def deploy():
    assert (BACKUP/'tests-ok.json').exists() and (BACKUP/'offsite-backup-ok.json').exists()
    dev_env(); artifacts(); verify_prod()
    before=json.loads((BACKUP/'dev-before.json').read_text())
    assert sha(RUNTIME/'bin/gps-tracker-api-dev')==before['api'] and sha(RUNTIME/'.env.dev')==before['env']
    assert str((WEB/'dist').resolve())==before['web']
    assert out(['sudo','-u','gps-dev','git','-C',WORK,'rev-parse','HEAD'])==before['source']
    assert not out(['sudo','-u','gps-dev','git','-C',WORK,'status','--porcelain'])
    runtime=json.loads((BACKUP/'runtime-before.json').read_text())
    assert sha(NGINX)==runtime['nginx'] and not DROPIN.exists()
    check_migrations(dev_env()['DATABASE_URL'],68)
    for p in (WEB/'dist/assets').iterdir():
        if p.is_file() and not (DEST/'web/assets'/p.name).exists(): shutil.copy2(p,DEST/'web/assets'/p.name)
    (DEST/'web/uploads').symlink_to(HOME/'uploads',target_is_directory=True)
    run(['systemctl','stop','gps-tracker-api-dev'])
    try:
        expected=snapshot('dev-cutover')
        PRIVATE.mkdir(mode=0o700,exist_ok=True);PRIVATE.chmod(0o700)
        images=PRIVATE/'car-images';images.mkdir(mode=0o700,exist_ok=True);images.chmod(0o700)
        for p in (HOME/'uploads/car-images').glob('*'):
            assert p.is_file() and not p.is_symlink()
            dest=images/p.name
            if dest.exists(): assert sha(dest)==sha(p)
            else: shutil.copy2(p,dest)
            dest.chmod(0o600)
        run(['chown','-R','gps-dev:gps-dev',PRIVATE])
        updates=dict(GPS_LEGACY_INGEST_ENABLED='1',GPS_KC_INGEST_ENABLED='0',GPS_KC_PAIRING_ENABLED='0',PRIVATE_UPLOAD_DIR=str(PRIVATE))
        lines=[l for l in (RUNTIME/'.env.dev').read_text().splitlines() if l.split('=',1)[0] not in updates]
        (RUNTIME/'.env.dev').write_text('\n'.join(lines+[k+'='+v for k,v in updates.items()])+'\n')
        assert {k:v for k,v in config(RUNTIME/'.env.dev').items() if k not in updates}=={k:v for k,v in config(BACKUP/'env.dev').items() if k not in updates}
        DROPIN.write_text('[Service]\nReadWritePaths='+str(PRIVATE)+'\n')
        DROPIN.chmod(0o644)
        n=NGINX.read_text();needle='    # web SPA'
        assert n.count(needle)==1 and 'location ^~ /uploads/car-images/' not in n
        NGINX.write_text(n.replace(needle,'    # Vehicle photos require the owning account session.\n    location ^~ /uploads/car-images/ { return 404; }\n\n'+needle))
        run(['nginx','-t']);run(['systemctl','reload','nginx']);run(['systemctl','daemon-reload'])
        with (BACKUP/'migration.log').open('w') as log:
            run(['sudo','-u','gps-dev','--preserve-env','--',DEST/'gps-tracker-api-dev'],env={'PATH':os.environ['PATH'],**dev_env(),'GPS_MIGRATE_ONLY':'1'},cwd=DEST,stdout=log,stderr=log,timeout=90)
        check_migrations(dev_env()['DATABASE_URL'],72)
        with psycopg2.connect(dev_env()['DATABASE_URL']) as db:
            assert fingerprints(db.cursor(),expected['columns'])['rows']==expected['rows']
        nextapi=RUNTIME/'bin/gps-tracker-api-dev.next'; shutil.copy2(DEST/'gps-tracker-api-dev',nextapi)
        run(['chown','gps-dev:gps-dev',nextapi]); os.replace(nextapi,RUNTIME/'bin/gps-tracker-api-dev')
        nextweb=WEB/'dist.align-next';nextweb.symlink_to(DEST/'web',target_is_directory=True);os.replace(nextweb,WEB/'dist')
        run(['systemctl','start','gps-tracker-api-dev'])
        assert health('http://127.0.0.1:3041')['environment']=='development'
        assert health('https://dev-gps.serial.kr')['environment']=='development'
        _,manifest=artifacts()
        for name,digest in manifest['web_files'].items():
            with urllib.request.urlopen('https://dev-gps.serial.kr/'+name,timeout=20) as r: assert hashlib.sha256(r.read()).hexdigest()==digest
        run(['sudo','-u','gps-dev','git','-C',WORK,'fetch',str(STAGE/'source.bundle'),'HEAD'])
        run(['sudo','-u','gps-dev','git','-C',WORK,'branch','codex/dev-before-align-20261025',before['source']])
        run(['sudo','-u','gps-dev','git','-C',WORK,'switch','-c','codex/dev-aligned-20261025'])
        run(['sudo','-u','gps-dev','git','-C',WORK,'merge','--ff-only','FETCH_HEAD'],stdout=sp.DEVNULL)
        assert out(['sudo','-u','gps-dev','git','-C',WORK,'rev-parse','--short','HEAD'])==SOURCE
        verify_prod()
        save('deploy-ok.json',{'release':DEST.name,'api_sha256':API_HASH,'schema':72,'dev_data_preserved':True,'source':SOURCE,'production_unchanged':True,'external_services_disabled':True,'runtime_updates':updates,'private_image_files':len(list(images.iterdir()))})
        print(json.dumps(json.loads((BACKUP/'deploy-ok.json').read_text())))
    except Exception:
        # Migrations add tables/columns and normalize a plate alias; old API remains compatible.
        nextapi=RUNTIME/'bin/gps-tracker-api-dev.rollback';shutil.copy2(BACKUP/'api.previous',nextapi);run(['chown','gps-dev:gps-dev',nextapi]);os.replace(nextapi,RUNTIME/'bin/gps-tracker-api-dev')
        nextweb=WEB/'dist.rollback';nextweb.symlink_to(before['web'],target_is_directory=True);os.replace(nextweb,WEB/'dist')
        shutil.copy2(BACKUP/'env.dev',RUNTIME/'.env.dev');shutil.copy2(BACKUP/'nginx.previous',NGINX)
        if DROPIN.exists(): DROPIN.unlink()
        run(['nginx','-t']);run(['systemctl','reload','nginx']);run(['systemctl','daemon-reload'])
        run(['systemctl','restart','gps-tracker-api-dev'])
        raise


assert sys.argv[1] in ('prepare','repair_clone_export','validate','deploy')
globals()[sys.argv[1]]()
