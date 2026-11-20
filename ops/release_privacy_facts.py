"""GPS release privacy-facts-20261106-r1 (round 17): schema 98 -> 99, API and web.

Run as root on the GPS production host, from the staged artifact directory:

    python3 release_privacy_facts.py check      # read-only preflight; changes nothing
    python3 release_privacy_facts.py apply      # preflight, migrate, swap API and web, verify
    python3 release_privacy_facts.py rollback   # back to the previous release (see below)

Pinned to one transition. The running release must be pdf-service-20261106-r1 with migrations
1..98 exactly as built, and the PDF processor must run as the separate service that release
was completed with (the API configured with its socket). Anything else stops before the first
change. The processor file, its service and the API's service settings are not touched.

Migration 0099 lets an account package carry the section `location_facts` and adds two nullable
columns for its period. The API refuses to start when the database holds a migration its binary
does not know. Going back therefore removes 0099 (both columns, both constraints as they were,
the SQLx row) and the binary, and is allowed only while no grant uses the section. After that,
repair forward. `apply` goes back by itself when the new API does not work.
"""
import grp
import hashlib
import json
import os
import pathlib
import pwd
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request

import psycopg2

RELEASE = 'privacy-facts-20261106-r1'
SCHEMA = 99
PREVIOUS = {
    'release': 'pdf-service-20261106-r1',
    'api_sha256': '0d28667f3c21af82a43b987a12eec2836547d3717c69ae304688c6e5363ce826',
    'web': '/home/mmm/releases/privacy-pdf-20261106-r1/web',
}
RENDERER = '3eaaf5535c01c58e1c4f3eae5e3a4799c59b916233960897581d5ee7707d4ffb'  # installed, not replaced
SOCKET = '/run/gps-pdf-render/render.sock'
API_ACCOUNT = 'gps-api'
# What the build host must have verified for this exact binary and web archive.
EXPECTED = {
    'pdf_groups': 7, 'pdf_through_socket_groups': 7, 'scaling_groups': 9, 'receipt_groups': 7, 'image_groups': 8,
    'redacted_groups': 8, 'company_task_groups': 10, 'sections_groups': 5, 'package_groups': 9, 'company_groups': 10,
    'delivery_groups': 11, 'closure_groups': 15, 'facts_groups': 6, 'schema': SCHEMA, 'rust_passed': 64,
    'web_tests_passed': 225, 'renderer_sha256': RENDERER, 'fmt_clippy_passed': True, 'web_build_passed': True,
}
TABLE = 'privacy_account_packages'
NEW_COLUMNS = [(TABLE, 'facts_from'), (TABLE, 'facts_until')]
SECTIONS_RULE, PERIOD_RULE = 'privacy_account_sections_valid', 'privacy_account_facts_period'
IN_USE = f"SELECT count(*) FROM {TABLE} WHERE facts_from IS NOT NULL OR facts_until IS NOT NULL OR sections @> ARRAY['location_facts']::text[]"
POLICY = ("SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(device_id,blocked,collection_paused,collection_enforced,"
          "collection_epoch,collection_changed_at) ORDER BY device_id)::text,'')) FROM device_data_controls c")


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


def shown(unit, *properties):
    return dict(line.split('=', 1) for line in run(['systemctl', 'show', unit, *[f'-p{p}' for p in properties]]).splitlines() if '=' in line)


def config(path):
    return {k.strip(): v.strip().strip('"').strip("'") for k, v in
            (line.split('=', 1) for line in pathlib.Path(path).read_text().splitlines()
             if '=' in line and not line.lstrip().startswith('#'))}


class Site:
    """The production host. The build-host rehearsal substitutes its own addresses and neighbours."""
    environment = 'production'
    origin = 'https://gps.serial.kr'
    stage = pathlib.Path('/home/mmm/gps-artifacts') / RELEASE
    api = pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
    renderer = pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-pdf-render')
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

    def timers_active(self):
        done = subprocess.run(['systemctl', 'is-active', 'gps-privacy-accounts.timer', 'gps-privacy-files.timer'], capture_output=True)
        return done.stdout.decode().split() == ['active', 'active']

    def api_process(self):
        """Who the API runs as and how it is told to reach the PDF processor."""
        unit = shown('gps-tracker-api', 'MainPID', 'User')
        pid = int(unit['MainPID'])
        require(pid > 0, 'gps-tracker-api has no running main process')
        environ = dict(item.split('=', 1) for item in pathlib.Path(f'/proc/{pid}/environ').read_bytes().decode(errors='replace').split('\0') if '=' in item)
        return {'user': unit.get('User'), 'pdf_socket': environ.get('GPS_PDF_SOCKET')}

    def processor(self):
        """The separate PDF processor service, exactly as stage 2 of the infrastructure round left it."""
        info = os.stat(SOCKET)
        return {'file_sha256': sha(self.renderer),
                'socket': shown('gps-pdf-render.socket', 'ActiveState', 'UnitFileState', 'ActiveEnterTimestamp'),
                'proof': shown('gps-pdf-render-selftest.service', 'ActiveState', 'Result', 'ActiveEnterTimestamp'),
                'socket_file': [pwd.getpwuid(info.st_uid).pw_name, grp.getgrgid(info.st_gid).gr_name, oct(info.st_mode & 0o777)]}

    def connect(self, readonly=False):
        db = psycopg2.connect(config(self.env)['DATABASE_URL'])
        if readonly:
            db.set_session(readonly=True)
        return db


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
    require(manifest['renderer_sha256'] == RENDERER, 'manifest names another PDF processor')
    require(manifest['web_sha256'] == sha(stage / 'web.tar.gz'), 'web archive differs from the manifest')
    require(manifest['source_sha256'] == sha(stage / 'source.tar.gz'), 'source archive differs from the manifest')
    for name, digest in manifest['ops_files'].items():
        require(sha(stage / name) == digest, f'{name} differs from the manifest')
    require(sha(__file__) == manifest['ops_files']['release_privacy_facts.py'], 'this is not the staged release script')

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
    require(set(migrations) == set(range(1, SCHEMA + 1)), 'source archive must hold migrations 1..99 exactly')
    return manifest, migrations, index, entries


def checksum(data):
    return hashlib.sha384(data).hexdigest()  # what SQLx stores for a migration file


def rules(q):
    """The two table rules of 0099 exactly as PostgreSQL would recreate them."""
    q.execute("SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid=%s::regclass AND conname IN %s", (TABLE, (SECTIONS_RULE, PERIOD_RULE)))
    return dict(q.fetchall())


def database(q, migrations):
    """'previous' (1..98 as built, three sections, no period) or 'current' (1..99, four sections, the period columns and rule)."""
    q.execute("SELECT version,encode(checksum,'hex'),success FROM _sqlx_migrations ORDER BY version")
    rows = q.fetchall()
    require(all(success for _, _, success in rows), 'a recorded migration is marked failed')
    applied = {version: digest for version, digest, _ in rows}
    q.execute("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() AND (table_name,column_name) IN %s", (tuple(NEW_COLUMNS),))
    columns = set(q.fetchall())
    found = rules(q)
    facts = 'location_facts' in found.get(SECTIONS_RULE, '')
    built = {version: checksum(data) for version, data in migrations.items()}
    if applied == {v: c for v, c in built.items() if v < SCHEMA} and not columns and SECTIONS_RULE in found and not facts and PERIOD_RULE not in found:
        return 'previous'
    if applied == built and columns == set(NEW_COLUMNS) and facts and PERIOD_RULE in found:
        return 'current'
    different = sorted(v for v in set(applied) | set(built) if applied.get(v) != built.get(v))
    raise Stop(f'database is in neither expected state: migrations differing {different}, new columns present {sorted(columns)}, rules {sorted(found)}, section allowed {facts}')


def processor(site):
    """This release was rehearsed with the processor as its own service; it changes nothing of it."""
    api, service = site.api_process(), site.processor()
    require(api['user'] == API_ACCOUNT and api['pdf_socket'] == SOCKET,
            f"the API runs as {api['user']!r} with processor socket {api['pdf_socket']!r}; this release was rehearsed with {API_ACCOUNT} and {SOCKET}")
    require(service['file_sha256'] == RENDERER, 'the installed PDF processor is not the one this release was rehearsed with')
    require(service['socket'].get('ActiveState') == 'active' and service['socket'].get('UnitFileState') == 'enabled'
            and service['proof'].get('ActiveState') == 'active' and service['proof'].get('Result') == 'success'
            and service['socket_file'] == ['root', API_ACCOUNT, '0o660'], f'the PDF processor service is not in its verified state: {service}')
    return service


def preflight(site, want):
    site.require_root()
    manifest, migrations, index, entries = artifacts(site)
    require(shutil.disk_usage(site.stage).free > 1024 ** 3 and shutil.disk_usage(site.api.parent).free > 1024 ** 3, 'less than 1 GiB free')
    with site.connect(readonly=True) as db, db.cursor() as q:
        state = database(q, migrations)
        q.execute(POLICY)
        policy = q.fetchone()[0]
        sections_rule = rules(q)[SECTIONS_RULE]
        q.execute(f'SELECT count(*) FROM {TABLE}')
        grants = q.fetchone()[0]
        in_use = None
        if state == 'current':
            q.execute(IN_USE)
            in_use = q.fetchone()[0]
    health = site.health()
    require(health.get('ok') and health.get('db') and health.get('environment') == site.environment, f'API health is {health}')
    found = {'database': state, 'health_release': health.get('release'), 'api_sha256': sha(site.api), 'web': str(site.web.resolve())}
    staged, link = site.api.with_name(site.api.name + '.next-facts'), site.web.with_name(site.web.name + '.next-facts')
    service = processor(site)
    if want == 'previous':
        expected = {'database': 'previous', 'health_release': PREVIOUS['release'], 'api_sha256': PREVIOUS['api_sha256'], 'web': PREVIOUS['web']}
        require(found == expected, f'host is not on the previous release: {found}')
        for leftover in (staged, link, site.release.parent, site.backup):
            require(not leftover.exists() and not leftover.is_symlink(), f'{leftover} already exists; an earlier attempt needs review')
    else:
        expected = {'database': 'current', 'health_release': RELEASE, 'api_sha256': manifest['api_sha256'], 'web': str(site.release)}
        require(found == expected, f'host is not on this release: {found}')
        require(sha(site.backup / 'api.previous') == PREVIOUS['api_sha256'], 'backup of the previous API is missing or different')
        saved = (site.backup / 'sections_rule.previous.sql').read_text()
        require(saved.startswith('CHECK') and 'location_facts' not in saved, 'backup of the previous section rule is missing or different')
        require(in_use == 0, f'{in_use} grants already use the new section; repair forward instead of going back')
    return {'manifest': manifest, 'migrations': migrations, 'index': index, 'entries': entries, 'policy': policy,
            'found': found, 'staged': staged, 'link': link, 'sections_rule': sections_rule, 'grants': grants,
            'baseline': {'env': sha(site.env), 'neighbors': site.neighbors(), 'processor': service}}


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
    """One transaction: the state is re-checked under lock, 0099 runs, and SQLx is told so."""
    migrations = context['migrations']
    with site.connect() as db, db.cursor() as q:
        q.execute("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'")
        q.execute(f"LOCK TABLE _sqlx_migrations,{TABLE} IN SHARE ROW EXCLUSIVE MODE")  # no grant is written meanwhile
        require(database(q, migrations) == 'previous' and rules(q)[SECTIONS_RULE] == context['sections_rule'], 'database changed since the preflight')
        q.execute(f'SELECT count(*) FROM {TABLE}')
        grants = q.fetchone()[0]
        q.execute(migrations[SCHEMA].decode())
        q.execute("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(%s,'privacy location facts',true,%s,0)",
                  (SCHEMA, bytes.fromhex(checksum(migrations[SCHEMA]))))
        require(database(q, migrations) == 'current', 'migration did not produce the expected schema')
        q.execute(IN_USE)
        require(q.fetchone()[0] == 0, 'a grant already carries the new section')
        q.execute(f'SELECT count(*) FROM {TABLE}')
        require(q.fetchone()[0] == grants, 'the migration changed the number of grants')


def unmigrate(site, migrations):
    """Remove 0099 again. Refuses once any grant uses the section."""
    previous = (site.backup / 'sections_rule.previous.sql').read_text()
    with site.connect() as db, db.cursor() as q:
        q.execute("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'")
        q.execute(f"LOCK TABLE _sqlx_migrations,{TABLE} IN SHARE ROW EXCLUSIVE MODE")
        require(database(q, migrations) == 'current', 'database is not on schema 99')
        q.execute(IN_USE)
        in_use = q.fetchone()[0]
        require(in_use == 0, f'{in_use} grants already use the new section; repair forward instead of going back')
        q.execute(f"ALTER TABLE {TABLE} DROP CONSTRAINT {PERIOD_RULE}")
        q.execute(f"ALTER TABLE {TABLE} DROP COLUMN facts_from, DROP COLUMN facts_until")
        q.execute(f"ALTER TABLE {TABLE} DROP CONSTRAINT {SECTIONS_RULE}")
        q.execute(f"ALTER TABLE {TABLE} ADD CONSTRAINT {SECTIONS_RULE} {previous}")  # as PostgreSQL printed it before 0099
        require(rules(q) == {SECTIONS_RULE: previous}, 'the section rule did not return to its previous definition')
        q.execute("DELETE FROM _sqlx_migrations WHERE version=%s", (SCHEMA,))
        require(database(q, migrations) == 'previous', 'schema did not return to 98')


def set_aside(site, label):
    """Keep the attempt's files for review, out of the way of a later apply."""
    suffix = f'.{label}-{int(time.time())}'
    for path in (site.release.parent, site.backup):
        if path.exists():
            path.rename(path.with_name(path.name + suffix))


def go_back(site, context, label):
    """Previous web, schema 98 and the previous API, in an order that never starts a binary against
    a schema it rejects. The API is down between stop and start."""
    if site.web.resolve() != pathlib.Path(PREVIOUS['web']):
        link = context['link']
        link.symlink_to(PREVIOUS['web'])
        os.replace(link, site.web)
    site.stop()
    unmigrate(site, context['migrations'])
    restored = site.api.with_name(site.api.name + '.previous-facts')
    shutil.copy2(site.backup / 'api.previous', restored)
    require(sha(restored) == PREVIOUS['api_sha256'], 'backup of the previous API changed')
    os.replace(restored, site.api)
    context['staged'].unlink(missing_ok=True)
    site.start()
    health = wait_health(site, PREVIOUS['release'])
    set_aside(site, label)
    return health


def unchanged(site, context):
    require(site.neighbors() == context['baseline']['neighbors'], 'dev GPS or Shield changed during the release')
    require(sha(site.env) == context['baseline']['env'], 'API environment file changed during the release')
    require(processor(site) == context['baseline']['processor'], 'the PDF processor file or its service changed or was restarted during the release')
    require(site.timers_active(), 'a cleanup timer is not active')
    with site.connect(readonly=True) as db, db.cursor() as q:
        q.execute(POLICY)
        require(q.fetchone()[0] == context['policy'], 'collection policies changed during the release')
        q.execute(f'SELECT count(*) FROM {TABLE}')
        require(q.fetchone()[0] >= context['grants'], 'grants disappeared during the release')


def check(site):
    context = preflight(site, 'previous')
    return {'mode': 'check', 'release': RELEASE, 'ready': True, 'found': context['found'],
            'artifact_api_sha256': context['manifest']['api_sha256'], 'artifact_web_sha256': context['manifest']['web_sha256'],
            'existing_grants': context['grants'], 'pdf_processor_service': context['baseline']['processor'],
            'commit': context['manifest']['commit'], 'changes_made': False}


def apply(site):
    os.umask(0o077)
    context = preflight(site, 'previous')
    manifest = context['manifest']
    site.backup.mkdir()
    shutil.copy2(site.api, site.backup / 'api.previous')
    require(sha(site.backup / 'api.previous') == PREVIOUS['api_sha256'], 'backup copy of the API is wrong')
    (site.backup / 'sections_rule.previous.sql').write_text(context['sections_rule'])
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

    staged = context['staged']
    shutil.copy2(site.stage / 'gps-tracker-api', staged)
    staged.chmod(0o755)
    require(sha(staged) == manifest['api_sha256'], 'staged API copy is wrong')

    try:
        migrate(site, context)
    except Exception as failure:
        # Nothing is live yet and the transaction rolled back: just clear the staging.
        staged.unlink()
        set_aside(site, 'not-applied')
        raise Stop(f'the migration did not run and nothing was changed. Cause: {str(failure).strip() or repr(failure)}') from failure

    try:
        os.replace(staged, site.api)
        site.restart()
        health = wait_health(site, RELEASE)
        service = processor(site)  # the restarted API still reaches the same, untouched processor service
    except Exception as failure:
        try:
            go_back(site, context, 'reverted')
        except Exception as second:
            raise Stop(f'NEW RELEASE NOT WORKING AND AUTOMATIC RETURN FAILED. new release: {failure}; return: {second}. Schema and binary need manual repair.') from second
        raise Stop(f'new API did not work; returned to {PREVIOUS["release"]} on schema 98. Cause: {failure}') from failure

    link = context['link']
    link.symlink_to(site.release)
    os.replace(link, site.web)
    require(site.served('/profile') == (site.release / 'index.html').read_bytes(), f'API is on {RELEASE}, but the served page is not the released index')
    for entry in context['entries']:
        require(site.served(entry) == (site.release / entry.lstrip('/')).read_bytes(), f'API is on {RELEASE}, but served asset {entry} differs')
    unchanged(site, context)
    report = {'release': RELEASE, 'commit': manifest['commit'], 'schema': SCHEMA, 'api_sha256': sha(site.api),
              'web': str(site.web.resolve()), 'health': health, 'previous_release': PREVIOUS['release'],
              'backup': str(site.backup), 'existing_grants_kept': context['grants'],
              'pdf_processor_service': {'unchanged_and_not_restarted': True, 'socket': service['socket']['ActiveState'], 'proof': service['proof']['Result']},
              'neighbor_releases_unchanged': True, 'existing_collection_policies_unchanged': True, 'timers_active': True}
    (site.stage / 'deployment.json').write_text(json.dumps(report, indent=2))
    return report


def rollback(site):
    os.umask(0o077)
    context = preflight(site, 'current')
    health = go_back(site, context, 'rolled-back')
    unchanged(site, context)
    report = {'rolled_back_from': RELEASE, 'release': PREVIOUS['release'], 'schema': SCHEMA - 1,
              'api_sha256': sha(site.api), 'web': str(site.web.resolve()), 'health': health,
              'neighbor_releases_unchanged': True, 'existing_collection_policies_unchanged': True}
    (site.stage / 'rollback.json').write_text(json.dumps(report, indent=2))
    return report


def rehearsed(site):
    """Production runs only the exact script, binary and web archive that passed the build-host rehearsal."""
    record = json.loads((site.stage / 'rehearsal.json').read_text())
    manifest = json.loads((site.stage / 'manifest.json').read_text())
    require(record.get('passed') is True and record.get('api_sha256') == manifest['api_sha256']
            and record.get('web_sha256') == manifest['web_sha256']
            and record.get('release_script_sha256') == sha(__file__),
            'this script, binary and web archive have not passed the build-host rehearsal')


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
