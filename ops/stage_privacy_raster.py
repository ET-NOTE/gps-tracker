"""Build-host staging for release privacy-raster-20261106-r1 (round 15). Never touches production.

    python3 stage_privacy_raster.py <job-dir> <commit> [step ...]

<job-dir>/source.tar.gz must be `git archive <commit>` of gps-tracker-api, gps-tracker-web and ops.
Steps (default: all, in this order; each stops on the first failure):

  build     API (fmt, Clippy, unit tests, release build) and web (tests, build) in the pinned image
  test      throwaway DB on an internal Docker network: scaling suite and the privacy regressions
  package   out/manifest.json, out/validation.json, the ops scripts and a one-time smoke credential
  rehearse  the previous release on a throwaway DB -> check, forced failure with automatic return,
            apply, rollback, apply, suites and smoke on the upgraded schema -> out/rehearsal.json

<job-dir>/out is then the complete directory to place on the production host.
"""
import fcntl
import hashlib
import importlib.util
import json
import os
import pathlib
import secrets
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request

RELEASE = 'privacy-raster-20261106-r1'
SCHEMA = 97
PREVIOUS = {
    'release': 'privacy-receipts-20261106-r1',
    'api_sha256': '65abe14ca7e8acd246a8aa5447f357da3a5956e99f2be202a4b9861841185b04',
}
PREVIOUS_JOB = pathlib.Path('/home/etcom-hub/build/gps-privacy-receipts-20261106')
CACHE = pathlib.Path('/home/etcom-hub/build/gps-tracker')
PYTHON = '/home/etcom-hub/build/gps-location-erasure-20261105/venv/bin/python'
IMAGE = 'gps-build:rust1.88-node22.22.2'
DB_IMAGE = 'timescale/timescaledb:2.19.3-pg14'
# The suites guard these exact names so they cannot run anywhere else.
NETWORK = 'gps-account-closure-test-20261105'
DB = 'gps-account-closure-db-20261105'
API = 'gps-account-closure-api-20261105'
DATABASE_URL = 'postgres://postgres:closure-test-only@closure-db:5432/gps_closure_test'
JWT_SECRET = 'closure-test-only-jwt-key-32-characters'
SUITES = [  # script, validation key, groups
    ('test_privacy_receipt_scaling.py', 'scaling_groups', 9),
    ('test_privacy_receipts.py', 'receipt_groups', 7),
    ('test_privacy_images.py', 'image_groups', 8),
    ('test_privacy_redacted.py', 'redacted_groups', 8),
    ('test_privacy_company_tasks.py', 'company_task_groups', 10),
    ('test_privacy_account_sections.py', 'sections_groups', 5),
    ('test_privacy_packages.py', 'package_groups', 9),
    ('test_privacy_company.py', 'company_groups', 10),
    ('test_privacy_delivery.py', 'delivery_groups', 11),
    ('test_account_closure.py', 'closure_groups', 12),
]
RUST = '58 passed; 0 failed; 2 ignored'
WEB_TESTS = 223
OPS = ['release_privacy_raster.py', 'smoke_privacy_raster.py']


def require(condition, message):
    if not condition:
        sys.exit(f'STOPPED: {message}')


def sha(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for block in iter(lambda: source.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def docker(*args, check=True):
    return subprocess.run(['docker', *args], check=check, capture_output=True, text=True).stdout.strip()


def step(name):
    print(f'== {name}', flush=True)


class Environment:
    """Internal Docker network, throwaway TimescaleDB on tmpfs, one API container (APP_ENV=test)."""

    def __init__(self, job):
        self.storage = job / 'test-storage'

    def up(self):
        self.down()
        docker('network', 'create', '--internal', NETWORK)
        docker('run', '-d', '--name', DB, '--network', NETWORK, '--network-alias', 'closure-db', '--memory=700m',
               '--tmpfs', '/var/lib/postgresql/data:rw,size=400m', '-e', 'POSTGRES_PASSWORD=closure-test-only',
               '-e', 'POSTGRES_DB=gps_closure_test', DB_IMAGE)
        ready = 0
        for _ in range(90):
            # Three consecutive answers: the init-time temporary server has gone.
            ok = subprocess.run(['docker', 'exec', DB, 'psql', '-U', 'postgres', '-d', 'gps_closure_test', '-Atc', 'select 1'], capture_output=True).returncode == 0
            ready = ready + 1 if ok else 0
            if ready >= 3:
                return
            time.sleep(1)
        require(False, 'test database did not become ready')

    def address(self, name):
        return docker('inspect', '-f', '{{(index .NetworkSettings.Networks "%s").IPAddress}}' % NETWORK, name)

    def start_api(self, binary, database_url=DATABASE_URL):
        self.stop_api()
        for name in ('uploads', 'private'):
            (self.storage / name).mkdir(parents=True, exist_ok=True)
        docker('run', '-d', '--name', API, '--network', NETWORK, '--memory=550m', '--user', f'{os.getuid()}:{os.getgid()}',
               '--cap-drop=ALL', '--security-opt=no-new-privileges', '-e', 'APP_ENV=test', '-e', 'BIND_ADDR=0.0.0.0:3043',
               '-e', f'DATABASE_URL={database_url}', '-e', f'JWT_SECRET={JWT_SECRET}', '-e', 'SMS_DEV_MODE=1',
               '-e', f'UPLOAD_DIR={self.storage}/uploads', '-e', f'PRIVATE_UPLOAD_DIR={self.storage}/private',
               '-v', f'{self.storage}:{self.storage}', '-v', f'{binary}:/api:ro', IMAGE, '/api')

    def stop_api(self):
        docker('rm', '-f', API, check=False)

    def base(self):
        return f'http://{self.address(API)}:3043/gps-tracker'

    def health(self):
        with urllib.request.urlopen(self.base() + '/health', timeout=3) as response:
            return json.load(response)

    def wait(self, release, seconds=90):
        last = None
        for _ in range(seconds):
            try:
                last = self.health()
                if last.get('db') and last.get('release') == release:
                    return last
            except Exception as error:
                last = repr(error)
            time.sleep(1)
        require(False, f'test API did not become healthy on {release}: {last}')

    def down(self):
        docker('rm', '-f', API, DB, check=False)
        docker('network', 'rm', NETWORK, check=False)
        shutil.rmtree(self.storage, ignore_errors=True)


def builder(job, name, workdir, script, log, environment):
    args = ['docker', 'run', '--rm', '--name', name, '--cpus=8', '--memory=6g', '--pids-limit=512', '--cap-drop=ALL',
            '--security-opt=no-new-privileges', '--user', f'{os.getuid()}:{os.getgid()}']
    for key, value in environment.items():
        args += ['-e', f'{key}={value}']
    args += ['-v', f'{CACHE}/cache:/cache', '-v', f'{job}/src:/work', '-v', f'{job}/out:/out', '-w', workdir, IMAGE, 'bash', '-euc', script]
    with open(job / log, 'w') as output:
        code = subprocess.run(args, stdout=output, stderr=subprocess.STDOUT).returncode
    require(code == 0, f'{log}: exit {code}\n' + '\n'.join((job / log).read_text().splitlines()[-15:]))
    return (job / log).read_text()


def build(job, commit):
    step('build')
    source = job / 'source.tar.gz'
    with tarfile.open(source) as archive:
        require(archive.pax_headers.get('comment') == commit, f'source.tar.gz is not git archive of {commit}')
        shutil.rmtree(job / 'src', ignore_errors=True)
        (job / 'src').mkdir()
        archive.extractall(job / 'src', filter='data')
    shutil.rmtree(job / 'out', ignore_errors=True)
    (job / 'out').mkdir()
    with open(CACHE / 'build.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        api = builder(job, 'gps-privacy-raster-api', '/work/gps-tracker-api',
                      'cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked '
                      '&& cargo build --locked --release && cp /cache/target/release/gps-tracker-api /out/gps-tracker-api.next '
                      '&& mv /out/gps-tracker-api.next /out/gps-tracker-api',
                      'build-api.log', {'CARGO_HOME': '/cache/cargo', 'CARGO_TARGET_DIR': '/cache/target', 'CARGO_BUILD_JOBS': '8', 'GPS_RELEASE': RELEASE})
        web = builder(job, 'gps-privacy-raster-web', '/work/gps-tracker-web',
                      'npm ci --ignore-scripts && npm test && npm run build && tar -czf /out/web.tar.gz -C dist .',
                      'build-web.log', {'VITE_BASE': '/', 'npm_config_cache': '/cache/npm'})
    require(RUST in api, f'unit tests are not "{RUST}"')
    require(f'# pass {WEB_TESTS}' in web and '# fail 0' in web, f'web tests are not {WEB_TESTS} passed, 0 failed')
    print(json.dumps({'api_sha256': sha(job / 'out/gps-tracker-api'), 'web_sha256': sha(job / 'out/web.tar.gz')}), flush=True)


def scripts(job):
    # The suites look for out/ and their helper modules next to themselves.
    for script in (job / 'src/ops').glob('*.py'):
        shutil.copy2(script, job / script.name)


def suite(job, script, cwd=None, label=''):
    log = job / (label + pathlib.Path(script).name.removesuffix('.py') + '.log')
    with open(log, 'w') as output:
        code = subprocess.run([PYTHON, str(script)], stdout=output, stderr=subprocess.STDOUT, cwd=cwd or job).returncode
    groups = sum(line.startswith('PASS ') for line in log.read_text().splitlines())
    print(f"{'ok  ' if code == 0 else 'FAIL'} {pathlib.Path(script).name} groups={groups}", flush=True)
    require(code == 0, f'{script} failed\n' + '\n'.join(log.read_text().splitlines()[-12:]))
    return groups


def test(job, commit):
    step('test')
    scripts(job)
    binary = job / 'out/gps-tracker-api'
    environment = Environment(job)
    environment.up()
    try:
        environment.start_api(binary)
        environment.wait(RELEASE)
        results = {}
        for script, key, expected in SUITES:
            results[key] = suite(job, job / script)
            require(results[key] == expected, f'{script}: {results[key]} groups, expected {expected}')
        # One-time credential for the production smoke: hashed by this API, never printed.
        password = secrets.token_urlsafe(24)
        phone = '010' + ''.join(secrets.choice('0123456789') for _ in range(8))

        def post(path, body):
            request = urllib.request.Request(environment.base() + '/api/v1' + path, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.load(response)

        code = post('/auth/send-otp', {'phone': phone})['dev_code']
        user = post('/auth/register', {'email': f'hash-only-{secrets.token_hex(6)}@example.invalid', 'phone': phone, 'otp_code': code, 'password': password, 'display_name': 'hash only'})
        hashed = docker('exec', DB, 'psql', '-U', 'postgres', '-d', 'gps_closure_test', '-Atc', f"SELECT password_hash FROM users WHERE id={int(user['user_id'])}")
        require(hashed.startswith('$argon2'), 'could not obtain a password hash')
        private = job / 'smoke-private.json'
        private.touch(mode=0o600)
        private.chmod(0o600)
        private.write_text(json.dumps({'email': f'account-smoke-{secrets.token_hex(6)}@example.invalid', 'password': password, 'password_hash': hashed}))
    finally:
        environment.down()
    (job / 'test-results.json').write_text(json.dumps({'api_sha256': sha(binary), 'schema': SCHEMA, **results}, indent=2))


def package(job, commit):
    step('package')
    out = job / 'out'
    results = json.loads((job / 'test-results.json').read_text())
    api = sha(out / 'gps-tracker-api')
    require(results.pop('api_sha256') == api, 'suites ran against a different binary')
    require(RUST in (job / 'build-api.log').read_text(), 'build log lacks the unit test result')
    migrations = {}
    with tarfile.open(job / 'source.tar.gz') as archive:
        require(archive.pax_headers.get('comment') == commit, f'source.tar.gz is not git archive of {commit}')
        for member in archive.getmembers():
            if member.isfile() and member.name.startswith('gps-tracker-api/migrations/') and member.name.endswith('.sql'):
                migrations[int(pathlib.PurePosixPath(member.name).name.split('_')[0])] = hashlib.sha256(archive.extractfile(member).read()).hexdigest()
    require(set(migrations) == set(range(1, SCHEMA + 1)), 'source does not hold migrations 1..97 exactly')
    shutil.copy2(job / 'source.tar.gz', out / 'source.tar.gz')
    for name in OPS:
        shutil.copy2(job / 'src/ops' / name, out / name)
    shutil.copy2(job / 'smoke-private.json', out / 'smoke-private.json')
    (out / 'smoke-private.json').chmod(0o600)
    validation = {**results, 'api_sha256': api, 'rust_passed': 58, 'rust_ignored': 2, 'fmt_clippy_passed': True,
                  'web_tests_passed': WEB_TESTS, 'web_build_passed': True}
    manifest = {'release': RELEASE, 'commit': commit, 'schema': SCHEMA, 'previous': PREVIOUS, 'api_sha256': api,
                'web_sha256': sha(out / 'web.tar.gz'), 'source_sha256': sha(out / 'source.tar.gz'),
                'migrations': {str(version): digest for version, digest in sorted(migrations.items())},
                'ops_files': {name: sha(out / name) for name in OPS}}
    (out / 'validation.json').write_text(json.dumps(validation, indent=2))
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    (out / 'rehearsal.json').unlink(missing_ok=True)


def load(path):
    # No bytecode cache: the staged directory must hold only what the manifest lists.
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def rehearse(job, commit):
    step('rehearse')
    scripts(job)
    out, box = job / 'out', job / 'rehearsal'
    shutil.rmtree(box, ignore_errors=True)
    stage = box / 'stage'
    shutil.copytree(out, stage)
    # A private copy of the previous release, so its own job directory stays untouched.
    old = box / 'previous'
    (old / 'out').mkdir(parents=True)
    shutil.copy2(PREVIOUS_JOB / 'out/gps-tracker-api', old / 'out/gps-tracker-api')
    require(sha(old / 'out/gps-tracker-api') == PREVIOUS['api_sha256'], 'previous API binary is not the pinned one')
    shutil.copy2(PREVIOUS_JOB / 'test_privacy_receipts.py', old / 'test_privacy_receipts.py')
    binary = box / 'bin/gps-tracker-api'
    binary.parent.mkdir()
    shutil.copy2(old / 'out/gps-tracker-api', binary)
    previous_web = box / 'releases' / PREVIOUS['release'] / 'web'
    previous_web.mkdir(parents=True)
    with tarfile.open(PREVIOUS_JOB / 'out/web.tar.gz') as archive:
        archive.extractall(previous_web, filter='data')
    (box / 'dist-root').symlink_to(previous_web)
    (box / 'backups').mkdir()

    sandbox = Environment(job)
    sandbox.up()
    record = {'passed': False, 'release': RELEASE, 'commit': commit, 'api_sha256': sha(stage / 'gps-tracker-api'),
              'release_script_sha256': sha(stage / 'release_privacy_raster.py'), 'previous': PREVIOUS, 'steps': []}

    def done(name, **detail):
        record['steps'].append({'step': name, **detail})
        print(f'ok   {name}', flush=True)

    try:
        (box / 'api.env').write_text(f'DATABASE_URL=postgres://postgres:closure-test-only@{sandbox.address(DB)}:5432/gps_closure_test\nJWT_SECRET={JWT_SECRET}\n')
        release = load(stage / 'release_privacy_raster.py')
        release.PREVIOUS['web'] = str(previous_web)

        class Rehearsal(release.Site):
            environment = 'test'
            fail_start = False

            def require_root(self):
                pass

            def stop(self):
                sandbox.stop_api()

            def start(self):
                url = DATABASE_URL.replace('closure-db', 'unreachable-db') if self.fail_start else DATABASE_URL
                self.fail_start = False
                sandbox.start_api(self.api, url)

            def restart(self):
                self.stop()
                self.start()

            def health(self):
                return sandbox.health()

            def served(self, path):
                return (self.web.resolve() / ('index.html' if path == '/profile' else path.lstrip('/'))).read_bytes()

            def neighbors(self):
                return {'rehearsal': 'no neighbouring services'}

            def timer_active(self):
                return True

        site = Rehearsal()
        site.stage, site.api, site.env, site.web = stage, binary, box / 'api.env', box / 'dist-root'
        site.release, site.backup = box / 'releases' / RELEASE / 'web', box / 'backups' / RELEASE

        def schema():
            return int(docker('exec', DB, 'psql', '-U', 'postgres', '-d', 'gps_closure_test', '-Atc', 'SELECT max(version) FROM _sqlx_migrations'))

        def previous_suite():
            # Round-14 binary and its own receipt suite: leaves round-14 rows behind, as production has.
            return suite(job, old / 'test_privacy_receipts.py', cwd=old, label='previous-')

        site.start()
        release.wait_health(site, PREVIOUS['release'])
        require(schema() == SCHEMA - 1, 'previous release did not migrate to 96')
        done('previous release running on schema 96', suite_groups=previous_suite())

        require(release.check(site)['ready'], 'preflight did not pass')
        done('check passes and changes nothing', schema=schema())

        site.fail_start = True
        try:
            release.apply(site)
            require(False, 'a new API that cannot start was not detected')
        except release.Stop as stop:
            require('returned to' in str(stop), f'unexpected failure handling: {stop}')
        require(release.check(site)['ready'] and schema() == SCHEMA - 1 and sha(binary) == PREVIOUS['api_sha256'], 'automatic return left a different state')
        done('new API fails to start -> automatic return to the previous release', schema=schema())

        report = release.apply(site)
        require(report['schema'] == SCHEMA == schema() and report['health']['release'] == RELEASE and sha(binary) == record['api_sha256'], 'apply did not reach the new release')
        require(site.web.resolve() == site.release, 'web link was not switched')
        done('apply: schema 97, new API healthy with the recorded migration, web switched', health=report['health'])

        report = release.rollback(site)
        require(report['health']['release'] == PREVIOUS['release'] and schema() == SCHEMA - 1 and site.web.resolve() == previous_web, 'rollback did not restore the previous release')
        require(release.check(site)['ready'], 'state after rollback is not a clean previous release')
        done('rollback: schema 96, previous API and web', suite_groups=previous_suite())

        report = release.apply(site)
        require(report['schema'] == SCHEMA == schema(), 'second apply failed')
        done('apply again after rollback', health=report['health'])

        groups = {script: suite(job, job / script, label='upgraded-') for script in ('test_privacy_receipt_scaling.py', 'test_privacy_receipts.py', 'test_privacy_images.py')}
        require(list(groups.values()) == [9, 7, 8], f'suites on the upgraded schema: {groups}')
        done('suites pass on the upgraded (not freshly created) schema', groups=groups)

        smoke = load(stage / 'smoke_privacy_raster.py')

        class Smoke(smoke.Site):
            environment = 'test'

        Smoke.health_url, Smoke.api_url = sandbox.base() + '/health', sandbox.base() + '/api/v1'
        Smoke.stage, Smoke.env, Smoke.ops = stage, box / 'api.env', job / 'src/ops'
        result = smoke.main(Smoke)
        require(result['schema'] == SCHEMA and result['synthetic_accounts_closed'], 'smoke did not complete')
        done('production smoke script completes against the rehearsal copy')

        try:
            release.rollback(site)
            require(False, 'rollback was allowed although the new columns are in use')
        except release.Stop as stop:
            require('repair forward' in str(stop), f'unexpected rollback refusal: {stop}')
        require(schema() == SCHEMA and sandbox.health()['release'] == RELEASE, 'refused rollback changed something')
        done('rollback is refused once rows use the new columns')
        record['passed'] = True
    finally:
        sandbox.down()
        shutil.rmtree(box, ignore_errors=True)
    # The production entry point must accept exactly this record and reject one for another binary.
    gate = load(out / 'release_privacy_raster.py')
    staged = type('Staged', (), {'stage': out})
    (out / 'rehearsal.json').write_text(json.dumps({**record, 'api_sha256': '0' * 64}, indent=2))
    try:
        gate.rehearsed(staged)
        require(False, 'a rehearsal record for another binary was accepted')
    except gate.Stop:
        pass
    (out / 'rehearsal.json').write_text(json.dumps(record, indent=2))
    gate.rehearsed(staged)
    print('ok   production entry accepts this rehearsal record only', flush=True)


def main():
    steps = {'build': build, 'test': test, 'package': package, 'rehearse': rehearse}
    if len(sys.argv) < 3 or any(name not in steps for name in sys.argv[3:]):
        sys.exit(__doc__)
    job, commit = pathlib.Path(sys.argv[1]).resolve(), sys.argv[2]
    require(len(commit) == 40 and (job / 'source.tar.gz').is_file(), 'need <job-dir>/source.tar.gz and the full commit id')
    for name in sys.argv[3:] or list(steps):
        steps[name](job, commit)
    out = job / 'out'
    require(all(p.is_file() for p in out.iterdir()), 'the staged directory holds something other than files')
    if (out / 'rehearsal.json').exists():
        print(json.dumps({'stage': str(out), 'files': {p.name: sha(p) for p in sorted(out.iterdir()) if p.is_file() and p.name != 'smoke-private.json'}}, indent=2))


if __name__ == '__main__':
    main()
