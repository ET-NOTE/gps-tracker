"""Windows-friendly synthetic GPS sender, restricted to the development host.

No packages required. Coordinates describe a synthetic loop near Seoul City Hall,
not a person's movements. Runs for 24 hours by default; stop with stop.flag.
"""
import argparse
import datetime as dt
import json
import logging
import logging.handlers
import math
import os
import pathlib
import time
import urllib.error
import urllib.request

ENDPOINT = "https://dev-gps.serial.kr/gps-tracker/ingest"
ROUTE = [(37.5663, 126.9779), (37.5654, 126.9820),
         (37.5680, 126.9826), (37.5690, 126.9789), (37.5663, 126.9779)]
MOVE_SECONDS, STOP_SECONDS = 420, 360


def position(second):
    phase = second % (MOVE_SECONDS + STOP_SECONDS)
    if phase >= MOVE_SECONDS:
        # Small stationary jitter exercises stop detection without teleporting.
        return ROUTE[0][0] + math.sin(second) * .000008, ROUTE[0][1] + math.cos(second) * .000008, 0.0
    segment = phase / MOVE_SECONDS * (len(ROUTE) - 1)
    i = int(segment)
    fraction = segment - i
    a, b = ROUTE[i], ROUTE[i + 1]
    metres = math.hypot((b[0] - a[0]) * 111195, (b[1] - a[1]) * 111195 * math.cos(math.radians(a[0])))
    return a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction, metres / (MOVE_SECONDS / 4) * 3.6


def make_payload(uid, origin, seconds, now):
    fixes = []
    for second in seconds:
        lat, lng, speed = position(second)
        fixes.append(dict(lat=round(lat, 7), lng=round(lng, 7), sat=12,
                          speed_kmh=round(speed, 2), up_ms=second * 1000,
                          age_ms=max(0, round((now - origin - second) * 1000))))
    last = fixes[-1]
    return dict(device_uid=uid, build_tag="dev-windows-simulator", ts=int(now - origin),
                boot=1, awake=1, csq=26, reg=5, vbat_mv=4050, cbc_mv=3980,
                l80=dict(fix=True, lat=last['lat'], lng=last['lng'], sat=12, speed_kmh=last['speed_kmh']),
                fixes=fixes)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # A proxy/configuration mistake must never forward a synthetic device to prod.
        return None


def save(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def run(args):
    if not args.device_uid.startswith('dev-sim-'):
        raise SystemExit('A dedicated dev-sim- device UID is required.')
    if not 5 <= args.interval <= 60 or not 1 <= args.sample_seconds <= args.interval:
        raise SystemExit('interval must be 5..60s and sample-seconds must be 1..interval.')
    if not 0 <= args.seed_minutes <= 60 or not 0 < args.duration_hours <= 168:
        raise SystemExit('seed-minutes must be 0..60 and duration-hours must be 0..168.')
    root = pathlib.Path(args.state_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    lock = (root / 'sender.lock').open('a+b')
    lock.seek(0); lock.write(b'0'); lock.flush(); lock.seek(0)
    if os.name == 'nt':
        import msvcrt
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    logger = logging.getLogger('dev-gps-simulator')
    logger.setLevel(logging.INFO)
    handler = logging.handlers.RotatingFileHandler(root / 'sender.log', maxBytes=1024*1024, backupCount=3, encoding='utf-8')
    handler.setFormatter(logging.Formatter('%(asctime)s %(message)s'))
    logger.addHandler(handler)
    state_path = root / 'state.json'
    state = json.loads(state_path.read_text(encoding='utf-8')) if state_path.exists() else {}
    if state and state['device_uid'] != args.device_uid:
        raise SystemExit('State directory belongs to another device.')
    origin = state.get('origin', time.time() - args.seed_minutes * 60 - args.sample_seconds)
    last_second = state.get('last_second', 0)
    successes, failures = state.get('successes', 0), state.get('failures', 0)
    samples = state.get('samples', 0)
    deadline = time.monotonic() + args.duration_hours * 3600
    (root / 'stop.flag').unlink(missing_ok=True)
    opener = urllib.request.build_opener(NoRedirect())
    logger.info('START pid=%s device=%s endpoint=%s', os.getpid(), args.device_uid, ENDPOINT)
    try:
        while time.monotonic() < deadline and not (root / 'stop.flag').exists():
            now = time.time()
            current = int(now - origin)
            # At most one hour catch-up, bounded 200-point requests, no burst flood.
            first = max(last_second + args.sample_seconds, current - 3600)
            seconds = list(range(first, current + 1, args.sample_seconds))[:200]
            if not seconds:
                time.sleep(.25)
                continue
            payload = make_payload(args.device_uid, origin, seconds, now)
            save(root / 'latest-payload.json', payload)
            started = time.monotonic()
            try:
                request = urllib.request.Request(ENDPOINT, json.dumps(payload).encode(), {'Content-Type': 'application/json'})
                with opener.open(request, timeout=15) as response:
                    result = json.load(response)
                    if response.status != 200 or result.get('ok') is not True:
                        raise ValueError('ingest did not acknowledge payload')
                successes += 1; samples += len(seconds); last_second = seconds[-1]
                logger.info('OK batch=%s points=%s last_second=%s latency_ms=%s command=%s', successes, len(seconds), last_second,
                            round((time.monotonic()-started)*1000), result.get('cmd', '-'))
                error = None
            except (OSError, ValueError, urllib.error.URLError) as exc:
                failures += 1; error = str(exc)
                logger.warning('FAIL %s', error)
            state = dict(device_uid=args.device_uid, endpoint=ENDPOINT, pid=os.getpid(), origin=origin,
                         last_second=last_second, successes=successes, failures=failures, samples=samples,
                         updated_at=dt.datetime.now(dt.timezone.utc).isoformat(), last_error=error, running=True)
            save(state_path, state)
            # Stop requests are noticed within a second, even during normal pacing.
            delay = 1 if error is None and current - last_second > args.interval else args.interval
            for _ in range(delay):
                if (root / 'stop.flag').exists():
                    break
                time.sleep(1)
    finally:
        state['running'] = False
        save(state_path, state)
        logger.info('STOP successes=%s failures=%s samples=%s', successes, failures, samples)
        lock.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device-uid', default='dev-sim-windows-20260924')
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--interval', type=int, default=10)
    parser.add_argument('--sample-seconds', type=int, default=2)
    parser.add_argument('--seed-minutes', type=int, default=20)
    parser.add_argument('--duration-hours', type=float, default=24)
    run(parser.parse_args())
