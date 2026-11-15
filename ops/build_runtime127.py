"""Build SQL114 into the API, retaining all earlier immutable candidates."""
import fcntl
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

JOB=Path('/home/etcom-hub/build/gps-runtime127-20261115')
CACHE=JOB.parent/'gps-tracker/cache'


def main():
    assert subprocess.check_output(['hostname'],text=True).strip()=='etcom-hub' and Path.cwd()==JOB
    assert shutil.disk_usage(JOB).free>3*1024**3
    source=JOB/'src/gps-tracker-api/migrations'
    canonical=JOB/'canonical/gps-tracker-api/migrations'
    for old in canonical.glob('*.sql'):
        assert source.joinpath(old.name).read_bytes()==old.read_bytes(),old.name
    assert len(list(source.glob('*.sql')))==114
    args=['docker','run','--rm','--name','gps127-build-api','--label','gps.runtime127=synthetic',
        '--user','1000:1000','-v',str(JOB/'src')+':/src','-v',str(JOB/'out')+':/out',
        '-v',str(CACHE)+':/cache','-w','/src/gps-tracker-api','-e','CARGO_HOME=/cache/cargo',
        '-e','CARGO_TARGET_DIR=/cache/target','-e','CARGO_BUILD_JOBS=4','-e','CARGO_INCREMENTAL=0',
        '-e','GPS_RELEASE=runtime127-20261115-r1','gps-build:rust1.88-node22.22.2','bash','-c',
        'cargo fmt --check && cargo build --locked --release && cp /cache/target/release/gps-tracker-api /out/gps-tracker-api127.building && mv /out/gps-tracker-api127.building /out/gps-tracker-api127']
    with (CACHE/'build.lock').open('a') as lock,(JOB/'out/build-api127.log').open('w') as log:
        fcntl.flock(lock,fcntl.LOCK_EX)
        result=subprocess.run(args,stdout=log,stderr=subprocess.STDOUT)
    assert result.returncode==0,'See build-api127.log'
    digest=hashlib.sha256((JOB/'out/gps-tracker-api127').read_bytes()).hexdigest()
    (JOB/'out/build127.json').write_text(json.dumps(dict(api_sha256=digest,schema=114,
        old_migration_bytes_equal=113,rust_source_changed=False,checks=['cargo fmt --check','cargo build --locked --release']),indent=2))
    print('PASS127 release with114 migrations',digest,flush=True)


if __name__=='__main__':main()
