"""Isolated rehearsal of ops/gps_watch.py and ops/install_gps_watch.sh. Contacts nothing outside
this machine and sends no real mail.

    python3 rehearse_gps_watch.py [record.json]

Stand-ins on 127.0.0.1: the watched host (health, ingest address, status page, SSH port), the
reference addresses, the status page's push address and a mail server that speaks STARTTLS,
implicit TLS and authentication. The watch's real code runs against them; only the clock is
moved forward so that an hour takes no time. The installer runs with a throwaway home directory
and stand-ins for `systemctl` and `loginctl`, so the real service manager is not touched.
"""
import base64
import email
import email.policy
import fcntl
import http.server
import importlib.util
import json
import os
import pathlib
import shutil
import socketserver
import ssl
import subprocess
import sys
import tempfile
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
PASSWORD = 'REHEARSAL-PASSWORD-9b1c'
TOKEN = 'REHEARSALTOKEN7f3a'
SLOW = 2.5  # seconds a "slow" stand-in waits; the watch's timeout here is 1 s


def load(path):
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


watch = load(HERE / 'gps_watch.py')


def require(condition, message):
    if not condition:
        sys.exit(f'STOPPED: {message}')


class Target(http.server.BaseHTTPRequestHandler):
    """The watched host, the reference address and the status page's push address in one."""

    def log_message(self, *args):
        pass

    def answer(self, status, body=b'', headers=()):
        self.send_response(status)
        for key, value in headers:
            self.send_header(key, value)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split('?')[0]
        kind = {'/health': 'health', '/ingest': 'ingest', '/': 'status', '/reference': 'reference'}.get(path, 'push' if path.startswith('/api/push/') else '')
        how = self.server.mode.get(kind, 'ok')
        if how == 'drop':  # the connection ends without an answer
            return
        if how == 'slow':
            time.sleep(SLOW)
        if how not in ('ok', 'slow'):
            if how.isdigit():
                return self.answer(int(how), b'upstream failed')
            if kind == 'health':
                body = {'db': {'db': False, 'ok': False, 'environment': 'production'}, 'env': {'db': True, 'ok': True, 'environment': 'test'}}.get(how)
                return self.answer(200, json.dumps(body).encode() if body else b'<html>front page</html>')
            return self.answer(200, b'<html>front page</html>')  # e.g. the web front page instead of the API
        if kind == 'health':
            self.answer(200, json.dumps({'db': True, 'environment': 'production', 'ok': True, 'release': 'rehearsal-r1', 'service': 'gps-tracker-api'}).encode(),
                        [('Content-Type', 'application/json')])
        elif kind == 'ingest':
            self.answer(405, b'', [('Allow', 'POST')])
        elif kind == 'status':
            self.answer(302, b'', [('Location', '/dashboard')])
        elif kind == 'reference':
            self.answer(204)
        elif kind == 'push':
            self.server.pushes.append(self.path)
            self.answer(200, b'{"ok":true}')
        else:
            self.answer(404)


class Ssh(socketserver.BaseRequestHandler):
    def handle(self):
        how = self.server.mode.get('ssh', 'ok')
        if how == 'slow':
            time.sleep(SLOW)
        elif how != 'drop':
            self.request.sendall(b'SSH-2.0-rehearsal\r\n' if how == 'ok' else b'HTTP/1.1 400 Bad Request\r\n')


class Mail(socketserver.BaseRequestHandler):
    """Just enough ESMTP: EHLO, STARTTLS, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA, QUIT."""

    def handle(self):
        box = self.server
        if box.fail == 'refuse':
            return
        sock, secure = self.request, False
        if box.tls == 'ssl':
            sock, secure = box.context.wrap_socket(sock, server_side=True), True
        lines, authed = sock.makefile('rb'), False

        def say(*replies):
            sock.sendall(''.join(reply + '\r\n' for reply in replies).encode())

        say('220 rehearsal ESMTP')
        while True:
            line = lines.readline()
            if not line:
                return
            words = line.decode(errors='replace').strip().split(' ')
            verb = words[0].upper()
            if verb in ('EHLO', 'HELO'):
                say('250-rehearsal', *(['250-STARTTLS'] if box.tls == 'starttls' and not secure else []), '250 AUTH PLAIN LOGIN')
            elif verb == 'STARTTLS':
                say('220 go ahead')
                sock, secure = box.context.wrap_socket(sock, server_side=True), True
                lines = sock.makefile('rb')
            elif verb == 'AUTH':
                if not secure and box.tls != 'none':
                    say('530 Must issue a STARTTLS command first')
                    continue
                if words[1].upper() == 'PLAIN':
                    if len(words) < 3:
                        say('334 ')
                    blob = words[2] if len(words) > 2 else lines.readline().decode().strip()
                    _, user, password = base64.b64decode(blob).decode().split('\0')
                else:
                    say('334 VXNlcm5hbWU6')
                    user = base64.b64decode(lines.readline()).decode()
                    say('334 UGFzc3dvcmQ6')
                    password = base64.b64decode(lines.readline()).decode()
                authed = box.fail != 'auth' and (user, password) == (box.username, PASSWORD)
                say('235 ok' if authed else '535 authentication failed')
            elif verb == 'MAIL':
                say('250 ok' if authed else '530 Authentication required')
            elif verb == 'RCPT':
                say('250 ok')
            elif verb == 'DATA':
                if box.fail == 'data':
                    say('451 try again later')
                    continue
                say('354 end with a dot')
                data = []
                while True:
                    row = lines.readline()
                    if row in (b'.\r\n', b'.\n', b''):
                        break
                    data.append(row[1:] if row.startswith(b'..') else row)
                message = email.message_from_bytes(b''.join(data), policy=email.policy.default)
                box.messages.append({'subject': message['Subject'], 'from': message['From'], 'to': message['To'],
                                     'body': message.get_content(), 'encrypted': secure, 'authenticated': authed, 'transport': box.tls})
                say('250 queued')
            elif verb in ('RSET', 'NOOP'):
                say('250 ok')
            elif verb == 'QUIT':
                say('221 bye')
                return
            else:
                say('502 not implemented')


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address, daemon_threads = True, True

    def handle_error(self, request, client_address):
        pass  # a client that gave up waiting is part of the rehearsal


class Web(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass


class Lab:
    def __init__(self, base):
        self.base, self.mode, self.clock, self.lines, self.round = base, {}, 1_794_000_000.0, [], 0
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(base / 'key.pem'), '-out', str(base / 'cert.pem'),
                        '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], check=True, capture_output=True)
        self.target = Web(('127.0.0.1', 0), Target)
        self.target.mode, self.target.pushes = self.mode, []
        self.ssh = Server(('127.0.0.1', 0), Ssh)
        self.ssh.mode = self.mode
        self.mail = Server(('127.0.0.1', 0), Mail)
        self.mail.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.mail.context.load_cert_chain(base / 'cert.pem', base / 'key.pem')
        self.mail.messages, self.mail.fail, self.mail.tls, self.mail.username = [], None, 'starttls', 'watch@example.invalid'
        for server in (self.target, self.ssh, self.mail):
            threading.Thread(target=server.serve_forever, daemon=True).start()

    def reset(self, security='starttls', host='127.0.0.1'):
        """A watch that has never run, a healthy host, an empty mailbox."""
        self.round += 1
        self.mode.clear()
        self.mail.messages.clear()
        self.target.pushes.clear()
        self.mail.fail, self.mail.tls = None, security
        self.state = self.base / f'state-{self.round}'
        http_base = f'http://127.0.0.1:{self.target.server_address[1]}'
        self.config = self.base / f'config-{self.round}.ini'
        self.config.write_text(f'''[watch]
state_dir = {self.state}
timeout_seconds = 1
[checks]
health = {http_base}/health
ingest = {http_base}/ingest
ssh = 127.0.0.1:{self.ssh.server_address[1]}
status = {http_base}/
references = {http_base}/reference
[mail]
host = {host}
port = {self.mail.server_address[1]}
security = {security}
username = {self.mail.username}
password = {PASSWORD}
from = watch@example.invalid
to = operator@example.invalid
ca_file = {self.base / 'cert.pem'}
[heartbeat]
url = {http_base}/api/push/{TOKEN}?status=up&msg=OK&ping=
''')
        self.config.chmod(0o600)

    def tick(self, count=1, **modes):
        """`count` cycles a minute apart with the stand-ins in the given modes (everything else healthy)."""
        self.mode.clear()
        self.mode.update(modes)
        done = []
        for _ in range(count):
            self.clock += 60
            done.append(watch.cycle(watch.load(self.config), now=self.clock))
            self.lines.append(done[-1]['line'])
        self.mode.clear()
        return done

    def later(self, minutes):
        self.clock += 60 * minutes

    def subjects(self):
        return [message['subject'] for message in self.mail.messages]

    def saved(self):
        return json.loads((self.state / 'state.json').read_text())


def main():
    record = {'passed': False, 'script_sha256': None, 'python': sys.version.split()[0], 'steps': []}
    import hashlib
    record['script_sha256'] = hashlib.sha256((HERE / 'gps_watch.py').read_bytes()).hexdigest()

    def done(name, **detail):
        record['steps'].append({'step': name, **detail})
        print(f'ok   {name}', flush=True)

    base = pathlib.Path(tempfile.mkdtemp(prefix='gps-watch-rehearsal-'))
    try:
        lab = Lab(base)
        down = {'health': '500'}

        # 1. A healthy host.
        lab.reset()
        lab.tick(3)
        state = lab.saved()
        require(not lab.subjects() and all(check['status'] == 'up' and check['fails'] == 0 for check in state['checks'].values()) and len(state['checks']) == 4, f'healthy host: {state}')
        # The push address is configured the way the status page shows it, with its own query; that query is replaced.
        require(len(lab.target.pushes) == 3 and all(push.count('status=') == 1 and 'status=up' in push and 'msg=ok' in push for push in lab.target.pushes)
                and state['heartbeat_ok'] is True, f'heartbeat: {lab.target.pushes}')
        done('healthy host for three cycles: no mail, the status page is told "alive" every cycle')

        # 2. Not an outage: one slow answer, two failures in a row, flapping.
        lab.tick(1, health='slow')
        require(lab.saved()['checks']['health']['fails'] == 1 and '시간 초과' in lab.saved()['checks']['health']['detail'], 'a slow answer was not counted as one failure')
        lab.tick(1)
        lab.tick(2, **down)
        lab.tick(1)
        for _ in range(4):
            lab.tick(1, ingest='502')
            lab.tick(1)
        require(not lab.subjects() and lab.saved()['checks']['health']['fails'] == 0 and not lab.saved().get('incident'), f'mail without an outage: {lab.subjects()}')
        done('one slow answer, two failures in a row and repeated single failures: no mail')

        # 3. An outage from beginning to end.
        lab.reset()
        lab.tick(2, **down)
        require(not lab.subjects(), 'mail before the third failure')
        lab.tick(1, **down)
        first = lab.mail.messages[0] if lab.mail.messages else {}
        require(len(lab.subjects()) == 1 and '장애 발생' in first['subject'] and 'health' in first['subject'] and 'HTTP 500' in first['body'], f'opening mail: {lab.subjects()}')
        require(all(f'- {name} (' in first['body'].split('정상')[1] for name in ('ingest', 'ssh', 'status')) and first['from'] == 'watch@example.invalid'
                and first['to'] == 'operator@example.invalid' and first['encrypted'] and first['authenticated'], f'opening mail content: {first}')
        lab.tick(5, **down)
        require(len(lab.subjects()) == 1, 'a second mail within the reminder interval')
        lab.later(55)
        lab.tick(1, **down)
        require(len(lab.subjects()) == 2 and '장애 지속' in lab.subjects()[1] and '1시간' in lab.subjects()[1], f'reminder: {lab.subjects()}')
        lab.tick(3, **down)
        lab.later(57)
        lab.tick(1, **down)
        require(len(lab.subjects()) == 3 and '장애 지속' in lab.subjects()[2], f'second reminder: {lab.subjects()}')
        lab.tick(3, health='500', ingest='502')
        require(len(lab.subjects()) == 4 and '장애 변화' in lab.subjects()[3] and '추가: ingest' in lab.subjects()[3], f'change: {lab.subjects()}')
        require('msg=down' in lab.target.pushes[-1] and 'status=up' in lab.target.pushes[-1], 'the status page was not told what is down')
        lab.tick(2, **down)
        require(len(lab.subjects()) == 5 and '회복: ingest' in lab.subjects()[4] and '아직 실패: health' in lab.subjects()[4], f'partial recovery: {lab.subjects()}')
        lab.tick(1)
        require(len(lab.subjects()) == 5 and lab.saved()['incident'], 'recovery after a single success')
        lab.tick(1)
        require(len(lab.subjects()) == 6 and lab.subjects()[5].startswith('[GPS 감시] 복구') and not lab.saved()['incident'], f'recovery: {lab.subjects()}')
        lab.tick(3)
        require(len(lab.subjects()) == 6, 'mail after the recovery')
        done('outage: one mail at the third failure, a reminder each hour, a mail when another check fails and when it returns, one mail at recovery after two successes',
             subjects=lab.subjects())

        # 4. Every kind of wrong answer is a failed check.
        lab.reset()
        wrong = {}
        for name, modes in (('health', ('500', 'db', 'env', 'html', 'drop', 'slow')), ('ingest', ('502', 'html', 'drop')),
                            ('ssh', ('garbage', 'drop', 'slow')), ('status', ('502', 'drop'))):
            for mode in modes:
                lab.mode.clear()
                lab.mode[name] = mode
                results, online = watch.measure(watch.load(lab.config))
                others = [ok for key, (ok, _, _) in results.items() if key != name]
                require(results[name][0] is False and all(others) and online, f'{name}={mode}: {results}')
                wrong[f'{name}:{mode}'] = results[name][1]
        lab.mode.clear()
        results, online = watch.measure(watch.load(lab.config))
        require(all(ok for ok, _, _ in results.values()) and online, f'healthy: {results}')
        done('error status, database down, wrong environment, a web page instead of the API, no answer, slow answer, no SSH banner: each is a failed check', detail=wrong)

        # 5. The watching machine loses its own connection.
        lab.reset()
        lab.tick(2)
        gone = dict(health='drop', ingest='drop', status='drop', ssh='drop', reference='drop', push='drop')
        lab.tick(10, **gone)
        state = lab.saved()
        require(not lab.subjects() and state['offline_since'] and all(check['fails'] == 0 for check in state['checks'].values()) and not state.get('incident'), f'offline: {state}')
        lab.tick(1)
        require(len(lab.subjects()) == 1 and '감시 공백' in lab.subjects()[0] and not lab.saved()['offline_since'], f'gap notice: {lab.subjects()}')
        lab.tick(3)
        lab.tick(2, **gone)
        lab.tick(2)
        require(len(lab.subjects()) == 1, 'a short gap was reported')
        done('the watching machine is offline for ten minutes: nothing is counted against the host, one notice of the gap afterwards; a two-minute gap is not reported')

        # 6. The mail server fails: nothing is lost, nothing is sent twice.
        lab.reset()
        lab.mail.fail = 'refuse'
        lab.tick(3, **down)
        state = lab.saved()
        require(not lab.subjects() and len(state['pending']) == 1 and state['mail_error'], f'undelivered mail: {state}')
        lab.mail.fail = 'refuse'
        lab.tick(2)
        require(not lab.subjects() and len(lab.saved()['pending']) == 2, 'the recovery mail was not kept')
        lab.mail.fail = None
        lab.tick(1)
        require(len(lab.subjects()) == 2 and '장애 발생' in lab.subjects()[0] and '복구' in lab.subjects()[1] and not lab.saved()['pending'], f'late delivery: {lab.subjects()}')
        lab.tick(2)
        require(len(lab.subjects()) == 2, 'a mail was sent twice')
        for failure, sign in (('auth', '535'), ('data', '451')):
            lab.reset()
            lab.mail.fail = failure
            lab.tick(3, **down)
            state = lab.saved()
            require(not lab.subjects() and len(state['pending']) == 1 and sign in state['mail_error'] and PASSWORD not in json.dumps(state), f'{failure}: {state.get("mail_error")}')
            lab.mail.fail = None
            lab.tick(1, **down)
            require(len(lab.subjects()) == 1 and not lab.saved()['pending'], f'{failure}: not delivered afterwards')
        done('mail server unreachable, login refused, temporary refusal: the mail waits and goes out once, in order, when the server works again')

        # 7. Transports, and configurations that must be refused.
        seen = {}
        for security in ('starttls', 'ssl'):
            lab.reset(security=security)
            lab.tick(3, **down)
            message = lab.mail.messages[0] if lab.mail.messages else {}
            require(message.get('encrypted') and message.get('authenticated') and message.get('transport') == security, f'{security}: {message}')
            seen[security] = 'encrypted and authenticated'
        lab.reset(security='none', host='192.0.2.10')
        for label, prepare in (('unencrypted mail to another host', lambda: None), ('configuration readable by others', lambda: (lab.reset(), lab.config.chmod(0o644)))):
            prepare()
            try:
                watch.load(lab.config)
                require(False, f'{label} was accepted')
            except watch.Stop as stop:
                seen[label] = f'refused: {str(stop)[:60]}'
        done('mail goes out over STARTTLS and over implicit TLS with a login; an unencrypted login to another host and a configuration others can read are refused', detail=seen)

        # 8. The command line, secrets and overlapping runs.
        lab.reset()
        env = {**os.environ, 'GPS_WATCH_CONFIG': str(lab.config), 'PYTHONDONTWRITEBYTECODE': '1'}

        def command(*args):
            result = subprocess.run([sys.executable, str(HERE / 'gps_watch.py'), *args], env=env, capture_output=True, text=True, timeout=60)
            lab.lines.append(result.stdout + result.stderr)
            return result

        result = command('run')
        require(result.returncode == 0 and ' ok | ' in result.stdout and len(result.stdout.strip().splitlines()) == 1, f'run: {result.stdout}{result.stderr}')
        result = command('status')
        require(result.returncode == 0 and json.loads(result.stdout)['checks']['health']['status'] == 'up', f'status: {result.stdout}{result.stderr}')
        result = command('check')
        require(result.returncode == 0 and result.stdout.count('ok  ') == 4, f'check: {result.stdout}{result.stderr}')
        lab.mode['health'] = '500'
        result = command('check')
        require(result.returncode == 1 and 'FAIL health' in result.stdout and lab.saved()['checks']['health']['fails'] == 0 and not lab.subjects(), 'check changed the state or sent mail')
        lab.mode.clear()
        result = command('test-mail')
        require(result.returncode == 0 and len(lab.subjects()) == 1 and '시험 메일' in lab.subjects()[0], f'test-mail: {result.stdout}{result.stderr}')
        lab.mail.fail = 'auth'
        result = command('test-mail')
        require(result.returncode != 0 and 'STOPPED' in result.stderr and len(lab.subjects()) == 1, f'failing test-mail: {result.stdout}{result.stderr}')
        lab.mail.fail = None
        before = (lab.state / 'state.json').read_text()
        with open(lab.state / 'lock', 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = command('run')
        require(result.returncode == 0 and 'skipped' in result.stdout and (lab.state / 'state.json').read_text() == before, f'overlap: {result.stdout}')
        everything = '\n'.join(lab.lines) + ''.join(path.read_text() for path in base.glob('state-*/state.json')) + json.dumps(lab.mail.messages, ensure_ascii=False)
        require(PASSWORD not in everything and TOKEN not in everything, 'a secret appeared in the output, the state or a mail')
        require(lab.state.stat().st_mode & 0o077 == 0, 'the state directory can be read by other accounts')
        done('run, status, check and test-mail work from the command line; check keeps no state and sends nothing; a second run at the same time steps aside; '
             'the mail password and the push address appear in no output, state file or mail')

        # 9. The installer, with a throwaway home and stand-ins for the service manager.
        home, shims = base / 'home', base / 'shims'
        home.mkdir()
        shims.mkdir()
        calls = base / 'calls.log'
        for name, body in (('systemctl', f'echo "systemctl $*" >> {calls}\n'),
                           ('loginctl', f'echo "loginctl $*" >> {calls}\necho yes\n')):
            (shims / name).write_text('#!/bin/bash\n' + body)
            (shims / name).chmod(0o755)
        shell = {**os.environ, 'HOME': str(home), 'PATH': f"{shims}:{os.environ['PATH']}", 'PYTHONDONTWRITEBYTECODE': '1'}
        shell.pop('GPS_WATCH_CONFIG', None)

        def installer(*args):
            return subprocess.run(['bash', str(HERE / 'install_gps_watch.sh'), *args], env=shell, capture_output=True, text=True, timeout=120)

        result = installer('files')
        config = home / '.config/gps-watch/config.ini'
        require(result.returncode == 0 and (home / 'gps-watch/gps_watch.py').is_file() and config.stat().st_mode & 0o777 == 0o600
                and (home / '.config/systemd/user/gps-watch.timer').is_file() and 'enable' not in calls.read_text(), f'files: {result.stdout}{result.stderr}')
        result = installer('start')
        require(result.returncode != 0 and 'enable' not in calls.read_text(), 'the timer was started with an empty configuration')
        config.write_text(lab.config.read_text())
        result = installer('files')
        require(result.returncode == 0 and 'kept the existing' in result.stdout and PASSWORD in config.read_text(), 'a filled-in configuration was overwritten')
        result = installer('start')
        require(result.returncode == 0 and 'systemctl --user enable --now gps-watch.timer' in calls.read_text(), f'start: {result.stdout}{result.stderr}')
        result = installer('remove')
        require(result.returncode == 0 and not (home / 'gps-watch').exists() and not (home / '.config/systemd/user/gps-watch.timer').exists() and config.is_file(), f'remove: {result.stdout}{result.stderr}')
        done('installer: copies the files and an empty configuration (600) without starting anything, refuses to start with an empty configuration, '
             'keeps a filled-in one, starts the timer, and removes everything but the configuration and the state')
        record['passed'] = True
    finally:
        shutil.rmtree(base, ignore_errors=True)
    if len(sys.argv) > 1:
        pathlib.Path(sys.argv[1]).write_text(json.dumps(record, ensure_ascii=False, indent=2))
    print(json.dumps({'passed': record['passed'], 'steps': len(record['steps']), 'script_sha256': record['script_sha256']}))


if __name__ == '__main__':
    main()
