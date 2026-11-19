from pathlib import Path
import fcntl, os, subprocess, sys

job = Path('/home/etcom-hub/build/gps-review148-20261119')
cache = job.parent / 'gps-tracker/cache'
kind = sys.argv[1]
assert Path.cwd() == job and kind in ('web', 'api')
image = 'gps-build:rust1.88-node22.22.2'
args = ['docker', 'run', '--rm', '--name', 'gps148-build-' + kind, '--user', '1000:1000',
        '-v', f'{job}/src:/src', '-w', '/src/gps-tracker-' + kind]
if kind == 'api':
    lock = (cache/'build.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX)
    args += ['-v', f'{cache}:/cache', '-v', f'{job}/out:/out']
    env = dict(CARGO_HOME='/cache/cargo', CARGO_TARGET_DIR='/cache/target', CARGO_BUILD_JOBS='4',
               CARGO_PROFILE_DEV_DEBUG='0', CARGO_INCREMENTAL='0', GPS_RELEASE='review148-20261119-r1')
    command = 'cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked && cargo build --locked --release && cp /cache/target/release/gps-tracker-api /out/gps-tracker-api'
else:
    env = dict(VITE_BASE='/', VITE_BUILD_LABEL='review148-20261119-r1', npm_config_cache='/tmp/npm-cache')
    command = 'npm ci --no-fund --no-audit && npm test && npm run build'
for key, value in env.items():
    args += ['-e', key + '=' + value]
with (job/'out'/f'{kind}-build.log').open('w') as log:
    subprocess.run(args + [image,'bash','-ec',command], stdout=log, stderr=subprocess.STDOUT, check=True)
