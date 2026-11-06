"""Build-host staging for release privacy-facts-20261106-r1 (round 17). Never touches production.

    python3 stage_privacy_facts.py <job-dir> <commit> [step ...]

<job-dir>/source.tar.gz must be `git archive <commit>` of gps-tracker-api, gps-pdf-render,
gps-tracker-web and ops. Steps (default: all, in this order; each stops on the first failure):

  build     API (fmt, Clippy, unit tests, release build) and web (tests, build) in the pinned image.
            The PDF processor source must be identical to the previous release's; the processor is
            the file production runs, proven again on this kernel
  test      throwaway DB on an internal Docker network: the privacy regressions in their fixed order,
            the new suite last, then the PDF suite again with every page sent to a socket
  package   out/manifest.json, out/validation.json, the ops scripts and a one-time smoke credential
  rehearse  a container with a real systemd brought to production's state of today (runtime account,
            previous API release, PDF processor service) and a grant issued by the previous release;
            then check, three forced failures with automatic return, apply, rollback, apply, the
            production smoke script, and the refusal to go back once the new section is in use;
            then what repairing forward relies on: another build that knows schema 99 replaces
            the API file and serves, the previous binary does not start, the released binary
            is put back -> out/rehearsal.json

`rehearse` alone may be run again on a job whose `src` is a later commit than its `out`: a later
revision of the smoke script is then run from a directory of its own, beside the staged files.

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

RELEASE = 'privacy-facts-20261106-r1'
SCHEMA = 99
PREVIOUS = {
    'release': 'pdf-service-20261106-r1',
    'api_sha256': '0d28667f3c21af82a43b987a12eec2836547d3717c69ae304688c6e5363ce826',
}
# What production runs and holds today: the staged directory of the previous release, and the
# release before it for the web and the processor file.
PREVIOUS_OUT = pathlib.Path('/home/etcom-hub/build/gps-pdf-service-20261106-r1/out')
PROCESSOR_OUT = pathlib.Path('/home/etcom-hub/build/gps-privacy-pdf-20261106-r1/out')
PREVIOUS_WEB_RELEASE = 'privacy-pdf-20261106-r1'
RENDERER = '3eaaf5535c01c58e1c4f3eae5e3a4799c59b916233960897581d5ee7707d4ffb'
UNCHANGED = ('gps-pdf-render/',)  # this release replaces the API and the web only
FACTS_SUITE = ('test_privacy_location_facts.py', 'facts_groups', 6)
RUST = '64 passed; 0 failed; 2 ignored'
WEB_TESTS = 225
OPS = ['release_privacy_facts.py', 'smoke_privacy_facts.py']
CREDENTIAL = 'smoke-private.json'
STAGE = f'/home/mmm/gps-artifacts/{RELEASE}'
HEALTH = 'http://127.0.0.1:3040/gps-tracker/health'
SOCKET = '/run/gps-pdf-render/render.sock'
SMOKE = 'smoke_privacy_facts.py'
SMOKE_STAGE = f'{STAGE}-smoke'  # where a smoke revision later than the staged one is placed and run
# A different build of this source, standing in for a corrected build: it knows schema 99 and names another release.
OTHER_BUILD = (pathlib.Path('/home/etcom-hub/build/gps-privacy-facts-20261106/out/gps-tracker-api'), 'privacy-facts-20261106-dev')

PROVISION = r'''#!/bin/bash
# The staged directory of this release, as the deployment account would create it.
set -euo pipefail
install -d -o mmm -g mmm -m 755 __STAGE__
'''

ENTRY = r'''"""Runs the staged scripts on the rehearsal host. Only addresses, neighbours and forced failures differ."""
import base64, hashlib, hmac, importlib.util, json, pathlib, secrets, sys, time, urllib.error, urllib.request, uuid
from datetime import datetime, timedelta, timezone
sys.dont_write_bytecode = True
STAGE, HEALTH, API = '__STAGE__', '__HEALTH__', 'http://127.0.0.1:3040/gps-tracker/api/v1'
def load(name, directory=STAGE):
    spec = importlib.util.spec_from_file_location(name, f'{directory}/{name}.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
def call(method, path, body=None, token=None):
    headers = {'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})}
    request = urllib.request.Request(API + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers=headers)
    try: response = urllib.request.urlopen(request, timeout=30)
    except urllib.error.HTTPError as error: response = error
    with response:
        raw = response.read()
        return response.status, json.loads(raw) if 'application/json' in response.headers.get('content-type', '') else raw
kind, mode = sys.argv[1], sys.argv[2]
seed = pathlib.Path(STAGE, 'seed-private.json')
if kind == 'grant':
    if mode == 'issue':
        # An account, an access request and a grant with a section of the previous release, made through that release.
        import psycopg2
        env = dict(line.split('=', 1) for line in pathlib.Path('/home/mmm/projects/gps-tracker-api/.env').read_text().splitlines() if '=' in line)
        db = psycopg2.connect(env['DATABASE_URL']); db.autocommit = True
        with db.cursor() as q:
            q.execute("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1"); admin = q.fetchone()[0]
        b64 = lambda value: base64.urlsafe_b64encode(value).decode().rstrip('=')
        now = int(time.time())
        message = b64(b'{"alg":"HS256","typ":"JWT"}') + '.' + b64(json.dumps({'sub': str(admin), 'iat': now, 'exp': now + 600, 'typ': 'access'}, separators=(',', ':')).encode())
        at = message + '.' + b64(hmac.new(env['JWT_SECRET'].encode(), message.encode(), hashlib.sha256).digest())
        password, phone = secrets.token_urlsafe(24), '010' + ''.join(secrets.choice('0123456789') for _ in range(8))
        email = f'earlier-grant-{secrets.token_hex(6)}@example.invalid'
        code = call('POST', '/auth/send-otp', {'phone': phone})[1]['dev_code']
        status, user = call('POST', '/auth/register', {'email': email, 'phone': phone, 'otp_code': code, 'password': password, 'display_name': 'earlier grant'}); assert status == 200, user
        status, r = call('POST', '/privacy/requests', {'request_key': str(uuid.uuid4()), 'kind': 'access', 'scope': 'A grant issued by the previous release', 'password': password}, user['access_token']); assert status == 202, r
        status, r = call('PATCH', f"/admin/privacy/requests/{r['id']}", {'revision': r['revision'], 'status': 'in_review', 'message': 'Review fixture', 'evidence_reference': 'fixture', 'due_at': (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()}, at); assert status == 200, r
        status, package = call('POST', f"/admin/privacy/requests/{r['id']}/account-packages", {'revision': r['revision'], 'confirmed': True, 'documents': [], 'sections': ['transactions']}, at); assert status == 200, package
        seed.touch(mode=0o600); seed.write_text(json.dumps({'email': email, 'password': password, 'package': package['id']}))
        print(json.dumps({'grant': package['id'], 'sections': package['sections'], 'keys': sorted(package)}))
    else:
        # The same grant, downloaded by its subject through whatever release runs now.
        saved = json.loads(seed.read_text())
        status, login = call('POST', '/auth/login', {'email': saved['email'], 'password': saved['password']}); assert status == 200, login
        status, data = call('POST', f"/privacy/account-packages/{saved['package']}/account", {'password': saved['password']}, login['access_token'])
        print(json.dumps({'status': status, 'format': data.get('format') if isinstance(data, dict) else None,
                          'sections': sorted(data.get('additional', {})) if isinstance(data, dict) else None,
                          'unselected': data.get('unselected_sections') if isinstance(data, dict) else None}))
    sys.exit(0)
if kind == 'smoke':
    smoke = load('smoke_privacy_facts', sys.argv[4])
    class Smoke(smoke.Site):
        environment = 'test'
        health_url, api_url, private = HEALTH, API, sys.argv[3]
    print(json.dumps(smoke.main(Smoke)))
    sys.exit(0)
module = load('release_privacy_facts')
class Rehearsal(module.Site):
    environment = 'test'
    def health(self):
        with urllib.request.urlopen(HEALTH, timeout=5) as response:
            return json.load(response)
    def served(self, path):
        # No web server here: what the link points at is what would be served.
        return (self.web.resolve() / ('index.html' if path == '/profile' else path.lstrip('/'))).read_bytes()
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
elif mode == 'late':
    # The new API is healthy, but the PDF processor service is then found outside its verified state.
    verified, calls = module.processor, []
    def failing(site):
        calls.append(1)
        if len(calls) == 2:
            raise module.Stop('forced failure: the PDF processor service is not in its verified state after the restart')
        return verified(site)
    module.processor = failing
    mode = 'apply'
try:
    print(json.dumps(getattr(module, mode)(Rehearsal()), default=str))
except module.Stop as stop:
    print(json.dumps({'stopped': str(stop)}))
    sys.exit(3)
'''

REPAIR = r'''"""Replace the API file as the release scripts do (copy beside it, rename over it) and restart.
Schema, web and everything else stay. Usage: repair.py <binary> <release it must report> <seconds to wait>"""
import hashlib, json, os, pathlib, shutil, subprocess, sys, time, urllib.request
API = pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
source, release, seconds = sys.argv[1], sys.argv[2], int(sys.argv[3])
started = time.strftime('%Y-%m-%d %H:%M:%S')
info, staged = API.stat(), API.with_name(API.name + '.repair')
shutil.copyfile(source, staged); os.chown(staged, info.st_uid, info.st_gid); staged.chmod(info.st_mode & 0o7777); os.replace(staged, API)
subprocess.run(['systemctl', 'reset-failed', 'gps-tracker-api'], capture_output=True)
subprocess.run(['systemctl', 'restart', 'gps-tracker-api'], capture_output=True)
healthy, last = False, None
for _ in range(seconds):
    try:
        with urllib.request.urlopen('__HEALTH__', timeout=3) as response:
            last = json.load(response)
        if last.get('ok') and last.get('db') and last.get('release') == release:
            healthy = True
            break
    except Exception as error:  # not listening
        last = repr(error)
    time.sleep(1)
log = subprocess.run(['journalctl', '-u', 'gps-tracker-api', '--since', started, '--no-pager', '-o', 'cat'], capture_output=True, text=True).stdout
print(json.dumps({'healthy': healthy, 'last': last, 'api_sha256': hashlib.sha256(API.read_bytes()).hexdigest(),
                  'migration_lines': [line.strip()[:300] for line in log.splitlines() if 'migration' in line.lower()][-2:]}))
'''

SNAPSHOT = r'''"""What the release may touch, and what it must leave alone."""
import grp, hashlib, json, os, pathlib, pwd, subprocess, urllib.request
import psycopg2
def sha(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
def owner(path):
    info = os.lstat(path)
    return [pwd.getpwuid(info.st_uid).pw_name, grp.getgrgid(info.st_gid).gr_name, oct(info.st_mode & 0o7777)]
def show(unit, *names):
    out = subprocess.run(['systemctl', 'show', unit, *[f'-p{n}' for n in names]], capture_output=True, text=True).stdout
    return dict(line.split('=', 1) for line in out.splitlines() if '=' in line)
api, units = '/home/mmm/projects/gps-tracker-api', pathlib.Path('/etc/systemd/system')
pid = show('gps-tracker-api.service', 'MainPID')['MainPID']
environ = dict(i.split('=', 1) for i in pathlib.Path(f'/proc/{pid}/environ').read_bytes().decode(errors='replace').split('\0') if '=' in i)
with urllib.request.urlopen('__HEALTH__', timeout=5) as response:
    health = json.load(response)
env = dict(line.split('=', 1) for line in pathlib.Path(f'{api}/.env').read_text().splitlines() if '=' in line)
db = psycopg2.connect(env['DATABASE_URL']); db.set_session(readonly=True, autocommit=True)
def one(query):
    with db.cursor() as q:
        q.execute(query); return q.fetchone()[0]
failed = subprocess.run(['systemctl', 'list-units', '--failed', '--no-legend', '--plain'], capture_output=True, text=True).stdout
print(json.dumps({
    'release': health.get('release'), 'api_sha256': sha(f'{api}/bin/gps-tracker-api'), 'renderer_sha256': sha(f'{api}/bin/gps-pdf-render'),
    'web': os.path.realpath('/home/mmm/gps-tracker-web/dist-root'),
    'schema': one('SELECT max(version) FROM _sqlx_migrations'),
    'columns': one("SELECT COALESCE(array_agg(column_name::text ORDER BY 1),'{}') FROM information_schema.columns WHERE table_name='privacy_account_packages' AND column_name LIKE 'facts%'"),
    'rules': one("SELECT COALESCE(jsonb_object_agg(conname,pg_get_constraintdef(oid)),'{}') FROM pg_constraint WHERE conrelid='privacy_account_packages'::regclass AND contype='c' AND conname LIKE 'privacy_account_%'"),
    'grants': one('SELECT count(*) FROM privacy_account_packages'),
    'grants_with_the_section': one("SELECT count(*) FROM privacy_account_packages WHERE sections @> ARRAY['location_facts']::text[]"),
    'api_runs_as': show('gps-tracker-api.service', 'User')['User'], 'api_socket': environ.get('GPS_PDF_SOCKET'),
    'processor': {'socket': show('gps-pdf-render.socket', 'ActiveState', 'UnitFileState', 'ActiveEnterTimestamp'),
                  'proof': show('gps-pdf-render-selftest.service', 'ActiveState', 'Result', 'ActiveEnterTimestamp')},
    'gps_unit_files': sorted(str(p.relative_to(units)) for p in units.rglob('*') if 'gps' in str(p.relative_to(units)) and not p.is_dir()),
    'files': {p: owner(p) for p in (f'{api}/.env', f'{api}/bin/gps-tracker-api', f'{api}/bin/gps-pdf-render')},
    'env_sha256': sha(f'{api}/.env'),
    'bin': sorted(p.name for p in pathlib.Path(f'{api}/bin').iterdir()),
    'web_directory': sorted(p.name for p in pathlib.Path('/home/mmm/gps-tracker-web').iterdir()),
    'neighbor_pids': {u: show(u, 'MainPID')['MainPID'] for u in ('gps-tracker.service', 'pm2-mmm.service')},
    'timers_active': [show(t, 'ActiveState')['ActiveState'] for t in ('gps-privacy-accounts.timer', 'gps-privacy-files.timer')],
    'failed_units': sorted(line.split()[0] for line in failed.splitlines() if line.strip()),
    'releases': sorted(p.name for p in pathlib.Path('/home/mmm/releases').iterdir()),
    'backups': sorted(p.name for p in pathlib.Path('/home/mmm/backups').iterdir()),
}))
'''


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
    require(sha(__file__) == sha(job / 'src/ops/stage_privacy_facts.py'), 'this staging script is not the one in the source archive')
    same = members(source, UNCHANGED)
    require(same and same == members(PREVIOUS_OUT / 'source.tar.gz', UNCHANGED), 'the PDF processor source differs from the previous release; this procedure does not replace the processor')
    shutil.rmtree(job / 'out', ignore_errors=True)
    (job / 'out').mkdir()
    round16 = load(job / 'src/ops/stage_privacy_pdf.py')  # the pinned images, cache and builder
    with open(round16.CACHE / 'build.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        api = round16.builder(job, round16.IMAGE, 'gps-privacy-facts-api', '/work/gps-tracker-api',
                              'cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked '
                              '&& cargo build --locked --release && cp /cache/target/release/gps-tracker-api /out/gps-tracker-api.next '
                              '&& mv /out/gps-tracker-api.next /out/gps-tracker-api', 'build-api.log',
                              {'CARGO_HOME': '/cache/cargo', 'CARGO_BUILD_JOBS': '8', 'GPS_RELEASE': RELEASE, 'CARGO_TARGET_DIR': '/cache/target'})
        web = round16.builder(job, round16.IMAGE, 'gps-privacy-facts-web', '/work/gps-tracker-web',
                              'npm ci --ignore-scripts && npm test && npm run build && tar -czf /out/web.tar.gz -C dist .',
                              'build-web.log', {'VITE_BASE': '/', 'npm_config_cache': '/cache/npm'})
    require(RUST in api, f'API unit tests are not "{RUST}"')
    require(f'# pass {WEB_TESTS}' in web and '# fail 0' in web, f'web tests are not {WEB_TESTS} passed, 0 failed')
    renderer = PROCESSOR_OUT / 'gps-pdf-render'
    require(sha(renderer) == RENDERER, 'the installed PDF processor is not the pinned one')
    (job / 'renderer-selftest.json').write_text(json.dumps({'renderer_sha256': RENDERER, 'kernel': os.uname().release, **round16.selftest(renderer)}, indent=2))
    print(json.dumps({'api_sha256': sha(job / 'out/gps-tracker-api'), 'web_sha256': sha(job / 'out/web.tar.gz'), 'renderer_sha256': RENDERER,
                      'processor_source': f"identical to {PREVIOUS['release']} ({len(same)} files)"}), flush=True)


def test(job, commit):
    step('test')
    round16, service = load(job / 'src/ops/stage_privacy_pdf.py'), load(job / 'src/ops/stage_pdf_service.py')
    round16.scripts(job)
    binary, renderer = job / 'out/gps-tracker-api', job / 'out/gps-pdf-render'
    shutil.copy2(PROCESSOR_OUT / 'gps-pdf-render', renderer)  # the PDF suite looks for it next to the API; it is not shipped
    require(sha(renderer) == RENDERER, 'the PDF processor is not the pinned one')
    sandbox = service.environment(job, round16)
    sandbox.up()
    try:
        sandbox.start_api(binary, renderer)
        sandbox.wait(RELEASE)
        results = {}
        # The fixed order of the earlier releases, the new suite last: some suites assert totals
        # that only hold in this order on a fresh database.
        for script, key, expected in [*round16.SUITES, FACTS_SUITE]:
            results[key] = round16.suite(job, job / script)
            require(results[key] == expected, f'{script}: {results[key]} groups, expected {expected}')

        # The PDF suite again; this time the API starts no processor and sends every page to a socket,
        # as it does on production.
        sandbox.start_api(binary, renderer, through_socket=True)
        sandbox.wait(RELEASE)
        round16.psql('DELETE FROM privacy_result_limits')
        pages = 'SELECT count(*) FROM privacy_receipt_reads WHERE page IS NOT NULL'
        before = int(round16.psql(pages))
        results['pdf_through_socket_groups'] = round16.suite(job, job / 'test_privacy_receipt_pdf.py', label='socket-')
        require(results['pdf_through_socket_groups'] == 7, f"PDF suite through the socket: {results['pdf_through_socket_groups']} groups, expected 7")
        drawn, served = int(round16.psql(pages)) - before, int(round16.docker('exec', round16.API, 'cat', service.TEST_COUNT))
        require(0 < drawn <= served, f'{drawn} PDF pages were read but the socket served {served} requests')
        results['pdf_requests_through_socket'] = served
        print(f'ok   every PDF page went through the socket ({served} requests, {drawn} read proofs)', flush=True)

        # One-time credential for the production smoke: hashed by this API, never printed.
        def post(path, body):
            request = urllib.request.Request(sandbox.base() + '/api/v1' + path, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.load(response)

        password = secrets.token_urlsafe(24)
        phone = '010' + ''.join(secrets.choice('0123456789') for _ in range(8))
        code = post('/auth/send-otp', {'phone': phone})['dev_code']
        user = post('/auth/register', {'email': f'hash-only-{secrets.token_hex(6)}@example.invalid', 'phone': phone, 'otp_code': code, 'password': password, 'display_name': 'hash only'})
        hashed = round16.psql(f"SELECT password_hash FROM users WHERE id={int(user['user_id'])}")
        require(hashed.startswith('$argon2'), 'could not obtain a password hash')
        private = job / CREDENTIAL
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
    require(RUST in (job / 'build-api.log').read_text() and f'# pass {WEB_TESTS}' in (job / 'build-web.log').read_text(), 'build logs lack the test results')
    with tarfile.open(job / 'source.tar.gz') as archive:
        require(archive.pax_headers.get('comment') == commit, f'source.tar.gz is not git archive of {commit}')
    migrations = {int(pathlib.PurePosixPath(name).name.split('_')[0]): digest
                  for name, digest in members(job / 'source.tar.gz', ('gps-tracker-api/migrations/',)).items() if name.endswith('.sql')}
    require(set(migrations) == set(range(1, SCHEMA + 1)), 'source does not hold migrations 1..99 exactly')
    (out / 'gps-pdf-render').unlink(missing_ok=True)  # production already has this exact file; it is not replaced
    shutil.copy2(job / 'source.tar.gz', out / 'source.tar.gz')
    for name in OPS:
        shutil.copy2(job / 'src/ops' / name, out / name)
    shutil.copy2(job / CREDENTIAL, out / CREDENTIAL)
    (out / CREDENTIAL).chmod(0o600)
    passed, ignored = (int(part.split()[0]) for part in RUST.split('; ')[::2])
    validation = {**results, 'api_sha256': api, 'renderer_sha256': RENDERER, 'rust_passed': passed, 'rust_ignored': ignored,
                  'fmt_clippy_passed': True, 'web_tests_passed': WEB_TESTS, 'web_build_passed': True,
                  'renderer_selftest_passed': True, 'renderer_selftest_kernel': proof['kernel'],
                  'processor_source_identical_to': PREVIOUS['release']}
    manifest = {'release': RELEASE, 'commit': commit, 'schema': SCHEMA, 'previous': PREVIOUS, 'api_sha256': api,
                'renderer_sha256': RENDERER, 'web_sha256': sha(out / 'web.tar.gz'), 'source_sha256': sha(out / 'source.tar.gz'),
                'migrations': {str(version): digest for version, digest in sorted(migrations.items())},
                'ops_files': {name: sha(out / name) for name in OPS}}
    (out / 'validation.json').write_text(json.dumps(validation, indent=2))
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    (out / 'rehearsal.json').unlink(missing_ok=True)


def rehearse(job, commit):
    step('rehearse')
    out, box = job / 'out', job / 'rehearsal'
    # The rehearsal hosts of the two infrastructure stages bring a real systemd to production's state of today.
    base, service = load(job / 'src/ops/rehearse_runtime_account.py'), load(job / 'src/ops/stage_pdf_service.py')
    base.NETWORK, base.DB, base.HOST = 'gps-privacy-facts-rehearsal-20261106', 'gps-privacy-facts-rehearsal-db-20261106', 'gps-privacy-facts-rehearsal-host-20261106'
    base.HOST_OPTIONS = ['--cap-add', 'SYS_PTRACE']  # the processor service's own verification looks at a running processor
    require(sha(PREVIOUS_OUT / 'gps-tracker-api') == PREVIOUS['api_sha256'], 'the previous release on this host is not what production runs')
    require(service.PREVIOUS['release'] == PREVIOUS_WEB_RELEASE and service.RELEASE == PREVIOUS['release'], 'the earlier staging script describes another production state')
    shutil.rmtree(box, ignore_errors=True)
    # The smoke of this source. When it is a later revision than the staged one, it runs from its own directory.
    smoke, later = job / 'src/ops' / SMOKE, sha(job / 'src/ops' / SMOKE) != sha(out / SMOKE)
    smoke_dir = SMOKE_STAGE if later else STAGE
    other, other_release = OTHER_BUILD
    require(other.is_file() and sha(other) not in (sha(out / 'gps-tracker-api'), PREVIOUS['api_sha256']), 'the stand-in for a corrected build is missing or is one of the two releases')
    record = {'passed': False, 'release': RELEASE, 'commit': commit, 'api_sha256': sha(out / 'gps-tracker-api'), 'web_sha256': sha(out / 'web.tar.gz'),
              'release_script_sha256': sha(out / 'release_privacy_facts.py'), 'smoke_sha256': sha(smoke), 'staged_smoke_sha256': sha(out / SMOKE),
              'smoke_run_from': smoke_dir, 'other_build': {'sha256': sha(other), 'release': other_release},
              'previous': PREVIOUS, 'host': {'image': 'ubuntu:22.04 with systemd as PID 1', 'kernel': os.uname().release}, 'steps': []}

    def done(name, **detail):
        record['steps'].append({'step': name, **detail})
        print(f'ok   {name}', flush=True)

    def host(*command, expect=0):
        result = subprocess.run(['docker', 'exec', base.HOST, *command], capture_output=True, text=True)
        require(result.returncode == expect, f"{' '.join(command[:5])}: exit {result.returncode}, expected {expect}: {(result.stdout + result.stderr).strip()[-1500:]}")
        lines = result.stdout.strip().splitlines()
        return json.loads(lines[-1]) if lines else {}

    def psql(query):
        return base.docker('exec', base.DB, 'psql', '-U', 'postgres', '-d', 'gps_rehearsal', '-Atqc', query)

    def entry(kind, mode, *args, expect=0):
        # Each run here repeats reads within minutes; production runs from an idle request allowance.
        psql('DELETE FROM privacy_result_limits')
        return host('python3', '/root/stage3/entry.py', kind, mode, *args, expect=expect)

    def snapshot():
        return host('python3', '/root/stage3/snapshot.py')

    def differs(now, then):
        # Set-aside directories of earlier attempts are kept for review; everything else is compared.
        return {key for key in now if key not in ('backups', 'releases') and now[key] != then[key]}

    def kept(now, then):
        return (len(now['backups']) - len(then['backups']), len(now['releases']) - len(then['releases']))

    base.up(job, box)
    try:
        # Production of today: stage 1 (runtime account), the previous API release, stage 2 (processor service).
        for name, files in (('stage2', {'provision.sh': service.PROVISION.replace('__STAGE__', service.STAGE).replace('__PREVIOUS__', PREVIOUS_WEB_RELEASE),
                                         'entry.py': service.ENTRY.replace('__STAGE__', service.STAGE).replace('__HEALTH__', HEALTH)}),
                            ('stage3', {'provision.sh': PROVISION.replace('__STAGE__', STAGE), 'entry.py': ENTRY.replace('__STAGE__', STAGE).replace('__HEALTH__', HEALTH),
                                        'snapshot.py': SNAPSHOT.replace('__HEALTH__', HEALTH), 'repair.py': REPAIR.replace('__HEALTH__', HEALTH)})):
            (box / name).mkdir()
            for filename, text in files.items():
                (box / name / filename).write_text(text)
            base.docker('cp', str(box / name), f'{base.HOST}:/root/{name}')
            base.inside('bash', f'/root/{name}/provision.sh')
        for source, target, skip in ((PREVIOUS_OUT, service.STAGE, (*service.CREDENTIALS, 'rehearsal.json')), (out, STAGE, (CREDENTIAL, 'rehearsal.json'))):
            for path in sorted(source.iterdir()):
                if path.name not in skip:  # production's one-time credentials are not used here
                    base.docker('cp', str(path), f'{base.HOST}:{target}/{path.name}')
        base.inside('python3', '/root/in/bootstrap.py', STAGE, '2')
        base.inside('rm', f'{STAGE}/smoke-private.json')
        if later:
            base.inside('install', '-d', '-o', 'mmm', '-g', 'mmm', '-m', '755', SMOKE_STAGE)
            base.docker('cp', str(smoke), f'{base.HOST}:{SMOKE_STAGE}/{SMOKE}')
        base.docker('cp', str(other), f'{base.HOST}:/root/stage3/api.other-build')
        record['host']['systemd'] = base.docker('exec', base.HOST, 'systemctl', '--version').splitlines()[0]
        host('python3', '/root/in/entry.py', 'apply')
        base.inside('sh', '-c', 'chmod 700 /etc/systemd/system/gps-*.d')
        host('python3', '/root/stage2/entry.py', 'release', 'apply')
        host('python3', '/root/stage2/entry.py', 'service', 'apply')
        issued = entry('grant', 'issue')
        require(issued['sections'] == ['transactions'] and 'facts_from' not in issued['keys'], f'grant of the previous release: {issued}')
        start = snapshot()
        require(start['release'] == PREVIOUS['release'] and start['api_sha256'] == PREVIOUS['api_sha256'] and start['renderer_sha256'] == RENDERER and start['schema'] == SCHEMA - 1
                and start['columns'] == [] and 'location_facts' not in json.dumps(start['rules']) and start['api_runs_as'] == 'gps-api' and start['api_socket'] == SOCKET
                and start['processor']['socket']['ActiveState'] == 'active' and start['processor']['proof']['Result'] == 'success'
                and start['web'] == f'/home/mmm/releases/{PREVIOUS_WEB_RELEASE}/web' and start['grants'] == 1 and start['timers_active'] == ['active', 'active'], f'unexpected start: {start}')
        done('start: production as it is today (previous API release on schema 98, API as gps-api, PDF processor as its own service) with a grant issued by that release')

        report = entry('release', 'check')
        require(report['ready'] and report['changes_made'] is False and report['existing_grants'] == 1 and snapshot() == start, 'check changed something')
        done('check passes and changes nothing', found=report['found'])

        # A write to the grants that stays open: the migration cannot take its lock in time.
        base.docker('exec', '-d', base.DB, 'psql', '-U', 'postgres', '-d', 'gps_rehearsal', '-c',
                    'BEGIN; LOCK TABLE privacy_account_packages IN ROW EXCLUSIVE MODE; SELECT pg_sleep(25); COMMIT;')
        time.sleep(2)
        stopped = entry('release', 'apply', expect=3)['stopped']
        after = snapshot()
        require('nothing was changed' in stopped and not differs(after, start) and kept(after, start) == (1, 1), f'blocked migration: {stopped} / {differs(after, start)}')
        for _ in range(40):
            if psql("SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(25)%' AND pid<>pg_backend_pid()") == '0':
                break
            time.sleep(1)
        require(entry('release', 'check')['ready'], 'state after the refused migration is not a clean previous release')
        done('the migration cannot take its lock -> nothing is changed, the attempt is set aside')

        for mode, phrase, label in (('unhealthy', 'did not become healthy', 'new API does not become healthy -> automatic return: previous binary, schema 98, web link as before'),
                                    ('late', 'forced failure', 'new API healthy but the processor service fails its check -> automatic return')):
            before = after
            stopped = entry('release', mode, expect=3)['stopped']
            after = snapshot()
            require(f"returned to {PREVIOUS['release']}" in stopped and phrase in stopped and not differs(after, start) and kept(after, before) == (1, 1), f'{mode}: {stopped} / {differs(after, start)}')
            require(entry('release', 'check')['ready'], 'state after the automatic return is not a clean previous release')
            done(label)

        changed = {'release', 'api_sha256', 'web', 'schema', 'columns', 'rules'}

        def applied():
            report = entry('release', 'apply')
            now = snapshot()
            require(differs(now, start) == changed, f'apply changed {differs(now, start)}')
            require(now['release'] == RELEASE and now['schema'] == SCHEMA and now['api_sha256'] == record['api_sha256'] == report['api_sha256']
                    and now['columns'] == ['facts_from', 'facts_until'] and 'location_facts' in now['rules']['privacy_account_sections_valid'] and 'privacy_account_facts_period' in now['rules']
                    and now['web'] == f'/home/mmm/releases/{RELEASE}/web' and report['existing_grants_kept'] == 1 and now['grants'] == 1, f'not applied: {now}')
            # The grant of the previous release is still what it was, through the new release.
            earlier = entry('grant', 'download')
            require(earlier == {'status': 200, 'format': 'gps-personal-account-v2', 'sections': ['transactions'],
                                'unselected': ['contact_settings', 'activity_metadata', 'location_facts']}, f'earlier grant: {earlier}')
            return report

        report = applied()
        done('apply: schema 99, new API healthy, web switched; the processor service was not touched or restarted; the earlier grant still downloads',
             health=report['health'], pdf_processor_service=report['pdf_processor_service'])

        report = entry('release', 'rollback')
        after = snapshot()
        require(report['release'] == PREVIOUS['release'] and report['schema'] == SCHEMA - 1 and not differs(after, start), f'rollback left {differs(after, start)}')
        earlier = entry('grant', 'download')
        require(earlier['status'] == 200 and earlier['unselected'] == ['contact_settings', 'activity_metadata'], f'earlier grant after rollback: {earlier}')
        require(entry('release', 'check')['ready'], 'state after rollback is not a clean previous release')
        done('rollback: previous binary and web, schema 98 with both rules as before; the earlier grant still downloads; check passes again')

        applied()
        result = entry('smoke', 'run', 'smoke-private-1.json', smoke_dir)
        require(result['release'] == RELEASE and result['schema'] == SCHEMA and result['synthetic_accounts_closed'] and result['file_structure_as_released']
                and result['daily_summary_seconds_for_busiest_accounts'] == [] and result['expired_grant_refused_then_times_restored']
                and result['no_token_refused'] and result['file_holds_only_the_subjects_own_account_request_and_link']
                and result['earlier_grants'] == 1 and result['earlier_grants_listed_and_rows_unchanged'] and result['earlier_grants_downloadable_now'] == 1, f'smoke: {result}')
        used = snapshot()
        require(used['grants_with_the_section'] == 1 and used['grants'] == 3, f'after the smoke: {used}')
        require(psql("SELECT count(*) FROM privacy_account_packages WHERE expires_at<>created_at+interval '24 hours'") == '0', 'a grant was left with moved times')
        require(entry('grant', 'download')['status'] == 200, 'the earlier grant no longer downloads after the smoke')
        done('apply again; the production smoke script completes against the rehearsal host' + (' (later revision, run from its own directory)' if later else ''),
             smoke={key: result[key] for key in ('no_token_refused', 'other_account_refused', 'file_holds_only_the_subjects_own_account_request_and_link',
                                                 'expired_grant_refused_then_times_restored', 'earlier_grants', 'earlier_grants_listed_and_rows_unchanged',
                                                 'earlier_grants_downloadable_now', 'revoked_grant_refused', 'synthetic_accounts_closed')})

        stopped = entry('release', 'rollback', expect=3)['stopped']
        require('repair forward' in stopped and snapshot() == used, f'unexpected rollback refusal: {stopped}')
        done('going back is refused once a grant uses the new section')

        # What repairing forward relies on. Schema 99 and the grants stay; only the API file changes.
        swapped = host('python3', '/root/stage3/repair.py', '/root/stage3/api.other-build', other_release, '45')
        now = snapshot()
        require(swapped['healthy'] and swapped['api_sha256'] == record['other_build']['sha256'] and differs(now, used) == {'release', 'api_sha256'}
                and now['release'] == other_release and now['schema'] == SCHEMA and now['grants'] == 3 and now['grants_with_the_section'] == 1, f'another build on schema 99: {swapped} / {differs(now, used)}')
        require(entry('grant', 'download')['status'] == 200, 'the earlier grant does not download through the other build')
        done('repair forward: another build that knows schema 99 replaces the API file and serves; schema, grants, web and the processor service stay')

        refused = host('python3', '/root/stage3/repair.py', f'{service.STAGE}/gps-tracker-api', PREVIOUS['release'], '15')
        require(not refused['healthy'] and refused['api_sha256'] == PREVIOUS['api_sha256'] and refused['migration_lines'], f'previous binary on schema 99: {refused}')
        done('the previous binary does not start on schema 99: going back by the binary alone is not an option', log=refused['migration_lines'])

        back = host('python3', '/root/stage3/repair.py', f'{STAGE}/gps-tracker-api', RELEASE, '45')
        now = snapshot()
        require(back['healthy'] and back['api_sha256'] == record['api_sha256'] and now == used, f'released binary put back: {back} / {differs(now, used)}')
        require(entry('grant', 'download')['status'] == 200, 'the earlier grant does not download after the released binary is put back')
        done('the released binary is put back and serves again; everything else is as it was after the smoke')
        record['passed'] = True
    finally:
        base.down()
        shutil.rmtree(box, ignore_errors=True)

    # The production entry point must accept exactly this record and reject one for other files.
    gate = load(out / 'release_privacy_facts.py')
    staged = type('Staged', (), {'stage': out})
    for key in ('api_sha256', 'web_sha256', 'release_script_sha256'):
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
        require(not (out / 'gps-pdf-render').exists(), 'the staged directory still holds the processor file used by the suites; run `package` again')
        print(json.dumps({'stage': str(out), 'files': {p.name: sha(p) for p in sorted(out.iterdir()) if p.name != CREDENTIAL}}, indent=2))


if __name__ == '__main__':
    main()
