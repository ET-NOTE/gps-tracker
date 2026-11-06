"""External watch for the GPS production host, run from a machine that does not depend on it.

    python3 gps_watch.py run          one cycle: check, decide, notify (a timer runs this every minute)
    python3 gps_watch.py check        check once and print; no state is kept and nothing is sent
    python3 gps_watch.py status       what the watch currently believes
    python3 gps_watch.py test-mail    send one test mail with the configured account

It looks at the host from outside and only reads: the API health (including the database), the
address devices report to (a GET that the API answers with "POST only", so nothing is stored),
the SSH port and the status page. One slow answer is not an outage: a check counts as down
after `fail_after` failures in a row and as back after `recover_after` successes in a row.
Mail goes out when an outage begins, when it changes, every `remind_minutes` while it lasts and
when it ends. A mail that cannot be sent is kept and sent by a later cycle.

When the watching machine itself has no internet (none of the reference addresses answers
either), nothing is counted against the host; the gap is reported once the connection is back.
Each cycle also tells the status page that the watch is alive, so a watch that has stopped is
noticed from the other side.

Standard library only. Configuration: ~/.config/gps-watch/config.ini (or $GPS_WATCH_CONFIG),
readable by its owner only because it holds the mail password. See ops/gps-watch.example.ini.
"""
import configparser
import fcntl
import json
import os
import pathlib
import smtplib
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

KST = timezone(timedelta(hours=9), 'KST')
DEFAULTS = {
    'watch': {'name': 'gps.serial.kr', 'environment': 'production', 'fail_after': '3', 'recover_after': '2',
              'remind_minutes': '60', 'gap_minutes': '5', 'timeout_seconds': '10', 'state_dir': '~/.local/state/gps-watch'},
    'checks': {'health': 'https://gps.serial.kr/health', 'ingest': 'http://gps.serial.kr/ingest', 'ssh': 'gps.serial.kr:22',
               'status': 'https://status.serial.kr/', 'references': 'https://www.gstatic.com/generate_204, https://www.naver.com/'},
    'mail': {'host': '', 'port': '587', 'security': 'starttls', 'username': '', 'password': '', 'from': '', 'to': '', 'ca_file': ''},
    'heartbeat': {'url': ''},
}
LABELS = {'health': 'API·DB 상태', 'ingest': '단말기 수집 주소', 'ssh': 'SSH 포트', 'status': '상태 페이지'}
PENDING_LIMIT = 50


class Stop(Exception):
    """The configuration cannot be used."""


def load(path=None):
    path = pathlib.Path(path or os.environ.get('GPS_WATCH_CONFIG') or '~/.config/gps-watch/config.ini').expanduser()
    if not path.is_file():
        raise Stop(f'no configuration at {path}')
    if path.stat().st_mode & 0o077:
        raise Stop(f'{path} can be read by other accounts; it holds the mail password (chmod 600)')
    parser = configparser.ConfigParser(interpolation=None)
    parser.read_dict(DEFAULTS)
    parser.read(path, encoding='utf-8')
    cfg = {section: dict(parser[section]) for section in DEFAULTS}
    mail = cfg['mail']
    if mail['security'] not in ('starttls', 'ssl', 'none'):
        raise Stop('mail security must be starttls, ssl or none')
    if mail['security'] == 'none' and mail['host'] not in ('127.0.0.1', 'localhost', '::1'):
        raise Stop('mail security "none" is accepted for a local test server only: the password would travel in the clear')
    return cfg


def describe(error):
    reason = getattr(error, 'reason', error)
    if isinstance(reason, (socket.timeout, TimeoutError)):
        return '응답 없음(시간 초과)'
    if isinstance(reason, ConnectionRefusedError):
        return '연결 거부'
    if isinstance(reason, ConnectionError):
        return '연결이 끊김(응답 없음)'
    if isinstance(reason, socket.gaierror):
        return '이름 해석 실패'
    if isinstance(reason, ssl.SSLError):
        return f'TLS 오류: {getattr(reason, "reason", None) or type(reason).__name__}'
    return f'{type(reason).__name__}: {str(reason)[:80]}'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def fetch(url, timeout):
    """One GET. An HTTP error status is an answer, not a failure to answer."""
    request = urllib.request.Request(url, headers={'User-Agent': 'gps-watch/1', 'Accept': '*/*'})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=timeout) as response:
            return response.status, response.headers, response.read(65536)
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read(65536)


def probe_health(url, timeout, environment):
    status, _, body = fetch(url, timeout)
    if status != 200:
        return False, f'HTTP {status}'
    try:
        data = json.loads(body)
    except ValueError:
        return False, 'JSON이 아닌 응답'
    if not (isinstance(data, dict) and data.get('ok') is True and data.get('db') is True):
        return False, f"ok={data.get('ok') if isinstance(data, dict) else None} db={data.get('db') if isinstance(data, dict) else None}"
    if data.get('environment') != environment:
        return False, f"environment={data.get('environment')}"
    return True, f"릴리스 {data.get('release')}"


def probe_ingest(url, timeout):
    # The API answers a GET on its POST-only route itself; a proxy without the API behind it answers 502.
    status, headers, _ = fetch(url, timeout)
    if status == 405 and 'POST' in (headers.get('Allow') or ''):
        return True, 'API가 응답(405, POST 전용)'
    return False, f'HTTP {status}'


def probe_status(url, timeout):
    status, _, _ = fetch(url, timeout)
    return status < 500, f'HTTP {status}'


def probe_ssh(address, timeout):
    host, _, port = address.rpartition(':')
    with socket.create_connection((host, int(port)), timeout=timeout) as connection:
        connection.settimeout(timeout)
        banner = connection.recv(64)
        if banner.startswith(b'SSH-'):
            try:
                # Say who is leaving, so the server logs an ordinary closed connection, not a protocol error.
                connection.sendall(b'SSH-2.0-gps-watch\r\n')
            except OSError:
                pass
    return (True, 'SSH 응답') if banner.startswith(b'SSH-') else (False, 'SSH 배너 없음')


def timed(probe, *args):
    start = time.monotonic()
    try:
        ok, detail = probe(*args)
    except Exception as error:  # any way of not answering is a failed check
        ok, detail = False, describe(error)
    return ok, detail, int((time.monotonic() - start) * 1000)


def measure(cfg):
    """({check: (ok, detail, ms)}, whether this machine has internet at all)."""
    watch, checks = cfg['watch'], cfg['checks']
    timeout = float(watch['timeout_seconds'])
    probes = {'health': (probe_health, checks['health'], timeout, watch['environment']), 'ingest': (probe_ingest, checks['ingest'], timeout),
              'ssh': (probe_ssh, checks['ssh'], timeout), 'status': (probe_status, checks['status'], timeout)}
    probes = {name: call for name, call in probes.items() if call[1]}  # an empty address turns a check off
    with ThreadPoolExecutor(len(probes)) as pool:
        running = {name: pool.submit(timed, *call) for name, call in probes.items()}
        results = {name: job.result() for name, job in running.items()}
    online = True
    if not all(ok for ok, _, _ in results.values()):
        references = [url.strip() for url in checks['references'].split(',') if url.strip()]
        online = not references or any(timed(probe_status, url, timeout)[0] for url in references)
    return results, online


def decide(state, results, online, now, cfg):
    """Updates `state` with one cycle's results and returns what happened: opened, changed, reminder, closed, gap."""
    watch = cfg['watch']
    fail_after, recover_after = int(watch['fail_after']), int(watch['recover_after'])
    checks, events = state.setdefault('checks', {}), []
    for name in [name for name in checks if name not in results]:
        del checks[name]
    if not online:
        # This machine cannot reach anything: that says nothing about the host.
        state['offline_since'] = state.get('offline_since') or now
        return events
    if state.get('offline_since'):
        if now - state['offline_since'] >= 60 * float(watch['gap_minutes']):
            events.append({'kind': 'gap', 'since': state['offline_since'], 'until': now})
        state['offline_since'] = None
    went_down, came_back = [], []
    for name, (ok, detail, ms) in results.items():
        check = checks.setdefault(name, {'status': 'up', 'fails': 0, 'oks': 0, 'since': now, 'first_fail': None, 'detail': ''})
        check['detail'], check['ms'] = detail, ms
        if ok:
            check['fails'], check['oks'], check['first_fail'] = 0, check['oks'] + 1, None
            if check['status'] == 'down' and check['oks'] >= recover_after:
                check['status'], check['since'] = 'up', now
                came_back.append(name)
        else:
            check['oks'], check['fails'] = 0, check['fails'] + 1
            check['first_fail'] = check['first_fail'] or now
            if check['status'] == 'up' and check['fails'] >= fail_after:
                check['status'], check['since'] = 'down', check['first_fail']
                went_down.append(name)
    down = sorted(name for name, check in checks.items() if check['status'] == 'down')
    incident = state.get('incident')
    if went_down or came_back:
        if not incident and down:
            state['incident'] = {'opened': min(checks[name]['since'] for name in down), 'last_mail': now}
            events.append({'kind': 'opened', 'down': down})
        elif incident and not down:
            events.append({'kind': 'closed', 'opened': incident['opened'], 'until': now})
            state['incident'] = None
        elif incident:
            incident['last_mail'] = now
            events.append({'kind': 'changed', 'down': down, 'added': sorted(went_down), 'back': sorted(came_back)})
    elif incident and now - incident['last_mail'] >= 60 * float(watch['remind_minutes']):
        incident['last_mail'] = now
        events.append({'kind': 'reminder', 'down': down})
    for event in events:
        state.setdefault('history', []).append({'at': now, **event})
    state['history'] = state.get('history', [])[-40:]
    return events


def clock(stamp, day=True):
    return datetime.fromtimestamp(stamp, KST).strftime('%m/%d %H:%M' if day else '%H:%M')


def span(seconds):
    minutes = max(1, round(seconds / 60))
    return f'{minutes}분' if minutes < 60 else f'{minutes // 60}시간 {minutes % 60}분'


def compose(event, state, now, cfg):
    """(subject, body) of the mail for one event."""
    name, checks = cfg['watch']['name'], state['checks']
    listed = ', '.join(event.get('down', []))
    if event['kind'] == 'opened':
        subject = f"장애 발생 — {listed} ({clock(state['incident']['opened'])} KST부터)"
    elif event['kind'] == 'changed':
        parts = ([f"추가: {', '.join(event['added'])}"] if event['added'] else []) + ([f"회복: {', '.join(event['back'])}"] if event['back'] else [])
        subject = f"장애 변화 — {' / '.join(parts)} (아직 실패: {listed})"
    elif event['kind'] == 'reminder':
        subject = f"장애 지속 — {listed} ({span(now - state['incident']['opened'])}째)"
    elif event['kind'] == 'closed':
        subject = f"복구 — 장애 {clock(event['opened'])}~{clock(event['until'], day=False)} KST ({span(event['until'] - event['opened'])})"
    elif event['kind'] == 'gap':
        subject = f"감시 공백 — 감시 위치의 인터넷 끊김 {clock(event['since'])}~{clock(event['until'], day=False)} KST ({span(event['until'] - event['since'])})"
    else:
        subject = '시험 메일'
    lines = [f'대상: {name}', f'판정 시각: {clock(now)} KST', f'감시 위치: {socket.gethostname()} (운영 서버 밖)', '']
    if event['kind'] == 'gap':
        lines += ['이 시간 동안 감시 위치에서 인터넷에 닿지 못해 운영 서버를 볼 수 없었습니다.', '운영 서버의 장애로 세지 않았습니다. 지금 상태는 아래와 같습니다.', '']
    if event['kind'] == 'test':
        lines += ['메일 설정이 동작합니다. 장애가 생기면 이 주소로 알립니다.', '']
    for title, status in (('실패', 'down'), ('정상', 'up')):
        rows = [(key, check) for key, check in sorted(checks.items()) if check['status'] == status]
        if rows:
            lines.append(title)
            for key, check in rows:
                since = f" — {clock(check['since'])}부터" if status == 'down' else ''
                wobble = f" (방금 {check['fails']}회 실패, 아직 장애로 세지 않음)" if status == 'up' and check['fails'] else ''
                lines.append(f"- {key} ({LABELS.get(key, key)}): {check['detail']}{since}{wobble}")
            lines.append('')
    watch = cfg['watch']
    lines.append(f"판정 기준: 연속 {watch['fail_after']}회 실패하면 장애, 연속 {watch['recover_after']}회 성공하면 복구. 장애가 계속되면 {watch['remind_minutes']}분마다 다시 알립니다.")
    return f'[GPS 감시] {subject}', '\n'.join(lines) + '\n'


def send(cfg, subject, body):
    mail = cfg['mail']
    if not (mail['host'] and mail['from'] and mail['to']):
        raise Stop('mail host, from and to are not configured')
    message = EmailMessage()
    message['Subject'], message['From'], message['To'] = subject, mail['from'], mail['to']
    message['Date'], message['Message-ID'] = formatdate(localtime=True), make_msgid(domain='gps-watch.invalid')
    message.set_content(body)
    context = ssl.create_default_context(cafile=mail['ca_file'] or None)
    if mail['security'] == 'ssl':
        server = smtplib.SMTP_SSL(mail['host'], int(mail['port']), timeout=20, context=context)
    else:
        server = smtplib.SMTP(mail['host'], int(mail['port']), timeout=20)
    with server:
        if mail['security'] == 'starttls':
            server.starttls(context=context)
        if mail['username']:
            server.login(mail['username'], mail['password'])
        server.send_message(message)


def deliver(cfg, state):
    """Send what is waiting, oldest first; keep what cannot be sent. Returns how many went out."""
    sent = 0
    while state.get('pending'):
        try:
            send(cfg, *state['pending'][0])
        except Exception as error:  # the next cycle tries again
            reason = str(error) if isinstance(error, Stop) else describe(error)
            state['mail_error'] = reason.replace(cfg['mail']['password'] or '\0', '***')
            break
        state['pending'].pop(0)
        state['mail_error'] = None
        sent += 1
    return sent


def heartbeat(cfg, summary, ms):
    url = cfg['heartbeat']['url']
    if not url:
        return None
    query = urllib.parse.urlencode({'status': 'up', 'msg': summary, 'ping': ms})
    try:
        return fetch(url + ('&' if '?' in url else '?') + query, min(10.0, float(cfg['watch']['timeout_seconds'])))[0] == 200
    except Exception:  # the status page lives on the watched host; its silence is not this watch's failure
        return False


def cycle(cfg, now=None):
    """One run of the watch. `now` is only passed by the rehearsal, to make hours pass."""
    now = time.time() if now is None else now
    directory = pathlib.Path(cfg['watch']['state_dir']).expanduser()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(directory / 'lock', 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'line': 'skipped: the previous cycle is still running', 'events': [], 'sent': 0}
        path = directory / 'state.json'
        state = json.loads(path.read_text()) if path.exists() else {}
        results, online = measure(cfg)
        events = decide(state, results, online, now, cfg)
        for event in events:
            state.setdefault('pending', []).append(list(compose(event, state, now, cfg)))
        state['pending'] = state.get('pending', [])[-PENDING_LIMIT:]
        sent = deliver(cfg, state)
        down = sorted(name for name, check in state['checks'].items() if check['status'] == 'down')
        summary = 'offline' if not online else ('down: ' + ','.join(down) if down else 'ok')
        state['heartbeat_ok'] = heartbeat(cfg, summary, results.get('health', (False, '', 0))[2])
        state['last_run'] = now
        scratch = path.with_suffix('.next')
        scratch.write_text(json.dumps(state, ensure_ascii=False, indent=1))
        os.replace(scratch, path)
    marks = ' '.join(f"{name}={'ok' if ok else 'FAIL'}({ms}ms{'' if ok else ' ' + detail})" for name, (ok, detail, ms) in sorted(results.items()))
    waiting = f" mail-waiting={len(state['pending'])}({state.get('mail_error')})" if state['pending'] else ''
    line = f"{datetime.fromtimestamp(now, KST).isoformat(timespec='seconds')} {summary} | {marks} | events={','.join(e['kind'] for e in events) or '-'} sent={sent}{waiting}"
    return {'line': line, 'events': events, 'sent': sent}


def main():
    command = sys.argv[1] if len(sys.argv) == 2 else ''
    try:
        if command == 'check':
            # No password is needed to look; a missing configuration means the built-in addresses.
            try:
                cfg = load()
            except Stop:
                cfg = {section: dict(values) for section, values in DEFAULTS.items()}
            results, online = measure(cfg)
            for name, (ok, detail, ms) in sorted(results.items()):
                print(f"{'ok  ' if ok else 'FAIL'} {name} ({LABELS[name]}): {detail} [{ms}ms]")
            print('이 위치의 인터넷: ' + ('정상' if online else '끊김(대상 판정 불가)'))
            sys.exit(0 if all(ok for ok, _, _ in results.values()) else 1)
        cfg = load()
        if command == 'run':
            print(cycle(cfg)['line'])
        elif command == 'status':
            path = pathlib.Path(cfg['watch']['state_dir']).expanduser() / 'state.json'
            state = json.loads(path.read_text()) if path.exists() else {}
            mail = cfg['mail']
            shown = {'mail_configured': all(mail[key] for key in ('host', 'username', 'password', 'from', 'to')),
                     'heartbeat_configured': bool(cfg['heartbeat']['url']),
                     'last_run': state.get('last_run') and clock(state['last_run']) + ' KST', 'incident': state.get('incident'),
                     'offline_since': state.get('offline_since'), 'mail_waiting': len(state.get('pending', [])), 'mail_error': state.get('mail_error'),
                     'heartbeat_ok': state.get('heartbeat_ok'),
                     'checks': {name: {k: check.get(k) for k in ('status', 'fails', 'detail', 'ms')} for name, check in state.get('checks', {}).items()},
                     'recent': [{**event, 'at': clock(event['at'])} for event in state.get('history', [])[-5:]]}
            print(json.dumps(shown, ensure_ascii=False, indent=2))
        elif command == 'test-mail':
            results, _ = measure(cfg)
            state = {'checks': {name: {'status': 'up' if ok else 'down', 'fails': 0, 'since': time.time(), 'detail': detail} for name, (ok, detail, _) in results.items()}}
            send(cfg, *compose({'kind': 'test'}, state, time.time(), cfg))
            print(f"sent to {cfg['mail']['to']}")
        else:
            sys.exit(__doc__)
    except Stop as stop:
        sys.exit(f'STOPPED: {stop}')
    except (smtplib.SMTPException, OSError) as error:
        sys.exit(f'STOPPED: mail could not be sent: {describe(error)}')


if __name__ == '__main__':
    main()
