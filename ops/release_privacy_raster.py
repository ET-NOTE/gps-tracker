"""GPS release privacy-raster-20261106-r1 (round 15): schema 96 -> 97, then API and web.

Run as root on the GPS production host, from the staged artifact directory:

    python3 release_privacy_raster.py check      # read-only preflight; changes nothing
    python3 release_privacy_raster.py apply      # preflight, migrate, swap API and web, verify
    python3 release_privacy_raster.py rollback   # back to the previous release (see below)

Pinned to one transition. The running release must be privacy-receipts-20261106-r1 with
migrations 1..96 exactly as built; anything else stops before the first change.

Migration 0097 only adds nullable columns, but the API refuses to start when the database
holds a migration its binary does not know. Going back therefore removes 0097 as well as
restoring the binary, and is allowed only while no row uses the new columns. After that,
repair forward. `apply` goes back by itself when the new API does not become healthy.
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

RELEASE = 'privacy-raster-20261106-r1'
SCHEMA = 97
PREVIOUS = {
    'release': 'privacy-receipts-20261106-r1',
    'api_sha256': '65abe14ca7e8acd246a8aa5447f357da3a5956e99f2be202a4b9861841185b04',
    'web': '/home/mmm/releases/privacy-receipts-20261106-r1/web',
}
# What the build host must have verified for this exact binary.
EXPECTED = {
    'scaling_groups': 9, 'receipt_groups': 7, 'image_groups': 8, 'redacted_groups': 8,
    'company_task_groups': 10, 'sections_groups': 5, 'package_groups': 9, 'company_groups': 10,
    'delivery_groups': 11, 'closure_groups': 12, 'schema': SCHEMA, 'rust_passed': 58,
    'fmt_clippy_passed': True, 'web_build_passed': True,
}
NEW_COLUMNS = [
    ('privacy_receipt_reads', 'pixels_sha256'),
    ('privacy_receipt_reads', 'normalization'),
    ('privacy_image_deliveries', 'source_normalization'),
]
IN_USE = ("SELECT (SELECT count(*) FROM privacy_receipt_reads WHERE pixels_sha256 IS NOT NULL OR normalization IS NOT NULL)"
          " + (SELECT count(*) FROM privacy_image_deliveries WHERE source_normalization IS NOT NULL)")
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
    require(manifest['web_sha256'] == sha(stage / 'web.tar.gz'), 'web archive differs from the manifest')
    require(manifest['source_sha256'] == sha(stage / 'source.tar.gz'), 'source archive differs from the manifest')
    for name, digest in manifest['ops_files'].items():
        require(sha(stage / name) == digest, f'{name} differs from the manifest')
    require(sha(__file__) == manifest['ops_files']['release_privacy_raster.py'], 'this is not the staged release script')

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
    require(set(migrations) == set(range(1, SCHEMA + 1)), 'source archive must hold migrations 1..97 exactly')
    return manifest, migrations, index, entries


def checksum(data):
    return hashlib.sha384(data).hexdigest()  # what SQLx stores for a migration file


def database(q, migrations):
    """'previous' (1..96 as built, no new column) or 'current' (1..97, all new columns)."""
    q.execute("SELECT version,encode(checksum,'hex'),success FROM _sqlx_migrations ORDER BY version")
    rows = q.fetchall()
    require(all(success for _, _, success in rows), 'a recorded migration is marked failed')
    applied = {version: digest for version, digest, _ in rows}
    q.execute("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() AND (table_name,column_name) IN %s", (tuple(NEW_COLUMNS),))
    columns = set(q.fetchall())
    built = {version: checksum(data) for version, data in migrations.items()}
    if applied == {v: c for v, c in built.items() if v < SCHEMA} and not columns:
        return 'previous'
    if applied == built and columns == set(NEW_COLUMNS):
        return 'current'
    different = sorted(v for v in set(applied) | set(built) if applied.get(v) != built.get(v))
    raise Stop(f'database is in neither expected state: migrations differing {different}, new columns present {sorted(columns)}')


def preflight(site, want):
    site.require_root()
    manifest, migrations, index, entries = artifacts(site)
    require(shutil.disk_usage(site.stage).free > 1024 ** 3 and shutil.disk_usage(site.api.parent).free > 1024 ** 3, 'less than 1 GiB free')
    with site.connect(readonly=True) as db, db.cursor() as q:
        state = database(q, migrations)
        q.execute(POLICY)
        policy = q.fetchone()[0]
        in_use = None
        if state == 'current':
            q.execute(IN_USE)
            in_use = q.fetchone()[0]
    health = site.health()
    require(health.get('ok') and health.get('db') and health.get('environment') == site.environment, f'API health is {health}')
    found = {'database': state, 'health_release': health.get('release'), 'api_sha256': sha(site.api), 'web': str(site.web.resolve())}
    staged, link = site.api.with_name(site.api.name + '.next-raster'), site.web.with_name(site.web.name + '.next-raster')
    if want == 'previous':
        expected = {'database': 'previous', 'health_release': PREVIOUS['release'], 'api_sha256': PREVIOUS['api_sha256'], 'web': PREVIOUS['web']}
        require(found == expected, f'host is not on the previous release: {found}')
        for leftover in (staged, link, site.release.parent, site.backup):
            require(not leftover.exists() and not leftover.is_symlink(), f'{leftover} already exists; an earlier attempt needs review')
    else:
        expected = {'database': 'current', 'health_release': RELEASE, 'api_sha256': manifest['api_sha256'], 'web': str(site.release)}
        require(found == expected, f'host is not on this release: {found}')
        require(sha(site.backup / 'api.previous') == PREVIOUS['api_sha256'], 'backup of the previous API is missing or different')
        require(in_use == 0, f'{in_use} rows already use the new columns; repair forward instead of going back')
    return {'manifest': manifest, 'migrations': migrations, 'index': index, 'entries': entries, 'policy': policy,
            'found': found, 'staged': staged, 'link': link,
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


def migrate(site, migrations):
    """One transaction: the state is re-checked under lock, 0097 runs, and SQLx is told so."""
    with site.connect() as db, db.cursor() as q:
        q.execute("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'")
        q.execute("LOCK TABLE _sqlx_migrations IN SHARE ROW EXCLUSIVE MODE")
        require(database(q, migrations) == 'previous', 'database changed since the preflight')
        q.execute(migrations[SCHEMA].decode())
        q.execute("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(%s,'privacy receipt normalization',true,%s,0)",
                  (SCHEMA, bytes.fromhex(checksum(migrations[SCHEMA]))))
        require(database(q, migrations) == 'current', 'migration did not produce the expected schema')
        q.execute(IN_USE)
        require(q.fetchone()[0] == 0, 'new columns are not empty')


def unmigrate(site, migrations):
    """Remove 0097 again. Refuses once any row uses the new columns."""
    with site.connect() as db, db.cursor() as q:
        q.execute("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'")
        q.execute("LOCK TABLE _sqlx_migrations,privacy_receipt_reads,privacy_image_deliveries IN SHARE ROW EXCLUSIVE MODE")
        require(database(q, migrations) == 'current', 'database is not on schema 97')
        q.execute(IN_USE)
        in_use = q.fetchone()[0]
        require(in_use == 0, f'{in_use} rows already use the new columns; repair forward instead of going back')
        q.execute("ALTER TABLE privacy_receipt_reads DROP COLUMN pixels_sha256, DROP COLUMN normalization")
        q.execute("ALTER TABLE privacy_image_deliveries DROP COLUMN source_normalization")
        q.execute("DELETE FROM _sqlx_migrations WHERE version=%s", (SCHEMA,))
        require(database(q, migrations) == 'previous', 'schema did not return to 96')


def set_aside(site, label):
    """Keep the attempt's files for review, out of the way of a later apply."""
    suffix = f'.{label}-{int(time.time())}'
    for path in (site.release.parent, site.backup):
        if path.exists():
            path.rename(path.with_name(path.name + suffix))


def go_back(site, context, label):
    """Previous web, schema 96 and the previous API, in an order that never starts a binary
    against a schema it rejects. The API is down between stop and start."""
    if site.web.resolve() != pathlib.Path(PREVIOUS['web']):
        link = context['link']
        link.symlink_to(PREVIOUS['web'])
        os.replace(link, site.web)
    site.stop()
    unmigrate(site, context['migrations'])
    restored = site.api.with_name(site.api.name + '.previous-raster')
    shutil.copy2(site.backup / 'api.previous', restored)
    require(sha(restored) == PREVIOUS['api_sha256'], 'backup of the previous API changed')
    os.replace(restored, site.api)
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


def check(site):
    context = preflight(site, 'previous')
    return {'mode': 'check', 'release': RELEASE, 'ready': True, 'found': context['found'],
            'artifact_api_sha256': context['manifest']['api_sha256'], 'commit': context['manifest']['commit'],
            'changes_made': False}


def apply(site):
    os.umask(0o077)
    context = preflight(site, 'previous')
    manifest, migrations = context['manifest'], context['migrations']
    site.backup.mkdir()
    shutil.copy2(site.api, site.backup / 'api.previous')
    require(sha(site.backup / 'api.previous') == PREVIOUS['api_sha256'], 'backup copy of the API is wrong')
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
        migrate(site, migrations)
    except Exception:
        # Nothing is live yet and the transaction rolled back: just clear the staging.
        staged.unlink()
        set_aside(site, 'not-applied')
        raise

    os.replace(staged, site.api)
    try:
        site.restart()
        health = wait_health(site, RELEASE)
    except Exception as failure:
        try:
            go_back(site, context, 'reverted')
        except Exception as second:
            raise Stop(f'NEW API UNHEALTHY AND AUTOMATIC RETURN FAILED. new API: {failure}; return: {second}. Schema and binary need manual repair.') from second
        raise Stop(f'new API did not become healthy; returned to {PREVIOUS["release"]} on schema 96. Cause: {failure}') from failure

    link = context['link']
    link.symlink_to(site.release)
    os.replace(link, site.web)
    require(site.served('/profile') == (site.release / 'index.html').read_bytes(), f'API is on {RELEASE}, but the served page is not the released index')
    for entry in context['entries']:
        require(site.served(entry) == (site.release / entry.lstrip('/')).read_bytes(), f'API is on {RELEASE}, but served asset {entry} differs')
    unchanged(site, context)
    report = {'release': RELEASE, 'commit': manifest['commit'], 'schema': SCHEMA, 'api_sha256': sha(site.api),
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
              'api_sha256': sha(site.api), 'web': str(site.web.resolve()), 'health': health,
              'neighbor_releases_unchanged': True, 'existing_collection_policies_unchanged': True}
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
