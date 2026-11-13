"""Fixed build-host-only round120 builder; canonical migrations, no production."""
import hashlib
import fcntl
from pathlib import Path
import subprocess
import sys

JOB=Path('/home/etcom-hub/build/gps-runtime120-20261113')
CACHE=Path('/home/etcom-hub/build/gps-tracker/cache')


def build(kind):
    assert subprocess.check_output(['hostname'],text=True).strip()=='etcom-hub'
    assert kind in ('api','pdf')
    (JOB/'out').mkdir(exist_ok=True)
    crate='gps-tracker-api' if kind=='api' else 'gps-pdf-render'
    for p in (JOB/'src/gps-tracker-api/migrations').glob('*.sql'):
        assert p.read_bytes()==(JOB.parent/'gps-runtime119-20261112/src/gps-tracker-api/migrations'/p.name).read_bytes()
    target=' --target x86_64-unknown-linux-musl' if kind=='pdf' else ''
    targetdir='/cache/target-pdf' if kind=='pdf' else '/cache/target'
    binary=targetdir+('/x86_64-unknown-linux-musl' if kind=='pdf' else '')+'/release/'+crate
    commands='cargo fmt && cargo fmt --check && cargo clippy --locked --all-targets'+target+' -- -D warnings && cargo test --locked'+target+' && cargo build --locked --release'+target+' && cp '+binary+' /out/'+crate
    args=['docker','run','--rm','--name','gps120-build-'+kind,'--label','gps.runtime120=synthetic',
          '--user','1000:1000','-v',str(JOB/'src')+':/src','-v',str(JOB/'out')+':/out',
          '-v',str(CACHE)+':/cache','-w','/src/'+crate,'-e','CARGO_HOME=/cache/cargo','-e','CARGO_TARGET_DIR='+targetdir,
          '-e','CARGO_BUILD_JOBS=4','-e','GPS_RELEASE=runtime120-20261113-r1',
          'gps-pdf-build:rust1.92' if kind=='pdf' else 'gps-build:rust1.88-node22.22.2','bash','-c',commands]
    with (CACHE/'build.lock').open('a') as lock, (JOB/'out'/('build-'+kind+'.log')).open('w') as log:
        fcntl.flock(lock,fcntl.LOCK_EX)
        done=subprocess.run(args,stdout=log,stderr=subprocess.STDOUT)
    if done.returncode: raise SystemExit(done.returncode)
    print(kind,'PASS',hashlib.sha256((JOB/'out'/crate).read_bytes()).hexdigest(),flush=True)


if __name__=='__main__': build(sys.argv[1])
