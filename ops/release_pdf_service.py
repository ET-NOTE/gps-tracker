"""GPS release pdf-service-20261106-r1 (infrastructure round 1, stage 2): the API binary only.

Run as root on the GPS production host, from the staged artifact directory:

    python3 release_pdf_service.py check      # read-only preflight; changes nothing
    python3 release_pdf_service.py apply      # preflight, swap the API binary, verify
    python3 release_pdf_service.py rollback   # back to the previous API binary

The new API can send PDF pages to a separate processor service through a socket. It does so
only when GPS_PDF_SOCKET is set, which `pdf_service.py apply` does afterwards; until then it
starts the processor itself exactly as the previous release did.

Pinned to one transition. The running release must be privacy-pdf-20261106-r1 on schema 98 as
built, with the PDF processor of that release installed. Schema, web and the processor file
are not changed, so going back is the previous binary and is always possible. `apply` goes
back by itself when the new API does not become healthy.
"""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request

import psycopg2

NAME = 'pdf-service-20261106'
RELEASE = 'pdf-service-20261106-r1'
SCHEMA = 98
PREVIOUS = {
    'release': 'privacy-pdf-20261106-r1',
    'api_sha256': 'b6ac9edb5bacae749db3c2561f95763860599abc7de7099dcf50bc63a427bba7',
}
RENDERER = '3eaaf5535c01c58e1c4f3eae5e3a4799c59b916233960897581d5ee7707d4ffb'  # installed by the previous release, unchanged
# What the build host must have verified for this exact binary.
EXPECTED = {
    'pdf_groups': 7, 'pdf_through_socket_groups': 7, 'scaling_groups': 9, 'receipt_groups': 7, 'image_groups': 8,
    'redacted_groups': 8, 'company_task_groups': 10, 'sections_groups': 5, 'package_groups': 9, 'company_groups': 10,
    'delivery_groups': 11, 'closure_groups': 15, 'schema': SCHEMA, 'rust_passed': 61,
    'renderer_sha256': RENDERER, 'fmt_clippy_passed': True,
}
COLUMNS = [('privacy_receipt_reads', 'page'), ('privacy_image_deliveries', 'source_page')]
POLICY = ("SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(device_id,blocked,collection_paused,collection_enforced,"
          "collection_epoch,collection_changed_at) ORDER BY device_id)::text,'')) FROM device_data_controls c")
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
    stage = pathlib.Path('/home/mmm/gps-artifacts') / NAME
    api = pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
    renderer = pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-pdf-render')
    env = pathlib.Path('/home/mmm/projects/gps-tracker-api/.env')
    web = pathlib.Path('/home/mmm/gps-tracker-web/dist-root')
    backup = pathlib.Path('/home/mmm/backups') / RELEASE

    def require_root(self):
        require(os.geteuid() == 0, 'run as root')

    def restart(self):
        run(['systemctl', 'restart', 'gps-tracker-api'])

    def health(self):
        with urllib.request.urlopen(self.origin + '/health', timeout=5) as response:
            return json.load(response)

    def neighbors(self):
        # dev GPS and Shield share this host and must be untouched.
        return {
            'dev_api': sha('/home/gps-dev/projects/gps-tracker-api/bin/gps-tracker-api-dev'),
            'dev_web': str(pathlib.Path('/home/gps-dev/gps-tracker-web-dev/dist').resolve()),
            'shield': str(pathlib.Path('/srv/shield/current').resolve()),
            'processes': run(['systemctl', 'show', 'gps-tracker-api-dev', 'shield-api',
                              '-p', 'MainPID', '-p', 'ActiveEnterTimestamp']),
        }

    def timers_active(self):
        done = subprocess.run(['systemctl', 'is-active', 'gps-privacy-accounts.timer', 'gps-privacy-files.timer'], capture_output=True)
        return done.stdout.decode().split() == ['active', 'active']

    def service(self):
        """Who the API runs as, and what its service puts around every process it starts."""
        shown = dict(line.split('=', 1) for line in
                     run(['systemctl', 'show', 'gps-tracker-api', '-p', 'MainPID', '-p', 'User', '-p', 'Group']).splitlines() if '=' in line)
        pid = int(shown['MainPID'])
        require(pid > 0 and shown.get('User'), 'gps-tracker-api has no running main process or no service account')
        status = dict(line.split(':', 1) for line in pathlib.Path(f'/proc/{pid}/status').read_text().splitlines() if ':' in line)
        group = pathlib.Path('/sys/fs/cgroup' + pathlib.Path(f'/proc/{pid}/cgroup').read_text().strip().split(':')[-1])
        memory = dict(line.split(':', 1) for line in pathlib.Path('/proc/meminfo').read_text().splitlines())
        limited = (group / 'memory.max').is_file()  # absent where the memory controller is not delegated to this unit
        return {
            'user': shown['User'], 'group': shown.get('Group') or shown['User'],
            'system_call_filter': int(status['Seccomp']) != 0,
            'no_new_privileges': int(status['NoNewPrivs']) == 1,
            'through_socket': b'GPS_PDF_SOCKET=' in pathlib.Path(f'/proc/{pid}/environ').read_bytes(),
            'memory_max': (group / 'memory.max').read_text().strip() if limited else 'max',
            'memory_current': int((group / 'memory.current').read_text()) if limited else 0,
            'host_memory_available': 1024 * (int(memory['MemAvailable'].split()[0]) + int(memory['SwapFree'].split()[0])),
        }

    def connect(self):
        db = psycopg2.connect(config(self.env)['DATABASE_URL'])
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
    return {probe: report[probe]['how'] for probe in PROBES}


def room(service):
    """While the API starts the processor itself, one page may use RENDERER_MEMORY inside the API's service."""
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
    require(manifest['previous'] == PREVIOUS, 'manifest expects another previous release')
    for key, value in EXPECTED.items():
        require(validation.get(key) == value, f'validation {key}={validation.get(key)!r}, expected {value!r}')
    require(validation['api_sha256'] == manifest['api_sha256'] == sha(stage / 'gps-tracker-api'), 'API binary differs from the validated build')
    require(manifest['renderer_sha256'] == RENDERER, 'manifest names another PDF processor')
    require(manifest['source_sha256'] == sha(stage / 'source.tar.gz'), 'source archive differs from the manifest')
    for name, digest in manifest['ops_files'].items():
        require(sha(stage / name) == digest, f'{name} differs from the manifest')
    require(sha(__file__) == manifest['ops_files']['release_pdf_service.py'], 'this is not the staged release script')
    migrations = {}
    with tarfile.open(stage / 'source.tar.gz') as archive:
        for member in archive.getmembers():
            if member.isfile() and member.name.startswith('gps-tracker-api/migrations/') and member.name.endswith('.sql'):
                version = int(pathlib.PurePosixPath(member.name).name.split('_')[0])
                data = archive.extractfile(member).read()
                require(version not in migrations and hashlib.sha256(data).hexdigest() == manifest['migrations'].get(str(version)), f'migration {version} differs from the manifest')
                migrations[version] = hashlib.sha384(data).hexdigest()  # what SQLx stores for a migration file
    require(set(migrations) == set(range(1, SCHEMA + 1)), 'source archive must hold migrations 1..98 exactly')
    return manifest, migrations


def database(site, migrations):
    """The schema both releases share: migrations 1..98 exactly as built. Nothing is written."""
    with site.connect() as db, db.cursor() as q:
        q.execute("SELECT version,encode(checksum,'hex'),success FROM _sqlx_migrations ORDER BY version")
        rows = q.fetchall()
        require(all(success for _, _, success in rows) and {version: digest for version, digest, _ in rows} == migrations,
                'the recorded migrations are not 1..98 as built')
        q.execute("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() AND (table_name,column_name) IN %s", (tuple(COLUMNS),))
        require(set(q.fetchall()) == set(COLUMNS), 'schema 98 columns are missing')
        q.execute(POLICY)
        return q.fetchone()[0]


def preflight(site, want):
    site.require_root()
    manifest, migrations = artifacts(site)
    require(shutil.disk_usage(site.stage).free > 1024 ** 3 and shutil.disk_usage(site.api.parent).free > 1024 ** 3, 'less than 1 GiB free')
    policy = database(site, migrations)
    health = site.health()
    require(health.get('ok') and health.get('db') and health.get('environment') == site.environment, f'API health is {health}')
    require(site.renderer.is_file() and sha(site.renderer) == RENDERER, 'the installed PDF processor is not the one of the previous release')
    found = {'health_release': health.get('release'), 'api_sha256': sha(site.api)}
    staged = site.api.with_name(site.api.name + '.next-service')
    service = site.service()
    if want == 'previous':
        require(found == {'health_release': PREVIOUS['release'], 'api_sha256': PREVIOUS['api_sha256']}, f'host is not on the previous release: {found}')
        for leftover in (staged, site.backup):
            require(not leftover.exists() and not leftover.is_symlink(), f'{leftover} already exists; an earlier attempt needs review')
    else:
        require(found == {'health_release': RELEASE, 'api_sha256': manifest['api_sha256']}, f'host is not on this release: {found}')
        require(sha(site.backup / 'api.previous') == PREVIOUS['api_sha256'], 'backup of the previous API is missing or different')
        # The previous API does not know the socket; it would start the processor itself under a
        # configuration made for the other arrangement.
        require(not service['through_socket'], 'the API is configured for the separate processor service; run `pdf_service.py rollback` first')
    return {'manifest': manifest, 'migrations': migrations, 'policy': policy, 'found': found, 'staged': staged, 'service': service,
            'baseline': {'env': sha(site.env), 'web': str(site.web.resolve()), 'neighbors': site.neighbors()}}


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


def processor(site):
    """The processor file is the same; how it can be used depends on how the API reaches it."""
    service = site.service()
    if not service['through_socket']:
        room(service)  # the API starts it itself: the service must not add what the self-test cannot see
    return {'sha256': sha(site.renderer), 'self_test_as_service_account': selftest(site.renderer, service), 'run_as': service['user'],
            'reached_through': 'separate service' if service['through_socket'] else 'child of the API',
            'api_no_new_privileges': service['no_new_privileges'], 'api_system_call_filter': service['system_call_filter']}


def go_back(site, context):
    restored = site.api.with_name(site.api.name + '.previous-service')
    shutil.copy2(site.backup / 'api.previous', restored)
    require(sha(restored) == PREVIOUS['api_sha256'], 'backup of the previous API changed')
    os.replace(restored, site.api)
    context['staged'].unlink(missing_ok=True)
    site.restart()
    health = wait_health(site, PREVIOUS['release'])
    site.backup.rename(site.backup.with_name(site.backup.name + f'.returned-{int(time.time())}'))
    return health


def unchanged(site, context):
    require(site.neighbors() == context['baseline']['neighbors'], 'dev GPS or Shield changed during the release')
    require(sha(site.env) == context['baseline']['env'], 'API environment file changed during the release')
    require(str(site.web.resolve()) == context['baseline']['web'], 'the web link changed during the release')
    require(sha(site.renderer) == RENDERER, 'the PDF processor file changed during the release')
    require(site.timers_active(), 'a cleanup timer is not active')
    require(database(site, context['migrations']) == context['policy'], 'schema or collection policies changed during the release')


def check(site):
    context = preflight(site, 'previous')
    return {'mode': 'check', 'release': RELEASE, 'ready': True, 'found': context['found'],
            'artifact_api_sha256': context['manifest']['api_sha256'], 'pdf_processor': processor(site),
            'commit': context['manifest']['commit'], 'changes_made': False}


def apply(site):
    os.umask(0o077)
    context = preflight(site, 'previous')
    manifest = context['manifest']
    site.backup.mkdir()
    shutil.copy2(site.api, site.backup / 'api.previous')
    require(sha(site.backup / 'api.previous') == PREVIOUS['api_sha256'], 'backup copy of the API is wrong')
    (site.backup / 'baseline.json').write_text(json.dumps({**context['found'], **context['baseline']}, indent=2))
    staged = context['staged']
    shutil.copy2(site.stage / 'gps-tracker-api', staged)
    staged.chmod(0o755)
    require(sha(staged) == manifest['api_sha256'], 'staged API copy is wrong')
    try:
        os.replace(staged, site.api)
        site.restart()
        health = wait_health(site, RELEASE)
        proof = processor(site)
    except Exception as failure:
        try:
            go_back(site, context)
        except Exception as second:
            raise Stop(f'NEW API NOT WORKING AND AUTOMATIC RETURN FAILED. new API: {failure}; return: {second}. The binary needs manual repair.') from second
        raise Stop(f'new API did not work; returned to {PREVIOUS["release"]}. Cause: {failure}') from failure
    unchanged(site, context)
    report = {'release': RELEASE, 'commit': manifest['commit'], 'schema': SCHEMA, 'api_sha256': sha(site.api), 'health': health,
              'pdf_processor': proof, 'previous_release': PREVIOUS['release'], 'backup': str(site.backup),
              'schema_web_and_processor_unchanged': True, 'neighbor_releases_unchanged': True,
              'existing_collection_policies_unchanged': True, 'timers_active': True}
    (site.stage / 'deployment.json').write_text(json.dumps(report, indent=2))
    return report


def rollback(site):
    os.umask(0o077)
    context = preflight(site, 'current')
    health = go_back(site, context)
    unchanged(site, context)
    report = {'rolled_back_from': RELEASE, 'release': PREVIOUS['release'], 'schema': SCHEMA, 'api_sha256': sha(site.api), 'health': health,
              'pdf_processor': processor(site), 'neighbor_releases_unchanged': True, 'existing_collection_policies_unchanged': True}
    (site.stage / 'rollback.json').write_text(json.dumps(report, indent=2))
    return report


def rehearsed(site):
    """Production runs only the exact script and binary that passed the build-host rehearsal."""
    record = json.loads((site.stage / 'rehearsal.json').read_text())
    manifest = json.loads((site.stage / 'manifest.json').read_text())
    require(record.get('passed') is True and record.get('api_sha256') == manifest['api_sha256']
            and record.get('release_script_sha256') == sha(__file__),
            'this script and binary have not passed the build-host rehearsal')


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
