"""GPS release privacy-pdf-20261106-r1 (round 16): schema 97 -> 98, the PDF processor, API and web.

Run as root on the GPS production host, from the staged artifact directory:

    python3 release_privacy_pdf.py check      # read-only preflight; changes nothing
    python3 release_privacy_pdf.py apply      # preflight, migrate, install, swap API and web, verify
    python3 release_privacy_pdf.py rollback   # back to the previous release (see below)

Pinned to one transition. The running release must be privacy-raster-20261106-r1 with
migrations 1..97 exactly as built; anything else stops before the first change.

This release adds a second program, gps-pdf-render, next to the API binary. The API starts it
once per PDF page and it confines itself before it reads input. `check` runs its self-test on
this kernel as the account the API runs as, and stops when the API service would add
confinement of its own that such a run cannot see.

Migration 0098 adds two nullable columns and lets privacy_receipt_in_scope match PDF receipts.
The API refuses to start when the database holds a migration its binary does not know. Going
back therefore removes 0098 (both columns, the function as it was, the SQLx row), the processor
and the binary, and is allowed only while no row uses the new columns. After that, repair
forward. `apply` goes back by itself when the new API or the installed processor does not work.
"""
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request

import psycopg2

RELEASE = 'privacy-pdf-20261106-r1'
SCHEMA = 98
PREVIOUS = {
    'release': 'privacy-raster-20261106-r1',
    'api_sha256': '9acd61b3e21a6c188fe9140a764d67ea65b9ee83c18edef2404de78387691250',
    'web': '/home/mmm/releases/privacy-raster-20261106-r1/web',
}
# What the build host must have verified for these exact binaries.
EXPECTED = {
    'pdf_groups': 7, 'scaling_groups': 9, 'receipt_groups': 7, 'image_groups': 8, 'redacted_groups': 8,
    'company_task_groups': 10, 'sections_groups': 5, 'package_groups': 9, 'company_groups': 10,
    'delivery_groups': 11, 'closure_groups': 15, 'schema': SCHEMA, 'rust_passed': 60,
    'renderer_tests_passed': 5, 'renderer_selftest_passed': True,
    'fmt_clippy_passed': True, 'web_build_passed': True,
}
NEW_COLUMNS = [
    ('privacy_receipt_reads', 'page'),
    ('privacy_image_deliveries', 'source_page'),
]
IN_USE = ("SELECT (SELECT count(*) FROM privacy_receipt_reads WHERE page IS NOT NULL)"
          " + (SELECT count(*) FROM privacy_image_deliveries WHERE source_page IS NOT NULL)")
SCOPE = 'privacy_receipt_in_scope(bigint,bigint)'  # widened to PDF receipts by 0098
POLICY = ("SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(device_id,blocked,collection_paused,collection_enforced,"
          "collection_epoch,collection_changed_at) ORDER BY device_id)::text,'')) FROM device_data_controls c")
# gps-pdf-render/src/sandbox.rs MEMORY_BYTES: the most one page may ask for.
RENDERER_MEMORY = 768 * 1024 * 1024
PROBES = ('open_file', 'open_socket', 'start_program', 'start_process', 'too_much_memory', 'too_much_cpu')


class Stop(Exception):
    """A precondition or verification did not hold."""


def require(condition, message):
    if not condition:
        raise Stop(message)


def sha(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for block in iter(lambda: source.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def run(args):
    return subprocess.run(args, check=True, capture_output=True).stdout.decode()


def config(path):
    return {k.strip(): v.strip().strip('"').strip("'") for k, v in
            (line.split('=', 1) for line in pathlib.Path(path).read_text().splitlines()
             if '=' in line and not line.lstrip().startswith('#'))}


class Site:
    """The production host. The build-host rehearsal substitutes a throwaway copy."""
    environment = 'production'
    origin = 'https://gps.serial.kr'
    stage = pathlib.Path('/home/mmm/gps-artifacts') / RELEASE
    api = pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
    renderer = pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-pdf-render')  # where the API looks for it
    env = pathlib.Path('/home/mmm/projects/gps-tracker-api/.env')
    web = pathlib.Path('/home/mmm/gps-tracker-web/dist-root')
    release = pathlib.Path('/home/mmm/releases') / RELEASE / 'web'
    backup = pathlib.Path('/home/mmm/backups') / RELEASE

    def require_root(self):
        require(os.geteuid() == 0, 'run as root')

    def stop(self):
        run(['systemctl', 'stop', 'gps-tracker-api'])

    def start(self):
        run(['systemctl', 'start', 'gps-tracker-api'])

    def restart(self):
        run(['systemctl', 'restart', 'gps-tracker-api'])

    def health(self):
        with urllib.request.urlopen(self.origin + '/health', timeout=5) as response:
            return json.load(response)

    def served(self, path):
        with urllib.request.urlopen(self.origin + path, timeout=10) as response:
            return response.read()

    def neighbors(self):
        # dev GPS and Shield share this host and must be untouched.
        return {
            'dev_api': sha('/home/gps-dev/projects/gps-tracker-api/bin/gps-tracker-api-dev'),
            'dev_web': str(pathlib.Path('/home/gps-dev/gps-tracker-web-dev/dist').resolve()),
            'shield': str(pathlib.Path('/srv/shield/current').resolve()),
            'processes': run(['systemctl', 'show', 'gps-tracker-api-dev', 'shield-api',
                              '-p', 'MainPID', '-p', 'ActiveEnterTimestamp']),
        }

    def timer_active(self):
        return run(['systemctl', 'is-active', 'gps-privacy-accounts.timer']).strip() == 'active'

    def service(self):
        """Who the API runs as, and what its service puts around every process it starts."""
        shown = dict(line.split('=', 1) for line in
                     run(['systemctl', 'show', 'gps-tracker-api', '-p', 'MainPID', '-p', 'User', '-p', 'Group']).splitlines() if '=' in line)
        pid = int(shown['MainPID'])
        require(pid > 0 and shown.get('User'), 'gps-tracker-api has no running main process or no service account')
        status = dict(line.split(':', 1) for line in pathlib.Path(f'/proc/{pid}/status').read_text().splitlines() if ':' in line)
        group = pathlib.Path('/sys/fs/cgroup' + pathlib.Path(f'/proc/{pid}/cgroup').read_text().strip().split(':')[-1])
        memory = dict(line.split(':', 1) for line in pathlib.Path('/proc/meminfo').read_text().splitlines())
        return {
            'user': shown['User'], 'group': shown.get('Group') or shown['User'],
            'system_call_filter': int(status['Seccomp']) != 0,
            'memory_max': (group / 'memory.max').read_text().strip(),
            'memory_current': int((group / 'memory.current').read_text()),
            'host_memory_available': 1024 * (int(memory['MemAvailable'].split()[0]) + int(memory['SwapFree'].split()[0])),
        }

    def connect(self, readonly=False):
        db = psycopg2.connect(config(self.env)['DATABASE_URL'])
        if readonly:
            db.set_session(readonly=True)
        return db


def selftest(binary, service):
    """The processor's own proof, started the way the API starts it: no environment, in /."""
    account = {'user': service['user'], 'group': service['group'], 'extra_groups': []} if service.get('user') else {}
    try:
        done = subprocess.run([str(binary), 'selftest'], env={}, cwd='/', stdin=subprocess.DEVNULL,
                              capture_output=True, timeout=60, **account)
        report = json.loads(done.stdout)
    except Exception as error:
        raise Stop(f'PDF processor self-test could not run: {error!r}') from error
    passed = (done.returncode == 0 and report.get('sandbox_holds') is True and report.get('renders_inside_sandbox') is True
              and all(report.get(probe, {}).get('blocked') is True for probe in PROBES))
    require(passed, f'PDF processor self-test failed (exit {done.returncode}): {done.stdout.decode(errors="replace")[:400]}')
    return report


def room(service):
    """One page may use RENDERER_MEMORY inside the API's service; a kernel kill there stops the API."""
    require(not service['system_call_filter'],
            'the API service has a system call filter of its own; prove the PDF processor inside that service first')
    limit = service['memory_max']
    require(limit == 'max' or int(limit) - service['memory_current'] >= RENDERER_MEMORY,
            f'the API service memory limit ({limit}) leaves less than one page of PDF processor memory')
    require(service['host_memory_available'] >= 2 * RENDERER_MEMORY,
            f"the host has {service['host_memory_available'] >> 20} MiB of memory and swap available; the PDF processor may use {RENDERER_MEMORY >> 20} MiB")


def artifacts(site):
    """Everything staged is what the build host produced and verified. Reads only."""
    stage = site.stage
    manifest = json.loads((stage / 'manifest.json').read_text())
    validation = json.loads((stage / 'validation.json').read_text())
    require(manifest['release'] == RELEASE and manifest['schema'] == SCHEMA, 'manifest is for another release')
    require(manifest['previous'] == {k: PREVIOUS[k] for k in ('release', 'api_sha256')}, 'manifest expects another previous release')
    for key, value in EXPECTED.items():
        require(validation.get(key) == value, f'validation {key}={validation.get(key)!r}, expected {value!r}')
    require(validation['api_sha256'] == manifest['api_sha256'] == sha(stage / 'gps-tracker-api'), 'API binary differs from the validated build')
    require(validation['renderer_sha256'] == manifest['renderer_sha256'] == sha(stage / 'gps-pdf-render'), 'PDF processor differs from the validated build')
    require(manifest['renderer_memory_bytes'] == RENDERER_MEMORY, 'PDF processor memory ceiling differs from what this script checks')
    require((stage / 'gps-pdf-render').stat().st_mode & 0o111 == 0o111, 'staged gps-pdf-render is not executable (chmod 755)')
    require(manifest['web_sha256'] == sha(stage / 'web.tar.gz'), 'web archive differs from the manifest')
    require(manifest['source_sha256'] == sha(stage / 'source.tar.gz'), 'source archive differs from the manifest')
    for name, digest in manifest['ops_files'].items():
        require(sha(stage / name) == digest, f'{name} differs from the manifest')
    require(sha(__file__) == manifest['ops_files']['release_privacy_pdf.py'], 'this is not the staged release script')

    with tarfile.open(stage / 'web.tar.gz') as archive:
        for member in archive.getmembers():
            parts = pathlib.PurePosixPath(member.name).parts
            require((member.isfile() or member.isdir()) and '..' not in parts and not member.name.startswith('/'), f'unsafe web entry {member.name}')
        index = archive.extractfile('./index.html').read().decode()
        entries = re.findall(r'(?:src|href)="(/assets/[^"]+)"', index)
        # A wrong build base (for example a shell-mangled VITE_BASE) breaks every page.
        require(entries and '/gps-tracker/app/assets/' not in index and 'Program Files' not in index, 'web index was built with a wrong base path')
        for entry in entries:
            require(archive.getmember('.' + entry).isfile(), f'web asset {entry} missing')

    migrations = {}
    with tarfile.open(stage / 'source.tar.gz') as archive:
        for member in archive.getmembers():
            if member.isfile() and member.name.startswith('gps-tracker-api/migrations/') and member.name.endswith('.sql'):
                version = int(pathlib.PurePosixPath(member.name).name.split('_')[0])
                data = archive.extractfile(member).read()
                require(version not in migrations and hashlib.sha256(data).hexdigest() == manifest['migrations'].get(str(version)), f'migration {version} differs from the manifest')
                migrations[version] = data
    require(set(migrations) == set(range(1, SCHEMA + 1)), 'source archive must hold migrations 1..98 exactly')
    return manifest, migrations, index, entries


def checksum(data):
    return hashlib.sha384(data).hexdigest()  # what SQLx stores for a migration file


def scope(q):
    """The receipt scope function exactly as PostgreSQL would recreate it."""
    q.execute('SELECT pg_get_functiondef(%s::regprocedure)', (SCOPE,))
    return q.fetchone()[0]


def database(q, migrations):
    """'previous' (1..97 as built, no new column, image-only scope) or 'current' (1..98, both columns, PDF in scope)."""
    q.execute("SELECT version,encode(checksum,'hex'),success FROM _sqlx_migrations ORDER BY version")
    rows = q.fetchall()
    require(all(success for _, _, success in rows), 'a recorded migration is marked failed')
    applied = {version: digest for version, digest, _ in rows}
    q.execute("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() AND (table_name,column_name) IN %s", (tuple(NEW_COLUMNS),))
    columns = set(q.fetchall())
    pdf = 'application/pdf' in scope(q)
    built = {version: checksum(data) for version, data in migrations.items()}
    if applied == {v: c for v, c in built.items() if v < SCHEMA} and not columns and not pdf:
        return 'previous'
    if applied == built and columns == set(NEW_COLUMNS) and pdf:
        return 'current'
    different = sorted(v for v in set(applied) | set(built) if applied.get(v) != built.get(v))
    raise Stop(f'database is in neither expected state: migrations differing {different}, new columns present {sorted(columns)}, PDF in receipt scope {pdf}')


def preflight(site, want):
    site.require_root()
    manifest, migrations, index, entries = artifacts(site)
    require(shutil.disk_usage(site.stage).free > 1024 ** 3 and shutil.disk_usage(site.api.parent).free > 1024 ** 3, 'less than 1 GiB free')
    with site.connect(readonly=True) as db, db.cursor() as q:
        state = database(q, migrations)
        q.execute(POLICY)
        policy = q.fetchone()[0]
        function = scope(q)
        in_use = None
        if state == 'current':
            q.execute(IN_USE)
            in_use = q.fetchone()[0]
    health = site.health()
    require(health.get('ok') and health.get('db') and health.get('environment') == site.environment, f'API health is {health}')
    installed = site.renderer.exists() or site.renderer.is_symlink()
    found = {'database': state, 'health_release': health.get('release'), 'api_sha256': sha(site.api),
             'renderer_sha256': sha(site.renderer) if installed else None, 'web': str(site.web.resolve())}
    staged, link = site.api.with_name(site.api.name + '.next-pdf'), site.web.with_name(site.web.name + '.next-pdf')
    staged_renderer = site.renderer.with_name(site.renderer.name + '.next-pdf')
    service = site.service()
    if want == 'previous':
        expected = {'database': 'previous', 'health_release': PREVIOUS['release'], 'api_sha256': PREVIOUS['api_sha256'],
                    'renderer_sha256': None, 'web': PREVIOUS['web']}
        require(found == expected, f'host is not on the previous release: {found}')
        for leftover in (staged, staged_renderer, link, site.release.parent, site.backup):
            require(not leftover.exists() and not leftover.is_symlink(), f'{leftover} already exists; an earlier attempt needs review')
        # Same kernel, same account, same empty environment as the API will give it.
        room(service)
        proof = selftest(site.stage / 'gps-pdf-render', service)
    else:
        expected = {'database': 'current', 'health_release': RELEASE, 'api_sha256': manifest['api_sha256'],
                    'renderer_sha256': manifest['renderer_sha256'], 'web': str(site.release)}
        require(found == expected, f'host is not on this release: {found}')
        require(sha(site.backup / 'api.previous') == PREVIOUS['api_sha256'], 'backup of the previous API is missing or different')
        saved = (site.backup / 'receipt_scope.previous.sql').read_text()
        require(SCOPE.split('(')[0] in saved and 'application/pdf' not in saved, 'backup of the previous receipt scope function is missing or different')
        require(in_use == 0, f'{in_use} rows already use the new columns; repair forward instead of going back')
        proof = None
    return {'manifest': manifest, 'migrations': migrations, 'index': index, 'entries': entries, 'policy': policy,
            'found': found, 'staged': staged, 'staged_renderer': staged_renderer, 'link': link, 'scope': function,
            'service': service, 'selftest': proof,
            'baseline': {'env': sha(site.env), 'neighbors': site.neighbors()}}


def wait_health(site, release, seconds=45):
    last = None
    for _ in range(seconds):
        try:
            last = site.health()
            if last.get('ok') and last.get('db') and last.get('release') == release:
                return last
        except Exception as error:  # still starting
            last = repr(error)
        time.sleep(1)
    raise Stop(f'API did not become healthy on {release}: {last}')


def migrate(site, context):
    """One transaction: the state is re-checked under lock, 0098 runs, and SQLx is told so."""
    migrations = context['migrations']
    with site.connect() as db, db.cursor() as q:
        q.execute("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'")
        q.execute("LOCK TABLE _sqlx_migrations IN SHARE ROW EXCLUSIVE MODE")
        require(database(q, migrations) == 'previous' and scope(q) == context['scope'], 'database changed since the preflight')
        q.execute(migrations[SCHEMA].decode())
        q.execute("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(%s,'privacy pdf sources',true,%s,0)",
                  (SCHEMA, bytes.fromhex(checksum(migrations[SCHEMA]))))
        require(database(q, migrations) == 'current', 'migration did not produce the expected schema')
        q.execute(IN_USE)
        require(q.fetchone()[0] == 0, 'new columns are not empty')


def unmigrate(site, migrations):
    """Remove 0098 again. Refuses once any row uses the new columns."""
    previous = (site.backup / 'receipt_scope.previous.sql').read_text()
    with site.connect() as db, db.cursor() as q:
        q.execute("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'")
        q.execute("LOCK TABLE _sqlx_migrations,privacy_receipt_reads,privacy_image_deliveries IN SHARE ROW EXCLUSIVE MODE")
        require(database(q, migrations) == 'current', 'database is not on schema 98')
        q.execute(IN_USE)
        in_use = q.fetchone()[0]
        require(in_use == 0, f'{in_use} rows already use the new columns; repair forward instead of going back')
        q.execute("ALTER TABLE privacy_receipt_reads DROP COLUMN page")
        q.execute("ALTER TABLE privacy_image_deliveries DROP COLUMN source_page")
        q.execute(previous)  # CREATE OR REPLACE FUNCTION, as PostgreSQL printed it before 0098
        require(scope(q) == previous, 'the receipt scope function did not return to its previous definition')
        q.execute("DELETE FROM _sqlx_migrations WHERE version=%s", (SCHEMA,))
        require(database(q, migrations) == 'previous', 'schema did not return to 97')


def set_aside(site, label):
    """Keep the attempt's files for review, out of the way of a later apply."""
    suffix = f'.{label}-{int(time.time())}'
    for path in (site.release.parent, site.backup):
        if path.exists():
            path.rename(path.with_name(path.name + suffix))


def go_back(site, context, label):
    """Previous web, schema 97, the previous API and no processor, in an order that never starts a
    binary against a schema it rejects. The API is down between stop and start."""
    if site.web.resolve() != pathlib.Path(PREVIOUS['web']):
        link = context['link']
        link.symlink_to(PREVIOUS['web'])
        os.replace(link, site.web)
    site.stop()
    unmigrate(site, context['migrations'])
    restored = site.api.with_name(site.api.name + '.previous-pdf')
    shutil.copy2(site.backup / 'api.previous', restored)
    require(sha(restored) == PREVIOUS['api_sha256'], 'backup of the previous API changed')
    os.replace(restored, site.api)
    for path in (site.renderer, context['staged'], context['staged_renderer']):
        path.unlink(missing_ok=True)  # the previous API never starts the processor
    site.start()
    health = wait_health(site, PREVIOUS['release'])
    set_aside(site, label)
    return health


def unchanged(site, context):
    require(site.neighbors() == context['baseline']['neighbors'], 'dev GPS or Shield changed during the release')
    require(sha(site.env) == context['baseline']['env'], 'API environment file changed during the release')
    require(site.timer_active(), 'gps-privacy-accounts.timer is not active')
    with site.connect(readonly=True) as db, db.cursor() as q:
        q.execute(POLICY)
        require(q.fetchone()[0] == context['policy'], 'collection policies changed during the release')


def confinement(service, proof):
    return {'self_test': 'passed', 'run_as': service['user'] or 'current account',
            'blocked': {probe: proof[probe]['how'] for probe in PROBES},
            'api_service_system_call_filter': service['system_call_filter'],
            'api_service_memory_max': service['memory_max'],
            'host_memory_and_swap_available_mib': service['host_memory_available'] >> 20,
            'processor_memory_ceiling_mib': RENDERER_MEMORY >> 20}


def check(site):
    context = preflight(site, 'previous')
    return {'mode': 'check', 'release': RELEASE, 'ready': True, 'found': context['found'],
            'artifact_api_sha256': context['manifest']['api_sha256'],
            'artifact_renderer_sha256': context['manifest']['renderer_sha256'],
            'pdf_processor': confinement(context['service'], context['selftest']),
            'commit': context['manifest']['commit'], 'changes_made': False}


def apply(site):
    os.umask(0o077)
    context = preflight(site, 'previous')
    manifest = context['manifest']
    site.backup.mkdir()
    shutil.copy2(site.api, site.backup / 'api.previous')
    require(sha(site.backup / 'api.previous') == PREVIOUS['api_sha256'], 'backup copy of the API is wrong')
    (site.backup / 'receipt_scope.previous.sql').write_text(context['scope'])
    (site.backup / 'baseline.json').write_text(json.dumps({**context['found'], **context['baseline']}, indent=2))

    site.release.mkdir(parents=True)
    with tarfile.open(site.stage / 'web.tar.gz') as archive:
        for member in archive.getmembers():
            target = (site.release / member.name).resolve()
            require(target == site.release or site.release in target.parents, f'web entry {member.name} escapes the release directory')
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open('wb') as destination:
                    shutil.copyfileobj(source, destination)
    for path in [site.release.parent, site.release, *site.release.rglob('*')]:
        path.chmod(0o755 if path.is_dir() else 0o644)

    staged, staged_renderer = context['staged'], context['staged_renderer']
    for source, target, digest in ((site.stage / 'gps-tracker-api', staged, manifest['api_sha256']),
                                   (site.stage / 'gps-pdf-render', staged_renderer, manifest['renderer_sha256'])):
        shutil.copy2(source, target)
        target.chmod(0o755)
        require(sha(target) == digest, f'staged copy {target.name} is wrong')

    try:
        migrate(site, context)
    except Exception:
        # Nothing is live yet and the transaction rolled back: just clear the staging.
        staged.unlink()
        staged_renderer.unlink()
        set_aside(site, 'not-applied')
        raise

    try:
        # The processor first: the previous API ignores it, the new one finds it at its first PDF page.
        os.replace(staged_renderer, site.renderer)
        os.replace(staged, site.api)
        site.restart()
        health = wait_health(site, RELEASE)
        service = site.service()
        room(service)
        proof = selftest(site.renderer, service)
    except Exception as failure:
        try:
            go_back(site, context, 'reverted')
        except Exception as second:
            raise Stop(f'NEW RELEASE NOT WORKING AND AUTOMATIC RETURN FAILED. new release: {failure}; return: {second}. Schema, binary and processor need manual repair.') from second
        raise Stop(f'new API or PDF processor did not work; returned to {PREVIOUS["release"]} on schema 97. Cause: {failure}') from failure

    link = context['link']
    link.symlink_to(site.release)
    os.replace(link, site.web)
    require(site.served('/profile') == (site.release / 'index.html').read_bytes(), f'API is on {RELEASE}, but the served page is not the released index')
    for entry in context['entries']:
        require(site.served(entry) == (site.release / entry.lstrip('/')).read_bytes(), f'API is on {RELEASE}, but served asset {entry} differs')
    unchanged(site, context)
    report = {'release': RELEASE, 'commit': manifest['commit'], 'schema': SCHEMA, 'api_sha256': sha(site.api),
              'renderer_sha256': sha(site.renderer), 'renderer': str(site.renderer),
              'pdf_processor': confinement(service, proof),
              'web': str(site.web.resolve()), 'health': health, 'previous_release': PREVIOUS['release'],
              'backup': str(site.backup), 'neighbor_releases_unchanged': True,
              'existing_collection_policies_unchanged': True, 'timer_active': True}
    (site.stage / 'deployment.json').write_text(json.dumps(report, indent=2))
    return report


def rollback(site):
    os.umask(0o077)
    context = preflight(site, 'current')
    health = go_back(site, context, 'rolled-back')
    unchanged(site, context)
    report = {'rolled_back_from': RELEASE, 'release': PREVIOUS['release'], 'schema': SCHEMA - 1,
              'api_sha256': sha(site.api), 'renderer_installed': site.renderer.exists(),
              'web': str(site.web.resolve()), 'health': health,
              'neighbor_releases_unchanged': True, 'existing_collection_policies_unchanged': True}
    (site.stage / 'rollback.json').write_text(json.dumps(report, indent=2))
    return report


def rehearsed(site):
    """Production runs only the exact script and binaries that passed the build-host rehearsal."""
    record = json.loads((site.stage / 'rehearsal.json').read_text())
    manifest = json.loads((site.stage / 'manifest.json').read_text())
    require(record.get('passed') is True and record.get('api_sha256') == manifest['api_sha256']
            and record.get('renderer_sha256') == manifest['renderer_sha256']
            and record.get('release_script_sha256') == sha(__file__),
            'this script and these binaries have not passed the build-host rehearsal')


def main():
    modes = {'check': check, 'apply': apply, 'rollback': rollback}
    if len(sys.argv) != 2 or sys.argv[1] not in modes:
        sys.exit(__doc__)
    try:
        site = Site()
        rehearsed(site)
        print(json.dumps(modes[sys.argv[1]](site), indent=2))
    except Stop as stop:
        sys.exit(f'STOPPED: {stop}')


if __name__ == '__main__':
    main()
