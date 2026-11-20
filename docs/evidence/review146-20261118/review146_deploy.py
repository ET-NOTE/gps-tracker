"""Pinned145 integration -> team-review production, schema114->115.

Reuse the reviewed137 DB snapshot/backup primitives, not its99->114 deployment.
No activation changes. Credentials and real database copies stay on the VPS.
"""
import hashlib,json,os,pathlib,secrets,shutil,subprocess,sys,tarfile,time
import urllib.request
import psycopg2
import review137_deploy as b

RELEASE='review146-20261118-r1'
STAGE=pathlib.Path('/home/mmm/gps-artifacts')/RELEASE
PAYLOAD=STAGE/'payload'
BACKUP=pathlib.Path('/home/mmm/backups')/RELEASE
WEB=pathlib.Path('/home/mmm/gps-tracker-web/dist-root')
DEST=pathlib.Path('/home/mmm/releases')/RELEASE/'web'
API=pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
OLD_API='62f67f352bcdc677273a88caa7c44b4c409d760c97b9da9128f734da790f648d'
NEW_API='b0765d1d8e0fd44188cb6856468cd15926b75635e4597cafbfc20371816a060d'
OLD_WEB='/home/mmm/releases/android139-web-20261118-r1/web'
ARCHIVE='ee0e3eb34cb29a7d572e44575989037446fe00ecf2a7c859e25637a7b26f4c72'
OLD_ENV='fab21aeaaef7a00f1283530e1136690c28d416d5d4d62b9968d4a6a6cdb3df55'
CLONE='gps_tracker_review146'
RESTORED='gps_tracker_review146_restore'
BACKDB='gps_tracker_review146_backup114'
UNIT='gps-review146'
API_RELEASE='runtime145-20261118-r1'
OLD_RELEASE='review137-20261116-r3'
for key in ('RELEASE','STAGE','PAYLOAD','BACKUP','WEB','DEST','API','CLONE','RESTORED','BACKDB','UNIT'):
    setattr(b,key,globals()[key])
require,sha,run,psql,record=b.require,b.sha,b.run,b.psql,b.record


def digest_rows(dsn,table):
    require(table in ('trip_annotations','subscriptions'),'unreviewed table')
    with psycopg2.connect(dsn) as db:
        db.set_session(readonly=True)
        with db.cursor() as q:
            q.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=%s ORDER BY ordinal_position",(table,))
            columns=','.join('"'+r[0]+'"' for r in q.fetchall() if not r[0].startswith('odometer_'))
            q.execute(f"SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')),count(*) FROM (SELECT {columns} FROM {table}) t")
            return q.fetchone()


def checks(dsn,version):
    with psycopg2.connect(dsn) as db:
        db.set_session(readonly=True)
        with db.cursor() as q:b.checksums(q,version)


def flags():
    env=b.process_env()
    require(all(env.get(k,'off') in ('off','','0','false') for k in b.OFF),'activation flag changed')
    require(env.get('GPS_DATABASE_MODE','')!='runtime','production DB mode changed')
    require(env.get('GPS_PDF_SOCKET')=='/run/gps-pdf-render/render.sock','PDF configuration changed')
    return {k:env.get(k,'<unset/off>') for k in b.OFF}


def guard():
    require(sha(API)==OLD_API and str(WEB.resolve())==OLD_WEB and sha(b.ENV)==OLD_ENV,'baseline drift')
    require(shutil.disk_usage('/').free>2*1024**3,'less than2GiB free')
    require(sha(STAGE/'candidate.tar.gz')==ARCHIVE,'candidate archive drift')
    manifest=json.loads((PAYLOAD/'manifest.json').read_text())
    require(manifest['source_commit']=='f93baa1258ca7880bb44b34adfca56a32a67d127','unexpected source')
    for name,details in manifest['files'].items():require(sha(PAYLOAD/name)==details['sha256'],'payload differs: '+name)
    require(sha(PAYLOAD/'api/gps-tracker-api')==NEW_API,'candidate API differs')
    checks(b.url(),114);flags();b.policies(b.url())
    require(run(['systemctl','is-active',*b.TIMERS]).split()==['active','active'],'timer differs')
    if (STAGE/'staged.json').exists():
        before=json.loads((STAGE/'staged.json').read_text())['baseline']
        require(b.neighbors()==before['neighbors'],'neighbor drift')


def stage():
    require(sha(STAGE/'candidate.tar.gz')==ARCHIVE,'archive mismatch')
    require(not PAYLOAD.exists(),'already staged')
    PAYLOAD.mkdir(mode=0o755)
    with tarfile.open(STAGE/'candidate.tar.gz') as archive:
        for item in archive:
            target=(PAYLOAD/item.name).resolve()
            require(target.is_relative_to(PAYLOAD) and (item.isfile() or item.isdir()),'unsafe archive')
            if item.isdir():target.mkdir(parents=True,exist_ok=True)
            else:
                target.parent.mkdir(parents=True,exist_ok=True)
                with archive.extractfile(item) as source,target.open('wb') as out:shutil.copyfileobj(source,out)
    for path in [PAYLOAD,*PAYLOAD.rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
    (PAYLOAD/'api/gps-tracker-api').chmod(0o755)
    shutil.copy2(API,STAGE/'previous-api');(STAGE/'previous-api').chmod(0o755)
    guard()
    record('staged',dict(baseline=b.state(),api_release=API_RELEASE,source_schema=114,target_schema=115,
        script_sha256=sha(__file__),helper_sha256=sha(b.__file__),candidate_sha256=ARCHIVE))


def stop():
    run(['systemctl','stop',*b.TIMERS])
    for timer in b.TIMERS:
        state=subprocess.run(['systemctl','is-active',timer.replace('.timer','.service')],capture_output=True,text=True).stdout.strip()
        require(state in ('inactive','failed'),'cleanup currently executing')
    run(['systemctl','stop','gps-tracker-api'])


def start_old():
    run(['systemctl','start','gps-tracker-api',*b.TIMERS]);b.health(3040,OLD_RELEASE)


def migrate(dsn):
    started=time.monotonic()
    path=PAYLOAD/'sources/gps-tracker-api/migrations/0115_trip_odometer.sql'
    data=path.read_bytes()
    with psycopg2.connect(dsn) as db:
        with db.cursor() as q:
            q.execute("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'")
            b.checksums(q,114)
            q.execute(data.decode())
            q.execute("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(115,'trip odometer',true,%s,0)",(psycopg2.Binary(hashlib.sha384(data).digest()),))
            b.checksums(q,115)
    return round(time.monotonic()-started,3)


def rollback_empty(dsn):
    # Serving API must be stopped. This preserves all original columns and rows.
    # Never restore an older snapshot over new writes or drop entered readings.
    with psycopg2.connect(dsn) as db:
        with db.cursor() as q:
            q.execute("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'")
            b.checksums(q,115)
            q.execute('LOCK TABLE trip_annotations IN ACCESS EXCLUSIVE MODE')
            q.execute('SELECT count(*) FROM trip_annotations WHERE odometer_before_km IS NOT NULL OR odometer_after_km IS NOT NULL')
            require(q.fetchone()[0]==0,'rollback blocked: entered odometer readings exist; forward repair required')
            q.execute('ALTER TABLE trip_annotations DROP CONSTRAINT trip_annotation_odometer_pair,DROP COLUMN odometer_before_km,DROP COLUMN odometer_after_km')
            q.execute('DELETE FROM _sqlx_migrations WHERE version=115')
            b.checksums(q,114)


def smoke(clone=True,previous=False):
    port=3042 if clone else 3040
    key=secrets.token_hex(32) if clone else b.config()['JWT_SECRET']
    if clone:
        private=STAGE/'private';private.mkdir(mode=0o700,exist_ok=True)
        files=STAGE/'smoke-files';files.mkdir(mode=0o700,exist_ok=True);shutil.chown(files,user='gps-api',group='gps-api')
        env={'PATH':'/usr/bin:/bin','DATABASE_URL':b.url(True),'JWT_SECRET':key,'APP_ENV':'test','BIND_ADDR':'127.0.0.1:3042',
            'SMS_DEV_MODE':'1','UPLOAD_DIR':str(files),'PRIVATE_UPLOAD_DIR':str(files),'RUST_LOG':'warn',**{k:'off' for k in b.OFF}}
        envfile=private/'smoke.env';envfile.write_text('\n'.join(k+'='+v for k,v in env.items())+'\n');envfile.chmod(0o600)
        binary=STAGE/'previous-api' if previous else PAYLOAD/'api/gps-tracker-api'
        run(['systemd-run','--unit='+UNIT,'--collect','-pUser=gps-api','-pGroup=gps-api','-pWorkingDirectory='+str(files),
            '-pEnvironmentFile='+str(envfile),'-pIPAddressDeny=any','-pIPAddressAllow=localhost','-pProtectSystem=strict',
            '-pReadWritePaths='+str(files),'-pNoNewPrivileges=yes','-pPrivateTmp=yes','-pMemoryMax=450M','-pCPUQuota=60%',str(binary)])
    try:
        b.health(port,OLD_RELEASE if previous else API_RELEASE)
        with psycopg2.connect(b.url(clone)) as db:
            with db.cursor() as q:
                q.execute("SELECT id,email FROM users WHERE email IN ('user@user.com','user@user4.com') ORDER BY id")
                users=q.fetchall();require(len(users)==2,'expected test accounts absent')
        result={}
        for uid,email in users:
            token=b.token(uid,key);found={}
            routes=['/auth/me','/auth/me/prefs','/me/account-type','/devices','/corporate/info','/corporate/vehicles',
                '/corporate/staff','/corporate/subscription','/rentcar/subscription','/privacy/requests/page']
            if not previous:routes+=['/privacy/company-tasks']
            for route in routes:
                status,data=b.request('/api/v1'+route,port,token)
                require(status==200,'smoke endpoint failed: '+route+' '+str(status))
                found[route]=status
                if route.endswith('/subscription'):require(data['active'],'report subscription inactive')
            result[email]=found
        status,_=b.request('/api/v1/privacy/requests/page',port)
        require(status==401,'anonymous private endpoint not denied')
        result['anonymous_private_request']=status
        return result
    finally:
        if clone:
            run(['systemctl','stop',UNIT]);envfile.unlink(missing_ok=True)


def rehearse():
    guard();require(not (STAGE/'rehearsal.json').exists(),'already rehearsed')
    private=STAGE/'private';private.mkdir(mode=0o700,exist_ok=True)
    started=time.monotonic()
    try:
        stop();b.copy_database('gps_tracker',CLONE)
    finally:start_old()
    pause=round(time.monotonic()-started,3)
    b.copy_database(CLONE,RESTORED)
    chunks=b.decompress_snapshot(RESTORED)
    snapshot=private/'restorable114.dump'
    backup=b.dump(snapshot,RESTORED)
    fingerprint=b.fingerprint(b.url(RESTORED));annotations=digest_rows(b.url(RESTORED),'trip_annotations')
    b.restore_dump(RESTORED,snapshot)
    require(b.fingerprint(b.url(RESTORED))==fingerprint and digest_rows(b.url(RESTORED),'trip_annotations')==annotations,'restore differs')
    before=digest_rows(b.url(True),'trip_annotations');elapsed=migrate(b.url(True))
    require(before==digest_rows(b.url(True),'trip_annotations'),'migration changed old columns')
    candidate=smoke()
    with psycopg2.connect(b.url(True)) as db:
        with db.cursor() as q:q.execute('UPDATE trip_annotations SET odometer_before_km=1000.25,odometer_after_km=1012.75')
    refused=False
    try:rollback_empty(b.url(True))
    except RuntimeError as error:
        require('entered odometer readings' in str(error),'unexpected rollback error');refused=True
    require(refused,'rollback did not protect readings');checks(b.url(True),115)
    with psycopg2.connect(b.url(True)) as db:
        with db.cursor() as q:q.execute('UPDATE trip_annotations SET odometer_before_km=NULL,odometer_after_km=NULL')
    rollback_empty(b.url(True));require(before==digest_rows(b.url(True),'trip_annotations'),'rollback changed old columns')
    old=smoke(previous=True)
    migrate(b.url(True));again=smoke()
    guard()
    record('rehearsal',dict(passed=True,script_sha256=sha(__file__),helper_sha256=sha(b.__file__),source_schema=114,target_schema=115,
        source_copy_pause_seconds=pause,migration_seconds=elapsed,backup_restore_verified=backup,decompressed_copy_chunks=chunks,
        original_annotations_preserved=True,rollback_blocked_with_entered_values=True,rollback_empty_columns_114_smoke=old,
        candidate_smoke=candidate,reupgrade_smoke=again,production_schema_unchanged=True,external_credentials='absent; localhost-only transient unit'))


def web_switch(target):
    link=WEB.with_name(WEB.name+'.review146');require(not link.exists() and not link.is_symlink(),'pending web link exists')
    link.symlink_to(target,target_is_directory=True);os.replace(link,WEB)


def apply():
    guard()
    verified=json.loads((STAGE/'rehearsal.json').read_text())
    require(verified['passed'] and verified['script_sha256']==sha(__file__) and verified['helper_sha256']==sha(b.__file__),'exact script not rehearsed')
    require(not BACKUP.exists() and not DEST.parent.exists(),'release or backup exists')
    BACKUP.mkdir(mode=0o700)
    (BACKUP/'baseline.json').write_text(json.dumps(b.state(),indent=2))
    shutil.copy2(API,BACKUP/'api.previous');shutil.copy2(b.ENV,BACKUP/'environment.previous')
    shutil.copytree(PAYLOAD/'web',DEST)
    for old in (WEB/'assets').iterdir():
        if old.is_file() and not (DEST/'assets'/old.name).exists():shutil.copy2(old,DEST/'assets'/old.name)
    if (WEB/'uploads').is_symlink():(DEST/'uploads').symlink_to((WEB/'uploads').resolve(),target_is_directory=True)
    (DEST/'version.json').write_text(json.dumps(dict(release=RELEASE,api_release=API_RELEASE,schema=115,purpose='team review',
        source_commit='f93baa1258ca7880bb44b34adfca56a32a67d127',feature_activation=False)))
    for path in [DEST.parent,DEST,*DEST.rglob('*')]:
        if not path.is_symlink():path.chmod(0o755 if path.is_dir() else 0o644)
    pending=API.with_name(API.name+'.review146');require(not pending.exists(),'pending API exists')
    shutil.copy2(PAYLOAD/'api/gps-tracker-api',pending);pending.chmod(0o755);shutil.chown(pending,user=API.stat().st_uid,group=API.stat().st_gid)
    require(sha(pending)==NEW_API,'staged binary mismatch')
    committed=False;exposed=False;started=time.time()
    try:
        stop()
        b.copy_database('gps_tracker',BACKDB)
        before=digest_rows(b.url(),'trip_annotations');subscriptions=digest_rows(b.url(),'subscriptions')
        elapsed=migrate(b.url());committed=True
        require(before==digest_rows(b.url(),'trip_annotations'),'old annotation columns changed')
        require(subscriptions==digest_rows(b.url(),'subscriptions'),'subscription changed')
        os.replace(pending,API);run(['systemctl','start','gps-tracker-api'])
        healthy=b.health(3040,API_RELEASE)
        web_switch(DEST);exposed=True
        require(b.neighbors()==json.loads((STAGE/'staged.json').read_text())['baseline']['neighbors'],'neighbor changed')
        record('deployment',dict(passed=True,started_epoch=started,ended_epoch=time.time(),elapsed_seconds=round(time.time()-started,3),
            migration_seconds=elapsed,schema=115,health=healthy,api_sha256=sha(API),web=str(WEB.resolve()),
            original_annotations_unchanged=True,subscriptions_unchanged=True,backup_directory=str(BACKUP),physical_backup=BACKDB,
            configuration_unchanged=sha(b.ENV)==OLD_ENV,neighbors_unchanged=True,rollback='after new fields are used: forward repair; never overwrite live writes'))
    except Exception:
        if not exposed:
            run(['systemctl','stop','gps-tracker-api'])
            try:
                if committed:rollback_empty(b.url())
                shutil.copy2(BACKUP/'api.previous',API);start_old()
                record('recovered',dict(schema=114,api_sha256=sha(API),new_values_discarded=False))
            except Exception:
                run(['systemctl','start','gps-tracker-api'])
                record('needs-repair',dict(committed=committed,new_values_discarded=False))
        raise
    finally:run(['systemctl','start',*b.TIMERS])


def verify():
    require(sha(API)==NEW_API and sha(b.ENV)==OLD_ENV and WEB.resolve()==DEST,'deployed files differ')
    checks(b.url(),115);policy=b.policies(b.url());current_flags=flags()
    healthy=b.health(3040,API_RELEASE)
    with urllib.request.urlopen('https://gps.serial.kr/health',timeout=20) as response:require(json.load(response)==healthy,'public API differs')
    manifest=json.loads((PAYLOAD/'manifest.json').read_text())
    public=['web/index.html']+[name for name in manifest['files'] if name.startswith('web/assets/')]
    for name in public:
        route='/corporate' if name=='web/index.html' else '/'+name.removeprefix('web/')
        with urllib.request.urlopen('https://gps.serial.kr'+route,timeout=20) as response:
            require(hashlib.sha256(response.read()).hexdigest()==manifest['files'][name]['sha256'],'public file differs: '+name)
    require(b.neighbors()==json.loads((STAGE/'staged.json').read_text())['baseline']['neighbors'],'neighbor changed')
    require(run(['systemctl','is-active',*b.TIMERS]).split()==['active','active'],'cleanup timers not active')
    record('verified',dict(passed=True,api_sha256=sha(API),health=healthy,schema=115,public_files_verified=len(public),
        account_smoke=smoke(False),policies=policy,feature_flags=current_flags,environment_unchanged=True,neighbors_unchanged=True,
        timers_active=True,disk_available_bytes=shutil.disk_usage('/').free))


def backup_finish():
    require((STAGE/'verified.json').exists(),'verify deployment first')
    chunks=b.decompress_snapshot(BACKDB)
    dump=b.dump(BACKUP/'database114.dump',BACKDB)
    expected=b.fingerprint(b.url(BACKDB));ann=digest_rows(b.url(BACKDB),'trip_annotations')
    b.restore_dump(RESTORED,BACKUP/'database114.dump')
    require(b.fingerprint(b.url(RESTORED))==expected and digest_rows(b.url(RESTORED),'trip_annotations')==ann,'cutover backup restore differs')
    psql('postgres','ALTER DATABASE '+BACKDB+' ALLOW_CONNECTIONS false')
    record('backup-verified',dict(passed=True,database_dump=dump,directory=str(BACKUP),source_schema=114,
        cutover_snapshot_restored=True,decompressed_copy_chunks=chunks,physical_backup_closed=True,production_decompressed=False))


def cleanup():
    require((STAGE/'backup-verified.json').exists(),'retain failed snapshots')
    for name in (CLONE,RESTORED):
        # Fixed names created by this script; never the production/dev database.
        require(name.startswith('gps_tracker_review146') and name!=BACKDB,'invalid scratch DB')
        psql('postgres','DROP DATABASE '+name+' WITH (FORCE)')
    for name in ('restorable114.dump','smoke.env'):(STAGE/'private'/name).unlink(missing_ok=True)
    record('cleanup',dict(rehearsal_databases_removed=True,production_backup_retained=str(BACKUP),backup_database_retained=BACKDB,
        disk_available_bytes=shutil.disk_usage('/').free))


if __name__=='__main__':
    os.umask(0o077)
    require(os.geteuid()==0 and run(['hostname']).strip()=='seriallog.cafe24.com','pinned production host/root required')
    require(len(sys.argv)==2 and sys.argv[1] in ('stage','rehearse','apply','verify','backup_finish','cleanup'),'unknown action')
    globals()[sys.argv[1]]()
