"""Build-host staging for infrastructure round 1, stage 2: release pdf-service-20261106-r1 and the
PDF processor as its own service. Never touches production.

    python3 stage_pdf_service.py <job-dir> <commit> [step ...]

<job-dir>/source.tar.gz must be `git archive <commit>` of gps-tracker-api, gps-pdf-render,
gps-tracker-web and ops. Steps (default: all, in this order; each stops on the first failure):

  build     the API only (fmt, Clippy, unit tests, release build) in the pinned image. The PDF
            processor, the web and the migrations must be identical to the previous release's
            source; the processor is the file production runs, proven again on this kernel
  test      throwaway DB on an internal Docker network: every privacy regression with the API
            starting the processor itself, then the PDF suite again with the API sending every
            page to a socket
  package   out/manifest.json, out/validation.json, the ops scripts, two one-time smoke credentials
  rehearse  a container with a real systemd laid out like production today (round 16 release,
            runtime account in place): API release check / forced failure / apply / rollback /
            apply, then the processor service check / two forced failures / apply / rollback /
            apply / reboot, with the functional check after every change -> out/rehearsal.json

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

NAME = 'pdf-service-20261106'
RELEASE = 'pdf-service-20261106-r1'
SCHEMA = 98
PREVIOUS = {
    'release': 'privacy-pdf-20261106-r1',
    'api_sha256': 'b6ac9edb5bacae749db3c2561f95763860599abc7de7099dcf50bc63a427bba7',
}
PREVIOUS_OUT = pathlib.Path('/home/etcom-hub/build/gps-privacy-pdf-20261106-r1/out')  # what production runs today
RENDERER = '3eaaf5535c01c58e1c4f3eae5e3a4799c59b916233960897581d5ee7707d4ffb'
RENDERER_PATH = '/home/mmm/projects/gps-tracker-api/bin/gps-pdf-render'
# Only the API binary is replaced, so everything else must be the previous release's source.
UNCHANGED = ('gps-pdf-render/', 'gps-tracker-web/', 'gps-tracker-api/migrations/')
RUST = '61 passed; 0 failed; 2 ignored'
OPS = ['release_pdf_service.py', 'pdf_service.py', 'smoke_pdf_service.py']
CREDENTIALS = ['smoke-private.json', 'smoke-private-service.json']
# Where the test container's stand-in for the service listens (ops/pdf_socket_emulator.py).
TEST_SOCKET, TEST_COUNT = '/tmp/gps-pdf-render.sock', '/tmp/gps-pdf-render.count'
SOCKET = '/run/gps-pdf-render/render.sock'
STAGE = f'/home/mmm/gps-artifacts/{NAME}'
HEALTH = 'http://127.0.0.1:3040/gps-tracker/health'
MEMORY_MAX = 832 * 1024 * 1024

PROVISION = r'''#!/bin/bash
# What stage 2 finds on production besides the stage 1 layout: its own staged directory and the web link.
set -euo pipefail
install -d -o mmm -g mmm -m 755 __STAGE__ /home/mmm/releases /home/mmm/releases/__PREVIOUS__ /home/mmm/releases/__PREVIOUS__/web /home/mmm/gps-tracker-web
ln -s /home/mmm/releases/__PREVIOUS__/web /home/mmm/gps-tracker-web/dist-root
'''

ENTRY = r'''"""Runs the staged scripts on the rehearsal host. Only addresses, neighbours and forced failures differ."""
import importlib.util, json, sys, urllib.request
sys.dont_write_bytecode = True
STAGE, HEALTH = '__STAGE__', '__HEALTH__'
def load(name):
    spec = importlib.util.spec_from_file_location(name, f'{STAGE}/{name}.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
kind, mode = sys.argv[1], sys.argv[2]
if kind == 'smoke':
    smoke = load('smoke_pdf_service')
    class Smoke(smoke.Site):
        environment = 'test'
        health_url, api_url = HEALTH, 'http://127.0.0.1:3040/gps-tracker/api/v1'
        private_child = private_service = sys.argv[3]
    print(json.dumps(smoke.main(Smoke, service=mode == 'service')))
    sys.exit(0)
if kind == 'release':
    module = load('release_pdf_service')
    class Rehearsal(module.Site):
        environment = 'test'
        def health(self):
            with urllib.request.urlopen(HEALTH, timeout=5) as response:
                return json.load(response)
        def neighbors(self):
            return {'processes': module.run(['systemctl', 'show', 'gps-tracker', 'pm2-mmm', '-p', 'MainPID', '-p', 'ActiveEnterTimestamp'])}
    if mode == 'unhealthy':
        # The new API does not stay up: it is stopped right after its first start.
        restart, wait, calls = Rehearsal.restart, module.wait_health, []
        def failing(self):
            restart(self)
            if not calls:
                calls.append(1)
                module.run(['systemctl', 'stop', 'gps-tracker-api'])
        Rehearsal.restart = failing
        module.wait_health = lambda site, release, seconds=45: wait(site, release, 8 if release == module.RELEASE else seconds)
        mode = 'apply'
else:
    module = load('pdf_service')
    class Rehearsal(module.Site):
        environment = 'test'
        health_urls = (HEALTH,)
        neighbors = ('gps-tracker.service', 'pm2-mmm.service', 'gps-privacy-accounts.timer', 'gps-privacy-files.timer')
    if mode == 'unproven':
        # The processor cannot be proven in the service environment: without `seccomp` in the
        # allowlist it is stopped when it installs its own filter, as found on this systemd.
        module.CONFINEMENT = module.CONFINEMENT.replace('SystemCallFilter=@system-service seccomp', 'SystemCallFilter=@system-service')
        mode = 'apply'
    elif mode == 'late':
        # Everything verified and the API already uses the service; the very last check fails.
        final, calls = module.untouched, []
        def failing(site, found):
            if not calls:
                calls.append(1)
                raise module.Stop('forced failure: after the API was switched to the processor service')
            final(site, found)
        module.untouched = failing
        mode = 'apply'
try:
    print(json.dumps(getattr(module, mode)(Rehearsal()), default=str))
except module.Stop as stop:
    print(json.dumps({'stopped': str(stop)}))
    sys.exit(3)
'''

SNAPSHOT = r'''"""What stage 2 may touch, and what it must leave alone."""
import grp, hashlib, json, os, pathlib, pwd, subprocess, urllib.request
def sha(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
def owner(path):
    info = os.lstat(path)
    return [pwd.getpwuid(info.st_uid).pw_name, grp.getgrgid(info.st_gid).gr_name, oct(info.st_mode & 0o7777)]
def show(unit, name):
    return subprocess.run(['systemctl', 'show', unit, f'-p{name}', '--value'], capture_output=True, text=True).stdout.strip()
def exists(name):
    try: pwd.getpwnam(name); return True
    except KeyError: return False
api, units = '/home/mmm/projects/gps-tracker-api', pathlib.Path('/etc/systemd/system')
pid = show('gps-tracker-api.service', 'MainPID')
environ = dict(i.split('=', 1) for i in pathlib.Path(f'/proc/{pid}/environ').read_bytes().decode(errors='replace').split('\0') if '=' in i)
with urllib.request.urlopen('__HEALTH__', timeout=5) as response:
    health = json.load(response)
failed = subprocess.run(['systemctl', 'list-units', '--failed', '--no-legend', '--plain'], capture_output=True, text=True).stdout
print(json.dumps({
    'release': health.get('release'), 'api_sha256': sha(f'{api}/bin/gps-tracker-api'), 'renderer_sha256': sha(f'{api}/bin/gps-pdf-render'),
    'api_runs_as': show('gps-tracker-api.service', 'User'), 'api_socket': environ.get('GPS_PDF_SOCKET'),
    'gps_unit_files': sorted(str(p.relative_to(units)) for p in units.rglob('*') if 'gps' in str(p.relative_to(units)) and not p.is_dir()),
    'drop_in_directories': {p.name: oct(p.stat().st_mode & 0o7777) for p in sorted(units.glob('gps-*.d'))},
    'accounts': {name: exists(name) for name in ('gps-api', 'gps-pdf')},
    'account_files': {p: sha(p) for p in ('/etc/passwd', '/etc/group', '/etc/shadow', '/etc/gshadow')},
    'run_directory': os.path.exists('/run/gps-pdf-render'),
    'socket_state': show('gps-pdf-render.socket', 'ActiveState'), 'proof_state': show('gps-pdf-render-selftest.service', 'ActiveState'),
    'files': {p: owner(p) for p in (f'{api}/.env', '/etc/gps-tracker/fcm-service-account.json', f'{api}/bin/gps-tracker-api', f'{api}/bin/gps-pdf-render')},
    'bin': sorted(p.name for p in pathlib.Path(f'{api}/bin').iterdir()),
    'web': os.path.realpath('/home/mmm/gps-tracker-web/dist-root'),
    'neighbor_pids': {u: show(u, 'MainPID') for u in ('gps-tracker.service', 'pm2-mmm.service')},
    'timers_active': [show(t, 'ActiveState') for t in ('gps-privacy-accounts.timer', 'gps-privacy-files.timer')],
    'failed_units': sorted(line.split()[0] for line in failed.splitlines() if line.strip()),
    'backups': sorted(p.name for p in pathlib.Path('/home/mmm/backups').iterdir()),
}))
'''

CONNECT = "import socket; s = socket.socket(socket.AF_UNIX); s.connect('%s')" % SOCKET
HOLD = CONNECT + '; import time; time.sleep(60)'  # a client whose page is still being drawn


def require(condition, message):
    if not condition:
        sys.exit(f'STOPPED: {message}')


def sha(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for block in iter(lambda: source.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def step(name):
    print(f'== {name}', flush=True)


def load(path):
    # No bytecode cache: the staged directory must hold only what the manifest lists.
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def members(path, prefixes):
    found = {}
    with tarfile.open(path) as archive:
        for member in archive.getmembers():
            if member.isfile() and member.name.startswith(prefixes):
                found[member.name] = hashlib.sha256(archive.extractfile(member).read()).hexdigest()
    return found


def build(job, commit):
    step('build')
    source = job / 'source.tar.gz'
    with tarfile.open(source) as archive:
        require(archive.pax_headers.get('comment') == commit, f'source.tar.gz is not git archive of {commit}')
        shutil.rmtree(job / 'src', ignore_errors=True)
        (job / 'src').mkdir()
        archive.extractall(job / 'src', filter='data')
    require(sha(__file__) == sha(job / 'src/ops/stage_pdf_service.py'), 'this staging script is not the one in the source archive')
    same = members(source, UNCHANGED)
    require(same and same == members(PREVIOUS_OUT / 'source.tar.gz', UNCHANGED),
            'the PDF processor, the web or the migrations differ from the previous release; this procedure replaces the API binary only')
    shutil.rmtree(job / 'out', ignore_errors=True)
    (job / 'out').mkdir()
    round16 = load(job / 'src/ops/stage_privacy_pdf.py')  # the pinned images, cache and builder of the previous release
    with open(round16.CACHE / 'build.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        api = round16.builder(job, round16.IMAGE, 'gps-pdf-service-api', '/work/gps-tracker-api',
                              'cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked '
                              '&& cargo build --locked --release && cp /cache/target/release/gps-tracker-api /out/gps-tracker-api.next '
                              '&& mv /out/gps-tracker-api.next /out/gps-tracker-api', 'build-api.log',
                              {'CARGO_HOME': '/cache/cargo', 'CARGO_BUILD_JOBS': '8', 'GPS_RELEASE': RELEASE, 'CARGO_TARGET_DIR': '/cache/target'})
    require(RUST in api, f'API unit tests are not "{RUST}"')
    renderer = PREVIOUS_OUT / 'gps-pdf-render'
    require(sha(renderer) == RENDERER, 'the PDF processor of the previous release is not the pinned one')
    (job / 'renderer-selftest.json').write_text(json.dumps({'renderer_sha256': RENDERER, 'kernel': os.uname().release, **round16.selftest(renderer)}, indent=2))
    print(json.dumps({'api_sha256': sha(job / 'out/gps-tracker-api'), 'renderer_sha256': RENDERER, 'processor_web_and_migrations': f"identical to {PREVIOUS['release']} ({len(same)} files)"}), flush=True)


def environment(job, round16):
    class Environment(round16.Environment):
        """The previous release's test environment; the API can also be started with the processor behind a socket."""

        def start_api(self, binary, renderer, through_socket=False):
            self.stop_api()
            for name in ('uploads', 'private'):
                (self.storage / name).mkdir(parents=True, exist_ok=True)
            extra, command = [], ['/api']
            if through_socket:
                # The stand-in listens before the API starts; the API stays process 1 as the suites expect.
                extra = ['-e', f'GPS_PDF_SOCKET={TEST_SOCKET}', '-v', f"{job / 'src/ops/pdf_socket_emulator.py'}:/emulator.py:ro"]
                command = ['sh', '-c', f'python3 /emulator.py {TEST_SOCKET} /gps-pdf-render {TEST_COUNT} & exec /api']
            round16.docker('run', '-d', '--name', round16.API, '--network', round16.NETWORK, '--memory=550m', '--user', f'{os.getuid()}:{os.getgid()}',
                           '--cap-drop=ALL', '--security-opt=no-new-privileges', '-e', 'APP_ENV=test', '-e', 'BIND_ADDR=0.0.0.0:3043',
                           '-e', f'DATABASE_URL={round16.DATABASE_URL}', '-e', f'JWT_SECRET={round16.JWT_SECRET}', '-e', 'SMS_DEV_MODE=1',
                           '-e', f'UPLOAD_DIR={self.storage}/uploads', '-e', f'PRIVATE_UPLOAD_DIR={self.storage}/private', *extra,
                           '-v', f'{self.storage}:{self.storage}', '-v', f'{binary}:/api:ro', '-v', f'{renderer}:/gps-pdf-render:ro', round16.IMAGE, *command)
            if through_socket:
                for _ in range(30):
                    if subprocess.run(['docker', 'exec', round16.API, 'test', '-S', TEST_SOCKET], capture_output=True).returncode == 0:
                        return
                    time.sleep(1)
                require(False, 'the stand-in for the processor service did not start listening')

    return Environment(job)


def test(job, commit):
    step('test')
    round16 = load(job / 'src/ops/stage_privacy_pdf.py')
    round16.scripts(job)
    binary, renderer = job / 'out/gps-tracker-api', job / 'out/gps-pdf-render'
    shutil.copy2(PREVIOUS_OUT / 'gps-pdf-render', renderer)  # the PDF suite looks for it next to the API; it is not shipped
    require(sha(renderer) == RENDERER, 'the PDF processor is not the pinned one')
    sandbox = environment(job, round16)
    sandbox.up()
    try:
        sandbox.start_api(binary, renderer)
        sandbox.wait(RELEASE)
        results = {}
        for script, key, expected in round16.SUITES:
            results[key] = round16.suite(job, job / script)
            require(results[key] == expected, f'{script}: {results[key]} groups, expected {expected}')

        # The same PDF suite again; this time the API starts no processor and sends every page to a socket.
        sandbox.start_api(binary, renderer, through_socket=True)
        sandbox.wait(RELEASE)
        round16.psql('DELETE FROM privacy_result_limits')
        pages = 'SELECT count(*) FROM privacy_receipt_reads WHERE page IS NOT NULL'
        before = int(round16.psql(pages))
        results['pdf_through_socket_groups'] = round16.suite(job, job / 'test_privacy_receipt_pdf.py', label='socket-')
        require(results['pdf_through_socket_groups'] == 7, f"PDF suite through the socket: {results['pdf_through_socket_groups']} groups, expected 7")
        drawn, served = int(round16.psql(pages)) - before, int(round16.docker('exec', round16.API, 'cat', TEST_COUNT))
        require(0 < drawn <= served, f'{drawn} PDF pages were read but the socket served {served} requests')
        results['pdf_requests_through_socket'] = served
        print(f'ok   every PDF page went through the socket ({served} requests, {drawn} read proofs)', flush=True)

        # One-time credentials for the two production smoke runs: hashed by this API, never printed.
        def post(path, body):
            request = urllib.request.Request(sandbox.base() + '/api/v1' + path, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.load(response)

        for name in CREDENTIALS:
            password = secrets.token_urlsafe(24)
            phone = '010' + ''.join(secrets.choice('0123456789') for _ in range(8))
            code = post('/auth/send-otp', {'phone': phone})['dev_code']
            user = post('/auth/register', {'email': f'hash-only-{secrets.token_hex(6)}@example.invalid', 'phone': phone, 'otp_code': code, 'password': password, 'display_name': 'hash only'})
            hashed = round16.psql(f"SELECT password_hash FROM users WHERE id={int(user['user_id'])}")
            require(hashed.startswith('$argon2'), 'could not obtain a password hash')
            private = job / name
            private.touch(mode=0o600)
            private.chmod(0o600)
            private.write_text(json.dumps({'email': f'account-smoke-{secrets.token_hex(6)}@example.invalid', 'password': password, 'password_hash': hashed}))
    finally:
        sandbox.down()
    (job / 'test-results.json').write_text(json.dumps({'api_sha256': sha(binary), 'renderer_sha256': sha(renderer), 'schema': SCHEMA, **results}, indent=2))


def package(job, commit):
    step('package')
    out = job / 'out'
    results = json.loads((job / 'test-results.json').read_text())
    proof = json.loads((job / 'renderer-selftest.json').read_text())
    api = sha(out / 'gps-tracker-api')
    require(results.pop('api_sha256') == api and results.pop('renderer_sha256') == RENDERER, 'suites ran against different binaries')
    require(proof['renderer_sha256'] == RENDERER and proof['sandbox_holds'] and proof['renders_inside_sandbox'], 'self-test record is for another PDF processor')
    require(RUST in (job / 'build-api.log').read_text(), 'build log lacks the unit test result')
    with tarfile.open(job / 'source.tar.gz') as archive:
        require(archive.pax_headers.get('comment') == commit, f'source.tar.gz is not git archive of {commit}')
    migrations = {int(pathlib.PurePosixPath(name).name.split('_')[0]): digest
                  for name, digest in members(job / 'source.tar.gz', ('gps-tracker-api/migrations/',)).items() if name.endswith('.sql')}
    require(set(migrations) == set(range(1, SCHEMA + 1)), 'source does not hold migrations 1..98 exactly')
    (out / 'gps-pdf-render').unlink(missing_ok=True)  # production already has this exact file; it is not replaced
    shutil.copy2(job / 'source.tar.gz', out / 'source.tar.gz')
    for name in OPS:
        shutil.copy2(job / 'src/ops' / name, out / name)
    for name in CREDENTIALS:
        shutil.copy2(job / name, out / name)
        (out / name).chmod(0o600)
    passed, ignored = (int(part.split()[0]) for part in RUST.split('; ')[::2])
    validation = {**results, 'api_sha256': api, 'renderer_sha256': RENDERER, 'rust_passed': passed, 'rust_ignored': ignored,
                  'fmt_clippy_passed': True, 'renderer_selftest_passed': True, 'renderer_selftest_kernel': proof['kernel'],
                  'processor_web_and_migrations_identical_to': PREVIOUS['release']}
    manifest = {'name': NAME, 'release': RELEASE, 'commit': commit, 'schema': SCHEMA, 'previous': PREVIOUS, 'api_sha256': api,
                'renderer_sha256': RENDERER, 'source_sha256': sha(out / 'source.tar.gz'),
                'migrations': {str(version): digest for version, digest in sorted(migrations.items())},
                'ops_files': {name: sha(out / name) for name in OPS}}
    (out / 'validation.json').write_text(json.dumps(validation, indent=2))
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    (out / 'rehearsal.json').unlink(missing_ok=True)


def rehearse(job, commit):
    step('rehearse')
    out, box = job / 'out', job / 'rehearsal'
    # The stage 1 rehearsal host: production's layout with a real systemd, and stage 1's own script to apply it.
    base = load(job / 'src/ops/rehearse_runtime_account.py')
    base.NETWORK, base.DB, base.HOST = 'gps-pdf-service-rehearsal-20261106', 'gps-pdf-service-rehearsal-db-20261106', 'gps-pdf-service-rehearsal-host-20261106'
    base.HOST_OPTIONS = ['--cap-add', 'SYS_PTRACE']  # to look at a running processor from outside, as root can on production
    require(base.BINARIES == {'gps-tracker-api': PREVIOUS['api_sha256'], 'gps-pdf-render': RENDERER}, 'the rehearsal host would not start from what production runs')
    shutil.rmtree(box, ignore_errors=True)
    record = {'passed': False, 'name': NAME, 'release': RELEASE, 'commit': commit, 'api_sha256': sha(out / 'gps-tracker-api'), 'renderer_sha256': RENDERER,
              'release_script_sha256': sha(out / 'release_pdf_service.py'), 'service_script_sha256': sha(out / 'pdf_service.py'),
              'smoke_sha256': sha(out / 'smoke_pdf_service.py'), 'previous': PREVIOUS,
              'host': {'image': 'ubuntu:22.04 with systemd as PID 1', 'kernel': os.uname().release}, 'steps': []}

    def done(name, **detail):
        record['steps'].append({'step': name, **detail})
        print(f'ok   {name}', flush=True)

    def host(*command, expect=0):
        result = subprocess.run(['docker', 'exec', base.HOST, *command], capture_output=True, text=True)
        require(result.returncode == expect, f"{' '.join(command[:5])}: exit {result.returncode}, expected {expect}: {(result.stdout + result.stderr).strip()[-1500:]}")
        lines = result.stdout.strip().splitlines()
        return json.loads(lines[-1]) if lines else {}

    def entry(kind, mode, *args, expect=0):
        if kind == 'smoke':
            # Each run here repeats the same administrator's reads within minutes; production runs
            # from an idle request allowance.
            base.docker('exec', base.DB, 'psql', '-U', 'postgres', '-d', 'gps_rehearsal', '-qc', 'DELETE FROM privacy_result_limits')
        return host('python3', '/root/stage2/entry.py', kind, mode, *args, expect=expect)

    def snapshot():
        return host('python3', '/root/stage2/snapshot.py')

    def differs(now, then):
        # The backup directory keeps a record of every attempt; everything else is compared.
        return {key for key in now if key != 'backups' and now[key] != then[key]}

    def connects(account):
        return base.inside('runuser', '-u', account, '--', 'python3', '-c', CONNECT, check=False)[0] == 0

    def smoke(mode, credential):
        result = entry('smoke', mode, credential)
        through = 'separate service' if mode == 'service' else 'child of the API'
        require(result['processor_reached_through'] == through and result['api_runs_as'] == 'gps-api' and result['synthetic_accounts_closed']
                and result['pdf_pages_rendered'] == [[1, 1414, 707], [2, 1000, 1000]] and (mode != 'service' or result['requests_served_by_the_service'] >= 4), f'smoke: {result}')
        return {'processor_reached_through': through, 'requests_served_by_the_service': result['requests_served_by_the_service'], 'pdf_pages_rendered': result['pdf_pages_rendered']}

    base.up(job, box)
    try:
        extra = box / 'stage2'
        extra.mkdir()
        (extra / 'provision.sh').write_text(PROVISION.replace('__STAGE__', STAGE).replace('__PREVIOUS__', PREVIOUS['release']))
        (extra / 'entry.py').write_text(ENTRY.replace('__STAGE__', STAGE).replace('__HEALTH__', HEALTH))
        (extra / 'snapshot.py').write_text(SNAPSHOT.replace('__HEALTH__', HEALTH))
        base.docker('cp', str(extra), f'{base.HOST}:/root/stage2')
        base.inside('bash', '/root/stage2/provision.sh')
        for path in sorted(out.iterdir()):
            if path.name not in (*CREDENTIALS, 'rehearsal.json'):  # production's one-time credentials are not used here
                base.docker('cp', str(path), f'{base.HOST}:{STAGE}/{path.name}')
        base.inside('python3', '/root/in/bootstrap.py', STAGE, '4')
        base.inside('rm', f'{STAGE}/smoke-private.json')
        record['host']['systemd'] = base.docker('exec', base.HOST, 'systemctl', '--version').splitlines()[0]

        # Stage 1 as it was applied on production, including the directory mode it left there.
        host('python3', '/root/in/entry.py', 'apply')
        base.inside('sh', '-c', 'chmod 700 /etc/systemd/system/gps-*.d')
        start = snapshot()
        require(start['release'] == PREVIOUS['release'] and start['api_sha256'] == PREVIOUS['api_sha256'] and start['renderer_sha256'] == RENDERER
                and start['api_runs_as'] == 'gps-api' and start['api_socket'] is None and start['accounts'] == {'gps-api': True, 'gps-pdf': False}
                and set(start['drop_in_directories'].values()) == {'0o700'} and start['timers_active'] == ['active', 'active'], f'unexpected start: {start}')
        done('start: production as it is today (round 16 release, API and workers as gps-api, the API starts the processor itself)')

        stopped = entry('service', 'check', expect=3)['stopped']
        require('deploy that release first' in stopped and snapshot() == start, f'unexpected refusal: {stopped}')
        done('the processor service is refused while the API is still the previous release')

        report = entry('release', 'check')
        require(report['ready'] and report['changes_made'] is False and report['pdf_processor']['reached_through'] == 'child of the API' and snapshot() == start, 'release check changed something')
        done('release check passes and changes nothing', pdf_processor=report['pdf_processor'])

        stopped = entry('release', 'unhealthy', expect=3)['stopped']
        after = snapshot()
        require(f"returned to {PREVIOUS['release']}" in stopped and not differs(after, start) and len(after['backups']) == len(start['backups']) + 1, f'automatic return: {stopped} / {after}')
        require(entry('release', 'check')['ready'], 'state after the automatic return is not a clean previous release')
        done('new API does not become healthy -> automatic return to the previous binary')

        report = entry('release', 'apply')
        released = snapshot()
        require(report['health']['release'] == RELEASE and report['api_sha256'] == record['api_sha256'] == released['api_sha256']
                and differs(released, start) == {'api_sha256', 'release'}, f'release apply: {differs(released, start)}')
        done('release apply: new API healthy, schema, web and processor file untouched; it still starts the processor itself',
             pdf_processor=report['pdf_processor'], smoke=smoke('child', 'smoke-private-1.json'))

        report = entry('release', 'rollback')
        require(report['release'] == PREVIOUS['release'] and not differs(snapshot(), start) and entry('release', 'check')['ready'], 'release rollback did not restore the previous binary')
        report = entry('release', 'apply')
        released = snapshot()
        require(report['health']['release'] == RELEASE and differs(released, start) == {'api_sha256', 'release'}, 'second release apply failed')
        done('release rollback: previous binary and a clean check; apply again')

        report = entry('service', 'check')
        require(report['ready'] and report['changes_made'] is False and snapshot() == released, 'service check changed something')
        done('service check passes and changes nothing', would_change=report['would_change'])

        before = released
        for mode, phrase, label in (('unproven', 'gps-pdf-render.socket', 'processor cannot be proven in the service environment -> account, units and API put back by themselves'),
                                    ('late', 'after the API was switched', 'last check fails after the API already used the service -> account, units and API put back by themselves')):
            stopped = entry('service', mode, expect=3)['stopped']
            after = snapshot()
            require('everything was put back' in stopped and phrase in stopped, f'unexpected failure handling: {stopped}')
            require(not differs(after, released) and len(after['backups']) == len(before['backups']) + 1, f'automatic return left a different state: {differs(after, released)} / {after}')
            require(entry('service', 'check')['ready'], 'state after the automatic return is not clean')
            before = after
            done(label)

        changed = {'api_socket', 'gps_unit_files', 'accounts', 'account_files', 'run_directory', 'socket_state', 'proof_state'}

        def applied():
            report = entry('service', 'apply')
            now, seen = snapshot(), report['processor_instance']
            require(differs(now, released) == changed, f'service apply changed {differs(now, released)}')
            require(now['api_socket'] == SOCKET and now['accounts'] == {'gps-api': True, 'gps-pdf': True} and now['run_directory']
                    and now['socket_state'] == 'active' == now['proof_state']
                    and set(now['gps_unit_files']) - set(released['gps_unit_files']) == {'gps-pdf-render.socket', 'gps-pdf-render@.service', 'gps-pdf-render-selftest.service',
                                                                                         'gps-tracker-api.service.d/20-pdf-socket.conf', 'multi-user.target.wants/gps-pdf-render.socket'},
                    f'not applied: {now}')
            # One running processor, looked at from outside: its account, its limits, and the only file it can see.
            require(seen['user'] == 'gps-pdf' and seen['no_new_privileges'] and seen['system_call_filter'] and seen['capabilities'] == 0
                    and seen['files_it_can_see'] == [RENDERER_PATH] and seen['network_interfaces'] == ['lo']
                    and seen['memory_max'] == MEMORY_MAX and seen['swap_max'] == '0', f'processor instance: {seen}')
            # Independent of the script's own checks.
            require(base.inside('id', '-Gn', 'gps-pdf')[1] == 'gps-pdf' and base.inside('runuser', '-u', 'gps-pdf', '--', 'sudo', '-n', 'true', check=False)[0] != 0, 'the processor account has a group or sudo')
            require(connects('gps-api') and not any(connects(other) for other in ('mmm', 'gps-pdf', 'nobody')), 'the socket is open to an account other than the API account')
            require(base.inside('systemctl', 'is-enabled', 'gps-pdf-render.socket')[1] == 'enabled', 'the socket is not enabled for the next boot')
            return {'processor_instance': seen, 'self_test_in_service': report['self_test_in_service'], 'account': report['account']}

        detail = applied()
        done('service apply: the processor runs as gps-pdf with no network, no group, its own memory limit and only its own file in view; only the API account can connect',
             **detail, smoke=smoke('service', 'smoke-private-2.json'))

        with_service = snapshot()
        stopped = entry('release', 'rollback', expect=3)['stopped']
        require('pdf_service.py rollback' in stopped and snapshot() == with_service, f'unexpected refusal: {stopped}')
        done('going back to the previous API is refused while the API uses the processor service')

        # A page is being drawn at that very moment: the rollback must end it and still remove the account.
        subprocess.run(['docker', 'exec', '-d', base.HOST, 'runuser', '-u', 'gps-api', '--', 'python3', '-c', HOLD], check=True)
        for _ in range(50):
            if base.inside('pgrep', '-u', 'gps-pdf', '-x', 'gps-pdf-render', check=False)[0] == 0:
                break
            time.sleep(0.1)
        else:
            require(False, 'no processor was started for the held connection')
        report = entry('service', 'rollback')
        after = snapshot()
        require(report['account_removed'] and report['units_removed'] and not differs(after, released), f'service rollback left {differs(after, released)}')
        require(base.inside('pgrep', '-x', 'gps-pdf-render', check=False)[0] != 0, 'a processor outlived the rollback')
        base.inside('pkill', '-u', 'gps-api', '-f', 'time.sleep', check=False)  # the stand-in client of the held connection
        require(entry('service', 'check')['ready'], 'state after the service rollback is not clean')
        done('service rollback while a page is being drawn: that processor is ended; account, units and socket gone, account files as before; the API starts the processor itself again',
             smoke=smoke('child', 'smoke-private-3.json'))

        applied()
        # A reboot: nothing but systemd may bring the API and the processor service back.
        base.docker('restart', base.HOST)
        for _ in range(150):
            if (base.inside('systemctl', 'is-system-running', check=False)[1] in ('running', 'degraded')
                    and base.inside('curl', '-fsS', '-m', '2', HEALTH, check=False)[0] == 0
                    and base.inside('systemctl', 'is-active', 'gps-pdf-render.socket', check=False)[1] == 'active'):
                break
            time.sleep(1)
        else:
            require(False, 'after the restart the API or the processor socket did not come back: '
                    + base.docker('exec', base.HOST, 'journalctl', '-b', '-u', 'gps-pdf-render.socket', '-u', 'gps-pdf-render-selftest.service', '-u', 'gps-tracker-api', '-n', '25', '--no-pager', check=False)[-1500:])
        now = snapshot()
        cycles = base.inside('sh', '-c', 'journalctl -b --no-pager | grep -ci "ordering cycle" || true')[1]
        require(now['api_socket'] == SOCKET and now['socket_state'] == 'active' == now['proof_state'] and now['release'] == RELEASE
                and now['timers_active'] == ['active', 'active'] and now['failed_units'] == with_service['failed_units'] and cycles == '0', f'after the restart: {now} cycles={cycles}')
        done('apply again, then a reboot of the host: API, timers and the processor service come back by themselves, no ordering cycle',
             smoke=smoke('service', 'smoke-private-4.json'))
        record['passed'] = True
    finally:
        base.down()
        shutil.rmtree(box, ignore_errors=True)

    # The production entry points must accept exactly this record and reject one for other files.
    release, service = load(out / 'release_pdf_service.py'), load(out / 'pdf_service.py')
    staged = type('Staged', (), {'stage': out})
    for gate, key in ((release, 'api_sha256'), (release, 'release_script_sha256'), (service, 'service_script_sha256')):
        (out / 'rehearsal.json').write_text(json.dumps({**record, key: '0' * 64}, indent=2))
        try:
            gate.rehearsed(staged)
            require(False, f'a rehearsal record with another {key} was accepted')
        except gate.Stop:
            pass
    (out / 'rehearsal.json').write_text(json.dumps(record, indent=2))
    release.rehearsed(staged)
    service.rehearsed(staged)
    print('ok   production entries accept this rehearsal record only', flush=True)


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
        require(not (out / 'gps-pdf-render').exists(), 'the staged directory still holds the processor file used by the suites; run `package` again')
        print(json.dumps({'stage': str(out), 'files': {p.name: sha(p) for p in sorted(out.iterdir()) if p.name not in CREDENTIALS}}, indent=2))


if __name__ == '__main__':
    main()
