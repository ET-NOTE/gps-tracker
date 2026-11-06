"""GPS API runtime account (infrastructure round 1, stage 1).

Run as root on the GPS production host, from the staged directory:

    python3 runtime_account.py check      # read-only: what would change and whether it can
    python3 runtime_account.py apply      # create the account, hand over files, switch the units, verify
    python3 runtime_account.py rollback   # ownership, modes and units as recorded; remove the account

Until now the API and its two cleanup workers ran as the deployment account, which has
passwordless sudo and docker. After `apply` they run as `gps-api`: no login, no sudo, no docker,
no capabilities, no new privileges, and a read-only file system except the two upload
directories. The PDF processor is started by the API, so it runs under the same account and
confinement, inside its own unchanged restrictions. Deployment stays with the previous account.

What is changed: one system account, the owner and mode of the environment file and the FCM key
file, the owner of the two upload trees, and one drop-in each for three units. Not changed: the
unit files themselves, binaries, file contents, the database, the firewall, other accounts and
every other service on the host.

`apply` records what it found first and goes back by itself if anything fails after its first
change. `rollback` uses the same record.
"""
import hashlib
import json
import os
import pathlib
import pwd
import grp
import stat
import subprocess
import sys
import time
import urllib.request

NAME = 'runtime-account-20261106'
ACCOUNT = 'gps-api'
API_UNIT = 'gps-tracker-api.service'
WORKERS = ('gps-privacy-accounts.service', 'gps-privacy-files.service')
DROPIN = '10-runtime-account.conf'
PROBES = ('open_file', 'open_socket', 'start_program', 'start_process', 'too_much_memory', 'too_much_cpu')
# No system call filter is added at this stage: the PDF processor was proven without one above it.
CONFINEMENT = (
    ('UMask', '0077'),
    ('NoNewPrivileges', 'yes'),
    ('CapabilityBoundingSet', ''),
    ('AmbientCapabilities', ''),
    ('PrivateTmp', 'yes'),
    ('ProtectSystem', 'strict'),
    ('ProtectHome', 'read-only'),
    ('ProtectControlGroups', 'yes'),
)


class Stop(Exception):
    """A precondition or verification did not hold."""


def require(condition, message):
    if not condition:
        raise Stop(message)


def run(args, check=True):
    done = subprocess.run(args, capture_output=True, text=True)
    if check and done.returncode:
        raise Stop(f"{' '.join(map(str, args))} failed ({done.returncode}): {done.stderr.strip()[:300]}")
    return done


def sha(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for block in iter(lambda: source.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def config(path):
    return {k.strip(): v.strip().strip('"').strip("'") for k, v in
            (line.split('=', 1) for line in pathlib.Path(path).read_text().splitlines()
             if '=' in line and not line.lstrip().startswith('#'))}


class Site:
    """The production host. The build-host rehearsal substitutes its own addresses and neighbours."""
    environment = 'production'
    previous = 'mmm'  # the deployment account the units run as today
    stage = pathlib.Path('/home/mmm/gps-artifacts') / NAME
    state = pathlib.Path('/home/mmm/backups') / NAME
    api = pathlib.Path('/home/mmm/projects/gps-tracker-api')
    ops = pathlib.Path('/home/mmm/gps-ops')
    units = pathlib.Path('/etc/systemd/system')
    health_urls = ('http://127.0.0.1:3040/gps-tracker/health', 'https://gps.serial.kr/health')
    # Other services on this host. They must be exactly as they were afterwards.
    neighbors = ('gps-tracker.service', 'pm2-mmm.service', 'gps-tracker-api-dev.service', 'shield-api.service',
                 'nginx.service', 'postgresql@14-main.service', 'docker.service')

    @property
    def env(self):
        return self.api / '.env'

    @property
    def binary(self):
        return self.api / 'bin/gps-tracker-api'

    @property
    def renderer(self):
        return self.api / 'bin/gps-pdf-render'

    def paths(self):
        cfg = config(self.env)
        uploads = pathlib.Path(cfg.get('UPLOAD_DIR', '/home/mmm/uploads'))
        private = pathlib.Path(cfg.get('PRIVATE_UPLOAD_DIR', str(uploads.with_name('gps-private-uploads'))))
        fcm = pathlib.Path(cfg['FCM_SERVICE_ACCOUNT_PATH']) if cfg.get('FCM_SERVICE_ACCOUNT_PATH') else None
        return cfg, uploads, private, fcm

    def health(self):
        seen = []
        for url in self.health_urls:
            with urllib.request.urlopen(url, timeout=5) as response:
                seen.append(json.load(response))
        require(all(h.get('ok') and h.get('db') and h.get('environment') == self.environment for h in seen), f'API health is {seen}')
        require(len({h.get('release') for h in seen}) == 1, f'health addresses disagree: {seen}')
        return seen[0]


def show(unit, *properties):
    out = run(['systemctl', 'show', unit, *[f'-p{p}' for p in properties]]).stdout
    return dict(line.split('=', 1) for line in out.splitlines() if '=' in line)


def process(pid):
    """Identity and privileges of a running process, as the kernel reports them."""
    status = dict(line.split(':', 1) for line in pathlib.Path(f'/proc/{pid}/status').read_text().splitlines() if ':' in line)
    uid, gid = int(status['Uid'].split()[0]), int(status['Gid'].split()[0])
    return {'user': pwd.getpwuid(uid).pw_name, 'group': grp.getgrgid(gid).gr_name,
            'supplementary_groups': sorted(grp.getgrgid(int(g)).gr_name for g in status['Groups'].split() if int(g) != gid),
            'no_new_privileges': int(status['NoNewPrivs']) == 1,
            'capabilities': {k: int(status[k], 16) for k in ('CapEff', 'CapPrm', 'CapBnd', 'CapAmb')},
            'system_call_filter': int(status['Seccomp']) != 0}


def entry(path):
    info = os.lstat(path)
    return [info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)]


def tree(root):
    """Every entry under root, relative path -> [uid, gid, mode]. Symbolic links are refused."""
    found = {'.': entry(root)}
    for directory, names, files in os.walk(root):
        for name in names + files:
            path = os.path.join(directory, name)
            require(not os.path.islink(path), f'{path} is a symbolic link; the upload trees must not contain any')
            found[os.path.relpath(path, root)] = entry(path)
    return found


def dropin(site, unit):
    return site.units / f'{unit}.d' / DROPIN


def dropin_text(site, unit, uploads, private):
    lines = ['# Written by ops/runtime_account.py. Remove with `runtime_account.py rollback`.', '[Service]',
             f'User={ACCOUNT}', f'Group={ACCOUNT}', 'SupplementaryGroups=']
    if unit == API_UNIT:
        lines += [f'{key}={value}' for key, value in CONFINEMENT] + [f'ReadWritePaths={uploads} {private}']
    return '\n'.join(lines) + '\n'


def neighbors(site):
    return {unit: show(unit, 'MainPID', 'ActiveEnterTimestamp', 'User', 'ActiveState') for unit in site.neighbors}


def survey(site):
    """Everything this change depends on or touches, read only."""
    require(os.geteuid() == 0, 'run as root')
    require(int(run(['systemctl', '--version']).stdout.split()[1]) >= 245, 'systemd is older than this procedure was rehearsed with')
    cfg, uploads, private, fcm = site.paths()
    users = {}
    for unit in (API_UNIT, *WORKERS):
        shown = show(unit, 'User', 'Group', 'LoadState', 'FragmentPath', 'MainPID', 'ActiveState', 'DropInPaths')
        require(shown.get('LoadState') == 'loaded', f'{unit} is not loaded')
        users[unit] = shown
    require(users[API_UNIT]['ActiveState'] == 'active' and int(users[API_UNIT]['MainPID']) > 0, 'the API is not running')
    # The workers get no new writable paths: their units must already name the same directories.
    writable = show('gps-privacy-files.service', 'ReadWritePaths').get('ReadWritePaths', '').split()
    require(set(writable) == {str(uploads), str(private)}, f'the file cleanup unit writes to {writable}, not to the API upload directories')
    database = cfg.get('DATABASE_URL', '')
    require('://' in database and '@' in database and 'host=/' not in database and '@/' not in database,
            'DATABASE_URL does not name a TCP host: the connection would depend on the operating system account')
    port = int(cfg.get('BIND_ADDR', '127.0.0.1:3040').rsplit(':', 1)[1])
    require(port >= 1024, f'the API binds port {port}, which needs a capability')
    for path in (site.env, site.binary, site.renderer, uploads, private, site.ops / 'privacy_account_closure.py',
                 site.ops / 'privacy_file_cleanup.py', *([fcm] if fcm else [])):
        require(path.exists(), f'{path} is missing')
        for parent in path.parents:
            require(parent.stat().st_mode & 0o001, f'{parent} cannot be traversed by another account, so {path} would be unreachable')
    for path in (site.binary, site.renderer, site.ops / 'privacy_account_closure.py', site.ops / 'privacy_file_cleanup.py'):
        info = path.stat()
        require(info.st_uid == 0 and not info.st_mode & 0o022 and info.st_mode & 0o004, f'{path} must be owned by root, readable by all and writable by root only')
    return {'config': cfg, 'uploads': uploads, 'private': private, 'fcm': fcm, 'units': users,
            'process': process(users[API_UNIT]['MainPID']), 'health': site.health(),
            'trees': {str(root): tree(root) for root in (uploads, private)},
            'files': {str(path): entry(path) for path in (site.env, *([fcm] if fcm else []))},
            'content': {str(path): sha(path) for path in (site.env, site.binary, site.renderer, *([fcm] if fcm else []),
                                                           *[pathlib.Path(users[u]['FragmentPath']) for u in users])},
            'neighbors': neighbors(site)}


def exists(name):
    try:
        pwd.getpwnam(name)
        return True
    except KeyError:
        pass
    try:
        grp.getgrnam(name)
        return True
    except KeyError:
        return False


def preflight(site, want):
    found = survey(site)
    previous = pwd.getpwnam(site.previous)
    applied = [unit for unit in found['units'] if dropin(site, unit).exists()]
    if want == 'previous':
        require(not exists(ACCOUNT), f'an account or group named {ACCOUNT} already exists; an earlier attempt needs review')
        require(not applied and not site.state.exists(), f'an earlier attempt left {applied or site.state}; review it first')
        for unit, shown in found['units'].items():
            require(shown['User'] == site.previous, f'{unit} runs as {shown["User"]!r}, not as {site.previous}')
        require(found['process']['user'] == site.previous, f'the API process runs as {found["process"]["user"]}')
        owners = {(uid, gid) for entries in found['trees'].values() for uid, gid, _ in entries.values()}
        require(owners == {(previous.pw_uid, previous.pw_gid)}, f'the upload trees hold entries of other owners: {sorted(owners)}')
        for path, (uid, gid, mode) in found['files'].items():
            require(uid == previous.pw_uid and not mode & 0o077, f'{path} is not a private file of {site.previous} (owner {uid}, mode {mode:o})')
    else:
        require(len(applied) == len(found['units']) and exists(ACCOUNT) and (site.state / 'record.json').is_file(),
                'the host is not in the state `apply` leaves; nothing to roll back')
        for unit, shown in found['units'].items():
            require(shown['User'] == ACCOUNT, f'{unit} runs as {shown["User"]!r}, not as {ACCOUNT}')
    return found


def wait_health(site, seconds=45):
    last = None
    for _ in range(seconds):
        try:
            return site.health()
        except Exception as error:  # still starting
            last = repr(error)
        time.sleep(1)
    raise Stop(f'the API did not become healthy: {last}')


def as_account(*command):
    """Exit status of a command run as the runtime account, with nothing inherited."""
    return subprocess.run(['runuser', '-u', ACCOUNT, '--', *command], capture_output=True, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'}, cwd='/').returncode


def selftest(command):
    done = subprocess.run(command, capture_output=True, timeout=120, cwd='/', env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'})
    try:
        report = json.loads(done.stdout)
    except ValueError:
        raise Stop(f'PDF processor self-test gave no report (exit {done.returncode}): {done.stderr.decode(errors="replace")[:300]}') from None
    passed = (done.returncode == 0 and report.get('sandbox_holds') is True and report.get('renders_inside_sandbox') is True
              and all(report.get(probe, {}).get('blocked') is True for probe in PROBES))
    require(passed, f'PDF processor self-test failed: {done.stdout.decode(errors="replace")[:300]}')
    return {probe: report[probe]['how'] for probe in PROBES}


def verify(site, found):
    """The units really run as the new account, it can do what it must and nothing more."""
    health = wait_health(site)
    require(health.get('release') == found['health'].get('release'), f'the API reports another release: {health}')
    uploads, private, fcm = found['uploads'], found['private'], found['fcm']
    shown = show(API_UNIT, 'MainPID', 'User', 'NRestarts')
    seen = process(shown['MainPID'])
    require(shown['User'] == ACCOUNT and seen['user'] == ACCOUNT and seen['group'] == ACCOUNT and not seen['supplementary_groups'],
            f'the API process is {seen}')
    require(seen['no_new_privileges'] and not any(seen['capabilities'].values()), f'the API process kept privileges: {seen}')
    require(not seen['system_call_filter'], 'the API process has a system call filter that this stage did not intend')
    account = pwd.getpwnam(ACCOUNT)
    groups = sorted(g.gr_name for g in grp.getgrall() if ACCOUNT in g.gr_mem)
    require(not groups and account.pw_shell.endswith('nologin'), f'{ACCOUNT} has groups {groups} or a login shell {account.pw_shell}')
    # What it must be able to do.
    for test, path in [('-r', site.env), ('-x', site.binary), ('-x', site.renderer), ('-w', uploads), ('-w', private),
                       ('-r', site.ops / 'privacy_account_closure.py'), *([('-r', fcm)] if fcm else [])]:
        require(as_account('test', test, str(path)) == 0, f'{ACCOUNT} cannot use {path} ({test})')
    # What it must not be able to do.
    require(as_account('sudo', '-n', 'true') != 0, f'{ACCOUNT} can use sudo')
    refused = [('-w', site.env), ('-w', site.binary), ('-w', site.binary.parent), ('-w', site.api), ('-r', '/etc/sudoers'),
               ('-w', '/var/run/docker.sock'), ('-r', pathlib.Path('/home') / site.previous / '.ssh'), ('-w', site.ops),
               *[('-r', path) for path in sorted(site.api.glob('.env.*'))], *([('-w', fcm)] if fcm else [])]
    for test, path in refused:
        require(as_account('test', test, str(path)) != 0, f'{ACCOUNT} can use {path} ({test})')
    # The PDF processor, as the account and inside the same confinement as the API unit.
    plain = selftest(['runuser', '-u', ACCOUNT, '--', 'env', '-i', str(site.renderer), 'selftest'])
    properties = [f'--property={key}={value}' for key, value in (('User', ACCOUNT), ('Group', ACCOUNT), *CONFINEMENT)]
    confined = selftest(['systemd-run', '--wait', '--pipe', '--collect', '--quiet', *properties,
                         f'--property=ReadWritePaths={uploads} {private}', '/usr/bin/env', '-i', str(site.renderer), 'selftest'])
    # The cleanup workers, once each, as the timers start them.
    workers = {}
    for unit in WORKERS:
        run(['systemctl', 'start', unit])
        result = show(unit, 'Result', 'ExecMainStatus', 'User')
        require(result == {'Result': 'success', 'ExecMainStatus': '0', 'User': ACCOUNT}, f'{unit} ended with {result}')
        workers[unit] = 'success'
    return {'health': health, 'api_process': seen, 'api_restarts': int(shown['NRestarts']),
            'account': {'uid': account.pw_uid, 'shell': account.pw_shell, 'home': account.pw_dir, 'groups': groups},
            'refused': [f'{test} {path}' for test, path in refused] + ['sudo -n true'],
            'pdf_processor_self_test': {'as_account': plain, 'inside_unit_confinement': confined}, 'workers': workers}


def untouched(site, found):
    require(neighbors(site) == found['neighbors'], 'another service on the host changed during this work')
    for path, digest in found['content'].items():
        require(sha(path) == digest, f'the content of {path} changed')


def restore(site, record):
    """Units, ownership and modes back to the record; then the account, if this procedure made it."""
    previous = pwd.getpwnam(site.previous)
    for unit in record['units']:
        path = dropin(site, unit)
        path.unlink(missing_ok=True)
        if path.parent.is_dir() and str(path.parent) in record['created_directories'] and not any(path.parent.iterdir()):
            path.parent.rmdir()
    run(['systemctl', 'daemon-reload'])
    for path, (uid, gid, mode) in record['files'].items():
        os.chown(path, uid, gid)
        os.chmod(path, mode)
    for root, entries in record['trees'].items():
        for relative, (uid, gid, mode) in tree(root).items():
            # Entries created since belong to the previous account, like everything else there.
            old = entries.get(relative, [previous.pw_uid, previous.pw_gid, mode])
            path = os.path.join(root, relative)
            os.lchown(path, old[0], old[1])
            os.chmod(path, old[2])
    if record['units_switched']:
        # The API was restarted under the new account: start it again under the previous one.
        run(['systemctl', 'restart', API_UNIT])
    health = wait_health(site)
    seen = process(show(API_UNIT, 'MainPID')['MainPID'])
    require(seen['user'] == site.previous, f'after going back the API runs as {seen["user"]}')
    if record['units_switched']:
        for unit in WORKERS:
            run(['systemctl', 'start', unit])
            require(show(unit, 'Result')['Result'] == 'success', f'{unit} failed after going back')
    if record['created_account'] and exists(ACCOUNT):
        run(['userdel', ACCOUNT])
        require(not exists(ACCOUNT), f'{ACCOUNT} could not be removed')
    return health


def check(site):
    found = preflight(site, 'previous')
    uploads, private, fcm = found['uploads'], found['private'], found['fcm']
    return {'mode': 'check', 'ready': True, 'changes_made': False, 'release': found['health'].get('release'),
            'now': {'units_run_as': {unit: shown['User'] for unit, shown in found['units'].items()}, 'api_process': found['process'],
                    'files': {path: f'{pwd.getpwuid(uid).pw_name}:{grp.getgrgid(gid).gr_name} {mode:o}' for path, (uid, gid, mode) in found['files'].items()},
                    'upload_entries': {root: len(entries) for root, entries in found['trees'].items()}},
            'would_change': {'account': f'create {ACCOUNT} (system account, no login, no home, no groups)',
                             'files': {path: f'root:{ACCOUNT} 640' for path in found['files']},
                             'upload_trees': {root: f'owner {ACCOUNT}:{ACCOUNT}, modes kept' for root in found['trees']},
                             'drop_ins': {unit: dropin_text(site, unit, uploads, private).splitlines()[2:] for unit in found['units']},
                             'restart': API_UNIT},
            'not_changed': ['unit files', 'binaries', 'file contents', 'database', 'firewall', 'other accounts', *site.neighbors]}


def apply(site):
    os.umask(0o077)
    found = preflight(site, 'previous')
    uploads, private = found['uploads'], found['private']
    record = {'name': NAME, 'taken_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'previous_account': site.previous,
              'units': {unit: {'User': shown['User'], 'Group': shown['Group']} for unit, shown in found['units'].items()},
              'files': found['files'], 'trees': found['trees'], 'created_account': False, 'units_switched': False,
              'created_directories': [str(dropin(site, unit).parent) for unit in found['units'] if not dropin(site, unit).parent.exists()]}
    site.state.mkdir()
    (site.state / 'record.json').write_text(json.dumps(record, indent=1))
    try:
        run(['useradd', '--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent',
             '--shell', '/usr/sbin/nologin', '--comment', 'GPS API runtime account', ACCOUNT])
        record['created_account'] = True
        (site.state / 'record.json').write_text(json.dumps(record, indent=1))
        account = pwd.getpwnam(ACCOUNT)
        # Configuration: readable by the runtime account, changeable only by root.
        for path in found['files']:
            os.chown(path, 0, account.pw_gid)
            os.chmod(path, 0o640)
        # Data: owned by the runtime account, modes as they were.
        for root, entries in found['trees'].items():
            for relative in entries:
                os.lchown(os.path.join(root, relative), account.pw_uid, account.pw_gid)
        record['units_switched'] = True
        (site.state / 'record.json').write_text(json.dumps(record, indent=1))
        for unit in found['units']:
            path = dropin(site, unit)
            path.parent.mkdir(mode=0o755, exist_ok=True)
            path.write_text(dropin_text(site, unit, uploads, private))
            path.chmod(0o644)
        run(['systemctl', 'daemon-reload'])
        for unit in found['units']:
            require(show(unit, 'User')['User'] == ACCOUNT, f'the drop-in for {unit} is not in effect')
        run(['systemctl', 'restart', API_UNIT])
        verified = verify(site, found)
        untouched(site, found)
    except Exception as failure:
        try:
            restore(site, record)
            untouched(site, found)
            (site.state).rename(site.state.with_name(site.state.name + f'.reverted-{int(time.time())}'))
        except Exception as second:
            raise Stop(f'THE CHANGE FAILED AND THE AUTOMATIC RETURN FAILED TOO. change: {failure}; return: {second}. '
                       f'The record is in {site.state}; units and ownership need manual repair.') from second
        raise Stop(f'the change did not verify; everything was put back as recorded. Cause: {failure}') from failure
    report = {'mode': 'apply', 'name': NAME, 'account': ACCOUNT, 'previous_account': site.previous, **verified,
              'files': {path: f'root:{ACCOUNT} 640' for path in found['files']},
              'upload_trees': {root: len(entries) for root, entries in found['trees'].items()},
              'drop_ins': [str(dropin(site, unit)) for unit in found['units']],
              'record': str(site.state / 'record.json'), 'other_services_unchanged': True, 'file_contents_unchanged': True}
    (site.stage / 'runtime-account.json').write_text(json.dumps(report, indent=2))
    return report


def rollback(site):
    os.umask(0o077)
    found = preflight(site, 'applied')
    record = json.loads((site.state / 'record.json').read_text())
    health = restore(site, record)
    untouched(site, found)
    after = survey(site)
    require(after['files'] == record['files'], 'configuration files did not return to the recorded owner and mode')
    for root, entries in record['trees'].items():
        now = after['trees'][root]
        # Entries removed since by normal operation are simply gone; everything still there must match.
        require(all(now[relative] == value for relative, value in entries.items() if relative in now), f'{root} did not return to the recorded ownership')
        require(all(uid == entries['.'][0] for uid, _, _ in now.values()), f'{root} still holds entries of another owner')
    site.state.rename(site.state.with_name(site.state.name + f'.rolled-back-{int(time.time())}'))
    report = {'mode': 'rollback', 'name': NAME, 'health': health, 'units_run_as': {unit: shown['User'] for unit, shown in after['units'].items()},
              'api_process': after['process'], 'account_removed': not exists(ACCOUNT), 'ownership_as_recorded': True,
              'other_services_unchanged': True}
    (site.stage / 'runtime-account-rollback.json').write_text(json.dumps(report, indent=2))
    return report


def rehearsed(site):
    """Production runs only the exact script that passed the build-host rehearsal."""
    record = json.loads((site.stage / 'rehearsal.json').read_text())
    require(record.get('passed') is True and record.get('script_sha256') == sha(__file__),
            'this script has not passed the build-host rehearsal')


def main():
    modes = {'check': check, 'apply': apply, 'rollback': rollback}
    if len(sys.argv) != 2 or sys.argv[1] not in modes:
        sys.exit(__doc__)
    try:
        site = Site()
        rehearsed(site)
        print(json.dumps(modes[sys.argv[1]](site), indent=2, default=str))
    except Stop as stop:
        sys.exit(f'STOPPED: {stop}')


if __name__ == '__main__':
    main()
