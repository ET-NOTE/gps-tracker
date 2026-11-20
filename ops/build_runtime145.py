"""Canonical round145 API build; protected prior candidates are read-only inputs."""
import hashlib
import fcntl
from pathlib import Path
import subprocess
import re
import shutil
import os

JOB=Path('/home/etcom-hub/build/gps-runtime145-20261118')
CACHE=Path('/home/etcom-hub/build/gps-tracker/cache')

def main():
    assert subprocess.check_output(['hostname'],text=True).strip()=='etcom-hub'
    assert Path.cwd()==JOB
    (JOB/'out').mkdir(exist_ok=True)
    assert __import__('shutil').disk_usage(JOB).free>2*1024**3, 'Build host needs2GiB free'
    for p in (JOB/'src/gps-tracker-api/migrations').glob('*.sql'):
        assert p.read_bytes()==(JOB/'canonical/gps-tracker-api/migrations'/p.name).read_bytes()
    assert len(list((JOB/'src/gps-tracker-api/migrations').glob('*.sql')))==115
    # Tar sources can retain epoch timestamps. A shared Cargo target cache must
    # not treat different bytes as older than its successful previous build.
    for path in (JOB/'src/gps-tracker-api').rglob('*'):
        if path.is_file():os.utime(path,None)
    commands='cargo fmt && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked && cargo build --locked --release && cp /cache/target/release/gps-tracker-api /out/gps-tracker-api145.building && mv -f /out/gps-tracker-api145.building /out/gps-tracker-api145'
    args=['docker','run','--rm','--name','gps145-build-api','--label','gps.runtime145=synthetic',
        '--user','1000:1000','-v',str(JOB/'src')+':/src','-v',str(JOB/'out')+':/out',
        '-v',str(CACHE)+':/cache','-w','/src/gps-tracker-api','-e','CARGO_HOME=/cache/cargo',
        '-e','CARGO_TARGET_DIR=/cache/target','-e','CARGO_BUILD_JOBS=4','-e','CARGO_PROFILE_DEV_DEBUG=0','-e','CARGO_INCREMENTAL=0','-e','GPS_RELEASE=runtime145-20261118-r1',
        'gps-build:rust1.88-node22.22.2','bash','-c',commands]
    with (CACHE/'build.lock').open('a') as lock,(JOB/'out/build-api.log').open('w') as log:
        fcntl.flock(lock,fcntl.LOCK_EX)
        result=subprocess.run(args,stdout=log,stderr=subprocess.STDOUT)
    assert result.returncode==0,'See out/build-api.log'
    baseline=JOB/'source145-baseline.json'
    if baseline.exists():
        import json
        old=json.loads(baseline.read_text())
        changed=any(hashlib.sha256((JOB/'src'/name).read_bytes()).hexdigest()!=digest for name,digest in old.items())
        if changed:
            assert (JOB/'out/gps-tracker-api145').read_bytes()!=(JOB/'gps-tracker-api145-baseline').read_bytes(), 'Changed candidate reused baseline binary'
    tests=re.findall(r'Running unittests src/main.rs \((/cache/target/debug/deps/gps_tracker_api-[0-9a-f]+)\)', (JOB/'out/build-api.log').read_text())
    assert len(tests)==1, 'Expected one API unit-test executable'
    test_binary=CACHE/Path(tests[0]).relative_to('/cache')
    assert test_binary.is_file() and test_binary.resolve().is_relative_to(CACHE.resolve())
    shutil.copy2(test_binary, JOB/'out/gps-read145-tests')
    print('PASS API fmt/clippy/tests/release',hashlib.sha256((JOB/'out/gps-tracker-api145').read_bytes()).hexdigest())

if __name__=='__main__':main()
