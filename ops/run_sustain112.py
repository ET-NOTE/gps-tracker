"""Run the pinned baseline/current API against identical synthetic settings.

Only this fixed isolated DB may switch between schema111/112 definitions.
Original/candidate binaries are kept; no production rollback/deployment logic.
"""
import hashlib
import json
import pathlib
import shutil
import time
from benchmark_location112 import JOB,OUT,DB,NET,connect,info,run,save,BASE_SHA
import load_location112
import sustain_location112


def switch(version):
    assert version in (111,112) and info('network',NET)['Internal']
    names={v['Name'] for v in info('network',NET)['Containers'].values()}
    assert names<={DB,load_location112.API,sustain_location112.PROXY}
    existing=set(__import__('subprocess').check_output(['docker','ps','-a','--format','{{.Names}}']).decode().splitlines())
    for name in (sustain_location112.PROXY,load_location112.API):
        if name in existing:
            container=info('container',name)
            assert NET in container['NetworkSettings']['Networks'] and not container['HostConfig']['PortBindings']
            run('docker','rm','-f',name)
    with connect() as db:
        # Removing the isolated API leaves no legitimate users of its sessions.
        db.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND usename='gps_runtime' AND pid<>pg_backend_pid()")
        current=db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone()[0]
        assert current in (111,112)
        if current!=version:
            with db.transaction():
                if version==111:
                    view=json.loads((OUT/'baseline-view.json').read_text())['definition']
                    db.execute('CREATE OR REPLACE VIEW gps_read_location_records AS '+view)
                    old=json.loads((OUT/'baseline-functions.json').read_text())
                    for definition in old.values():db.execute(definition)
                    db.execute('DELETE FROM _sqlx_migrations WHERE version=112')
                else:
                    migration=JOB/'src/gps-tracker-api/migrations/0112_location_window_pipeline.sql'
                    db.execute(migration.read_text())
                    db.execute("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(112,'location window pipeline',true,%s,0)",(hashlib.sha384(migration.read_bytes()).digest(),))
    binary=OUT/f'gps-tracker-api.baseline{version}' if version==111 else OUT/'gps-tracker-api.final112'
    if version==111:assert hashlib.sha256(binary.read_bytes()).hexdigest()==BASE_SHA
    shutil.copy2(binary,OUT/'gps-tracker-api')
    load_location112.BASE=None
    load_location112.start()
    sustain_location112.tls_setup()


def main(version,seconds,workers,label):
    if not (OUT/'gps-tracker-api.final112').exists():
        assert hashlib.sha256((OUT/'gps-tracker-api').read_bytes()).hexdigest()!=BASE_SHA
        shutil.copy2(OUT/'gps-tracker-api',OUT/'gps-tracker-api.final112')
    fixture=json.loads((OUT/'fixture.json').read_text());fixture['unique_points']=283001
    save('fixture.json',fixture)
    switch(version)
    # Wait for initial legacy catchup, so it cannot skew only one version.
    for i in range(180):
        with connect() as db:
            count=db.execute('SELECT count(*) FROM daily_stats WHERE device_id=%s',(fixture['device_id'],)).fetchone()[0]
        if count>=16:break
        time.sleep(2)
    assert count>=16, ('legacy catchup incomplete',count)
    sustain_location112.load(label,seconds,workers)


if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('version',type=int,choices=[111,112]);p.add_argument('--seconds',type=int,default=900)
    p.add_argument('--workers',type=int,default=8);p.add_argument('--label',default='final112');a=p.parse_args()
    main(a.version,a.seconds,a.workers,a.label)
