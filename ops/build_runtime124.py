"""Canonical round124 API build; protected prior candidates are read-only inputs."""
import hashlib
import fcntl
from pathlib import Path
import subprocess

JOB=Path('/home/etcom-hub/build/gps-runtime124-20261114')
CACHE=Path('/home/etcom-hub/build/gps-tracker/cache')

def main():
    assert subprocess.check_output(['hostname'],text=True).strip()=='etcom-hub'
    assert Path.cwd()==JOB
    (JOB/'out').mkdir(exist_ok=True)
    assert __import__('shutil').disk_usage(JOB).free>2*1024**3, 'Build host needs2GiB free'
    for p in (JOB/'src/gps-tracker-api/migrations').glob('*.sql'):
        if p.name.startswith('0113_'): continue
        assert p.read_bytes()==(JOB.parent/'gps-runtime123-20261113/canonical/gps-tracker-api/migrations'/p.name).read_bytes()
    commands='cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked && cargo build --locked --release && cp /cache/target/release/gps-tracker-api /out/gps-tracker-api.building && mv -f /out/gps-tracker-api.building /out/gps-tracker-api'
    args=['docker','run','--rm','--name','gps124-build-api','--label','gps.runtime124=synthetic',
        '--user','1000:1000','-v',str(JOB/'src')+':/src','-v',str(JOB/'out')+':/out',
        '-v',str(CACHE)+':/cache','-w','/src/gps-tracker-api','-e','CARGO_HOME=/cache/cargo',
        '-e','CARGO_TARGET_DIR=/cache/target','-e','CARGO_BUILD_JOBS=4','-e','CARGO_PROFILE_DEV_DEBUG=0','-e','CARGO_INCREMENTAL=0','-e','GPS_RELEASE=runtime124-20261114-r1',
        'gps-build:rust1.88-node22.22.2','bash','-c',commands]
    with (CACHE/'build.lock').open('a') as lock,(JOB/'out/build-api.log').open('w') as log:
        fcntl.flock(lock,fcntl.LOCK_EX)
        result=subprocess.run(args,stdout=log,stderr=subprocess.STDOUT)
    assert result.returncode==0,'See out/build-api.log'
    print('PASS API fmt/clippy/tests/release',hashlib.sha256((JOB/'out/gps-tracker-api').read_bytes()).hexdigest())

if __name__=='__main__':main()
