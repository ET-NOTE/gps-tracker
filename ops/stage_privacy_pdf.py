"""Build-host staging for release privacy-pdf-20261106-r1 (round 16). Never touches production.

    python3 stage_privacy_pdf.py <job-dir> <commit> [step ...]

<job-dir>/source.tar.gz must be `git archive <commit>` of gps-tracker-api, gps-pdf-render,
gps-tracker-web and ops. Steps (default: all, in this order; each stops on the first failure):

  build     API (fmt, Clippy, unit tests, release build) and web (tests, build) in the pinned image;
            the PDF processor in its own image and toolchain, then its self-test on this kernel
  test      throwaway DB on an internal Docker network: PDF suite and the privacy regressions,
            with the processor next to the API as it will be in production
  package   out/manifest.json, out/validation.json, the ops scripts and a one-time smoke credential
  rehearse  the previous release on a throwaway DB -> check, a refused check, two forced failures
            with automatic return, apply, rollback, apply, suites and smoke on the upgraded schema
            -> out/rehearsal.json

<job-dir>/out is then the complete directory to place on the production host.
"""
import fcntl
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request

RELEASE = 'privacy-pdf-20261106-r1'
SCHEMA = 98
PREVIOUS = {
    'release': 'privacy-raster-20261106-r1',
    'api_sha256': '9acd61b3e21a6c188fe9140a764d67ea65b9ee83c18edef2404de78387691250',
}
PREVIOUS_JOB = pathlib.Path('/home/etcom-hub/build/gps-privacy-raster-20261106-r1')
PREVIOUS_SUITES = [('test_privacy_receipt_scaling.py', 9), ('test_privacy_receipts.py', 7)]
CACHE = pathlib.Path('/home/etcom-hub/build/gps-tracker')
PYTHON = '/home/etcom-hub/build/gps-location-erasure-20261105/venv/bin/python'
IMAGE = 'gps-build:rust1.88-node22.22.2'
PDF_IMAGE = 'gps-pdf-build:rust1.92'  # ops/pdf-builder.Dockerfile: the processor's own toolchain
DB_IMAGE = 'timescale/timescaledb:2.19.3-pg14'
# The suites guard these exact names so they cannot run anywhere else.
NETWORK = 'gps-account-closure-test-20261105'
DB = 'gps-account-closure-db-20261105'
API = 'gps-account-closure-api-20261105'
DATABASE_URL = 'postgres://postgres:closure-test-only@closure-db:5432/gps_closure_test'
JWT_SECRET = 'closure-test-only-jwt-key-32-characters'
SUITES = [  # script, validation key, groups
    ('test_privacy_receipt_pdf.py', 'pdf_groups', 7),
    ('test_privacy_receipt_scaling.py', 'scaling_groups', 9),
    ('test_privacy_receipts.py', 'receipt_groups', 7),
    ('test_privacy_images.py', 'image_groups', 8),
    ('test_privacy_redacted.py', 'redacted_groups', 8),
    ('test_privacy_company_tasks.py', 'company_task_groups', 10),
    ('test_privacy_account_sections.py', 'sections_groups', 5),
    ('test_privacy_packages.py', 'package_groups', 9),
    ('test_privacy_company.py', 'company_groups', 10),
    ('test_privacy_delivery.py', 'delivery_groups', 11),
    ('test_account_closure.py', 'closure_groups', 15),
]
RUST = '60 passed; 0 failed; 2 ignored'
RENDERER_TESTS = '5 passed; 0 failed; 0 ignored'
WEB_TESTS = 224
OPS = ['release_privacy_pdf.py', 'smoke_privacy_pdf.py']
SCOPE = "SELECT md5(pg_get_functiondef('privacy_receipt_in_scope(bigint,bigint)'::regprocedure))"


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


def psql(query):
    return docker('exec', DB, 'psql', '-U', 'postgres', '-d', 'gps_closure_test', '-Atc', query)


def selftest(binary):
    """The processor's own proof on this kernel, started with no environment as the API starts it."""
    done = subprocess.run([str(binary), 'selftest'], env={}, cwd='/', stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
    report = json.loads(done.stdout)
    probes = ('open_file', 'open_socket', 'start_program', 'start_process', 'too_much_memory', 'too_much_cpu')
    require(done.returncode == 0 and report['sandbox_holds'] and report['renders_inside_sandbox'] and all(report[p]['blocked'] for p in probes),
            f'PDF processor self-test failed: {done.stdout.decode()[:400]}')
    return report


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

    def start_api(self, binary, renderer=None, database_url=DATABASE_URL):
        self.stop_api()
        for name in ('uploads', 'private'):
            (self.storage / name).mkdir(parents=True, exist_ok=True)
        # Next to the API binary, where the API looks for it. The previous release has none.
        processor = ['-v', f'{renderer}:/gps-pdf-render:ro'] if renderer else []
        docker('run', '-d', '--name', API, '--network', NETWORK, '--memory=550m', '--user', f'{os.getuid()}:{os.getgid()}',
               '--cap-drop=ALL', '--security-opt=no-new-privileges', '-e', 'APP_ENV=test', '-e', 'BIND_ADDR=0.0.0.0:3043',
               '-e', f'DATABASE_URL={database_url}', '-e', f'JWT_SECRET={JWT_SECRET}', '-e', 'SMS_DEV_MODE=1',
               '-e', f'UPLOAD_DIR={self.storage}/uploads', '-e', f'PRIVATE_UPLOAD_DIR={self.storage}/private',
               '-v', f'{self.storage}:{self.storage}', '-v', f'{binary}:/api:ro', *processor, IMAGE, '/api')

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


def builder(job, image, name, workdir, script, log, environment):
    args = ['docker', 'run', '--rm', '--name', name, '--cpus=8', '--memory=6g', '--pids-limit=512', '--cap-drop=ALL',
            '--security-opt=no-new-privileges', '--user', f'{os.getuid()}:{os.getgid()}']
    for key, value in environment.items():
        args += ['-e', f'{key}={value}']
    args += ['-v', f'{CACHE}/cache:/cache', '-v', f'{job}/src:/work', '-v', f'{job}/out:/out', '-w', workdir, image, 'bash', '-euc', script]
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
    require(sha(__file__) == sha(job / 'src/ops/stage_privacy_pdf.py'), 'this staging script is not the one in the source archive')
    shutil.rmtree(job / 'out', ignore_errors=True)
    (job / 'out').mkdir()
    if subprocess.run(['docker', 'image', 'inspect', PDF_IMAGE], capture_output=True).returncode:
        print(f'building {PDF_IMAGE} from ops/pdf-builder.Dockerfile', flush=True)
        docker('build', '-t', PDF_IMAGE, '-f', str(job / 'src/ops/pdf-builder.Dockerfile'), str(job / 'src/ops'))
    cargo = {'CARGO_HOME': '/cache/cargo', 'CARGO_BUILD_JOBS': '8', 'GPS_RELEASE': RELEASE}
    with open(CACHE / 'build.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        api = builder(job, IMAGE, 'gps-privacy-pdf-api', '/work/gps-tracker-api',
                      'cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked '
                      '&& cargo build --locked --release && cp /cache/target/release/gps-tracker-api /out/gps-tracker-api.next '
                      '&& mv /out/gps-tracker-api.next /out/gps-tracker-api',
                      'build-api.log', {**cargo, 'CARGO_TARGET_DIR': '/cache/target'})
        # Its own image, toolchain and target directory; a static binary that needs nothing from the host.
        target = 'x86_64-unknown-linux-musl'
        processor = builder(job, PDF_IMAGE, 'gps-privacy-pdf-processor', '/work/gps-pdf-render',
                            f'cargo fmt --check && cargo clippy --locked --all-targets --target {target} -- -D warnings '
                            f'&& cargo test --locked --target {target} && cargo build --locked --release --target {target} '
                            f'&& cp /cache/target-pdf/{target}/release/gps-pdf-render /out/gps-pdf-render.next '
                            '&& mv /out/gps-pdf-render.next /out/gps-pdf-render',
                            'build-processor.log', {**cargo, 'CARGO_TARGET_DIR': '/cache/target-pdf'})
        web = builder(job, IMAGE, 'gps-privacy-pdf-web', '/work/gps-tracker-web',
                      'npm ci --ignore-scripts && npm test && npm run build && tar -czf /out/web.tar.gz -C dist .',
                      'build-web.log', {'VITE_BASE': '/', 'npm_config_cache': '/cache/npm'})
    require(RUST in api, f'API unit tests are not "{RUST}"')
    require(RENDERER_TESTS in processor, f'PDF processor unit tests are not "{RENDERER_TESTS}"')
    require(f'# pass {WEB_TESTS}' in web and '# fail 0' in web, f'web tests are not {WEB_TESTS} passed, 0 failed')
    renderer = job / 'out/gps-pdf-render'
    renderer.chmod(0o755)
    (job / 'renderer-selftest.json').write_text(json.dumps({'renderer_sha256': sha(renderer), 'kernel': os.uname().release, **selftest(renderer)}, indent=2))
    print(json.dumps({'api_sha256': sha(job / 'out/gps-tracker-api'), 'renderer_sha256': sha(renderer), 'web_sha256': sha(job / 'out/web.tar.gz')}), flush=True)


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
    binary, renderer = job / 'out/gps-tracker-api', job / 'out/gps-pdf-render'
    environment = Environment(job)
    environment.up()
    try:
        environment.start_api(binary, renderer)
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
        hashed = psql(f"SELECT password_hash FROM users WHERE id={int(user['user_id'])}")
        require(hashed.startswith('$argon2'), 'could not obtain a password hash')
        private = job / 'smoke-private.json'
        private.touch(mode=0o600)
        private.chmod(0o600)
        private.write_text(json.dumps({'email': f'account-smoke-{secrets.token_hex(6)}@example.invalid', 'password': password, 'password_hash': hashed}))
    finally:
        environment.down()
    (job / 'test-results.json').write_text(json.dumps({'api_sha256': sha(binary), 'renderer_sha256': sha(renderer), 'schema': SCHEMA, **results}, indent=2))


def package(job, commit):
    step('package')
    out = job / 'out'
    results = json.loads((job / 'test-results.json').read_text())
    proof = json.loads((job / 'renderer-selftest.json').read_text())
    api, renderer = sha(out / 'gps-tracker-api'), sha(out / 'gps-pdf-render')
    require(results.pop('api_sha256') == api and results.pop('renderer_sha256') == renderer, 'suites ran against different binaries')
    require(proof['renderer_sha256'] == renderer and proof['sandbox_holds'] and proof['renders_inside_sandbox'], 'self-test record is for another PDF processor')
    require(RUST in (job / 'build-api.log').read_text() and RENDERER_TESTS in (job / 'build-processor.log').read_text(), 'build logs lack the unit test results')
    migrations = {}
    with tarfile.open(job / 'source.tar.gz') as archive:
        require(archive.pax_headers.get('comment') == commit, f'source.tar.gz is not git archive of {commit}')
        for member in archive.getmembers():
            if member.isfile() and member.name.startswith('gps-tracker-api/migrations/') and member.name.endswith('.sql'):
                migrations[int(pathlib.PurePosixPath(member.name).name.split('_')[0])] = hashlib.sha256(archive.extractfile(member).read()).hexdigest()
    require(set(migrations) == set(range(1, SCHEMA + 1)), 'source does not hold migrations 1..98 exactly')
    # The release script checks that the host has room for the processor's own memory ceiling.
    ceiling = re.search(r'MEMORY_BYTES: u64 = (\d+) \* 1024 \* 1024;', (job / 'src/gps-pdf-render/src/sandbox.rs').read_text())
    require(ceiling, 'cannot read the PDF processor memory ceiling from its source')
    shutil.copy2(job / 'source.tar.gz', out / 'source.tar.gz')
    for name in OPS:
        shutil.copy2(job / 'src/ops' / name, out / name)
    shutil.copy2(job / 'smoke-private.json', out / 'smoke-private.json')
    (out / 'smoke-private.json').chmod(0o600)
    (out / 'gps-pdf-render').chmod(0o755)
    validation = {**results, 'api_sha256': api, 'renderer_sha256': renderer, 'rust_passed': 60, 'rust_ignored': 2,
                  'renderer_tests_passed': 5, 'renderer_selftest_passed': True, 'renderer_selftest_kernel': proof['kernel'],
                  'fmt_clippy_passed': True, 'web_tests_passed': WEB_TESTS, 'web_build_passed': True}
    manifest = {'release': RELEASE, 'commit': commit, 'schema': SCHEMA, 'previous': PREVIOUS, 'api_sha256': api,
                'renderer_sha256': renderer, 'renderer_memory_bytes': int(ceiling.group(1)) * 1024 * 1024,
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
    for script, _ in PREVIOUS_SUITES:
        shutil.copy2(PREVIOUS_JOB / script, old / script)
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
              'renderer_sha256': sha(stage / 'gps-pdf-render'),
              'release_script_sha256': sha(stage / 'release_privacy_pdf.py'), 'previous': PREVIOUS,
              'kernel': os.uname().release, 'steps': []}

    def done(name, **detail):
        record['steps'].append({'step': name, **detail})
        print(f'ok   {name}', flush=True)

    try:
        (box / 'api.env').write_text(f'DATABASE_URL=postgres://postgres:closure-test-only@{sandbox.address(DB)}:5432/gps_closure_test\nJWT_SECRET={JWT_SECRET}\n')
        release = load(stage / 'release_privacy_pdf.py')
        release.PREVIOUS['web'] = str(previous_web)

        class Rehearsal(release.Site):
            environment = 'test'
            fail_start = False        # the new API cannot reach its database
            confined = False          # the API service has a system call filter of its own
            confine_on_start = False  # ... which only shows once the new API runs

            def require_root(self):
                pass

            def stop(self):
                sandbox.stop_api()

            def start(self):
                url = DATABASE_URL.replace('closure-db', 'unreachable-db') if self.fail_start else DATABASE_URL
                self.fail_start = False
                self.confined, self.confine_on_start = self.confined or self.confine_on_start, False
                sandbox.start_api(self.api, self.renderer if self.renderer.exists() else None, url)

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

            def service(self):
                # No service manager here: the self-test runs as this account, on this kernel.
                memory = dict(line.split(':', 1) for line in pathlib.Path('/proc/meminfo').read_text().splitlines())
                return {'user': None, 'group': None, 'system_call_filter': self.confined, 'memory_max': 'max', 'memory_current': 0,
                        'host_memory_available': 1024 * (int(memory['MemAvailable'].split()[0]) + int(memory['SwapFree'].split()[0]))}

        site = Rehearsal()
        site.stage, site.api, site.renderer = stage, binary, binary.with_name('gps-pdf-render')
        site.env, site.web = box / 'api.env', box / 'dist-root'
        site.release, site.backup = box / 'releases' / RELEASE / 'web', box / 'backups' / RELEASE

        def schema():
            return int(psql('SELECT max(version) FROM _sqlx_migrations'))

        def previous_suites():
            # Round-15 binary and its own suites: leave round-15 rows behind, as production has.
            return {script: suite(job, old / script, cwd=old, label='previous-') for script, _ in PREVIOUS_SUITES}

        def is_previous(original):
            return (schema() == SCHEMA - 1 and sha(binary) == PREVIOUS['api_sha256'] and not site.renderer.exists()
                    and psql(SCOPE) == original and site.web.resolve() == previous_web and sandbox.health()['release'] == PREVIOUS['release'])

        def tree():
            # Everything the release may touch: binaries, web link and releases, backups.
            return sorted((str(p.relative_to(box)), 'link' if p.is_symlink() else 'dir' if p.is_dir() else sha(p))
                          for p in box.rglob('*') if stage not in p.parents and old not in p.parents)

        site.start()
        release.wait_health(site, PREVIOUS['release'])
        require(schema() == SCHEMA - 1, 'previous release did not migrate to 97')
        groups = previous_suites()
        require(list(groups.values()) == [n for _, n in PREVIOUS_SUITES], f'previous suites: {groups}')
        original = psql(SCOPE)
        done('previous release running on schema 97', suite_groups=groups)

        before = tree()
        report = release.check(site)
        require(report['ready'] and report['pdf_processor']['self_test'] == 'passed', 'preflight did not pass')
        require(tree() == before and is_previous(original), 'check changed something')
        done('check passes, proves the staged processor on this kernel and changes nothing', pdf_processor=report['pdf_processor'])

        site.confined = True
        try:
            release.check(site)
            require(False, 'a service with its own system call filter was accepted')
        except release.Stop as stop:
            require('system call filter' in str(stop), f'unexpected refusal: {stop}')
        site.confined = False
        require(tree() == before, 'refused check changed something')
        done('check refuses a service that would confine the processor unseen')

        site.fail_start = True
        try:
            release.apply(site)
            require(False, 'a new API that cannot start was not detected')
        except release.Stop as stop:
            require('returned to' in str(stop), f'unexpected failure handling: {stop}')
        require(release.check(site)['ready'] and is_previous(original), 'automatic return left a different state')
        done('new API fails to start -> automatic return to the previous release', schema=schema())

        site.confine_on_start = True
        try:
            release.apply(site)
            require(False, 'a processor that cannot be proven after the restart was not detected')
        except release.Stop as stop:
            require('returned to' in str(stop) and 'system call filter' in str(stop), f'unexpected failure handling: {stop}')
        site.confined = False
        require(release.check(site)['ready'] and is_previous(original), 'automatic return left a different state')
        done('installed processor cannot be proven after the restart -> automatic return', schema=schema())

        report = release.apply(site)
        require(report['schema'] == SCHEMA == schema() and report['health']['release'] == RELEASE and sha(binary) == record['api_sha256'], 'apply did not reach the new release')
        require(sha(site.renderer) == record['renderer_sha256'] == report['renderer_sha256'] and site.renderer.stat().st_mode & 0o777 == 0o755, 'processor was not installed next to the API')
        require(site.web.resolve() == site.release and psql(SCOPE) != original, 'web link or receipt scope was not switched')
        done('apply: schema 98, new API healthy, processor installed and proven, web switched', health=report['health'], pdf_processor=report['pdf_processor'])

        report = release.rollback(site)
        require(report['health']['release'] == PREVIOUS['release'] and not report['renderer_installed'] and is_previous(original), 'rollback did not restore the previous release')
        require(release.check(site)['ready'], 'state after rollback is not a clean previous release')
        groups = previous_suites()
        require(list(groups.values()) == [n for _, n in PREVIOUS_SUITES], f'previous suites after rollback: {groups}')
        done('rollback: schema 97, previous API and web, no processor, receipt scope as before', suite_groups=groups)

        report = release.apply(site)
        require(report['schema'] == SCHEMA == schema(), 'second apply failed')
        done('apply again after rollback', health=report['health'])

        upgraded = ['test_privacy_receipt_pdf.py', 'test_privacy_receipt_scaling.py', 'test_privacy_receipts.py', 'test_privacy_images.py']
        groups = {script: suite(job, job / script, label='upgraded-') for script in upgraded}
        require(list(groups.values()) == [7, 9, 7, 8], f'suites on the upgraded schema: {groups}')
        done('suites pass on the upgraded (not freshly created) schema', groups=groups)

        smoke = load(stage / 'smoke_privacy_pdf.py')

        class Smoke(smoke.Site):
            environment = 'test'

        Smoke.health_url, Smoke.api_url = sandbox.base() + '/health', sandbox.base() + '/api/v1'
        Smoke.stage, Smoke.env, Smoke.renderer, Smoke.ops = stage, box / 'api.env', site.renderer, job / 'src/ops'
        # The suites above used this address's request allowance; production starts from an idle one.
        psql('DELETE FROM privacy_result_limits')
        result = smoke.main(Smoke)
        require(result['schema'] == SCHEMA and result['synthetic_accounts_closed'] and result['renderer_sha256'] == record['renderer_sha256'], 'smoke did not complete')
        done('production smoke script completes against the rehearsal copy')

        try:
            release.rollback(site)
            require(False, 'rollback was allowed although the new columns are in use')
        except release.Stop as stop:
            require('repair forward' in str(stop), f'unexpected rollback refusal: {stop}')
        require(schema() == SCHEMA and sandbox.health()['release'] == RELEASE and site.renderer.exists(), 'refused rollback changed something')
        done('rollback is refused once rows use the new columns')
        record['passed'] = True
    finally:
        sandbox.down()
        shutil.rmtree(box, ignore_errors=True)
    # The production entry point must accept exactly this record and reject one for other binaries.
    gate = load(out / 'release_privacy_pdf.py')
    staged = type('Staged', (), {'stage': out})
    for key in ('api_sha256', 'renderer_sha256'):
        (out / 'rehearsal.json').write_text(json.dumps({**record, key: '0' * 64}, indent=2))
        try:
            gate.rehearsed(staged)
            require(False, f'a rehearsal record with another {key} was accepted')
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
