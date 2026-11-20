"""Install the team-review 148 API and web on the existing schema 115."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tarfile
import time
import urllib.request


RELEASE = "review148-20261119-r1"
SOURCE = "a0e945d91de633cc82d927161edebbd783ab1ef5"
ARTIFACTS = Path("/var/lib/gps-team-review") / RELEASE
API = Path("/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api")
WEB = Path("/home/mmm/gps-tracker-web/dist-root")
OLD_WEB = Path("/home/mmm/releases/review146-20261118-r1/web")
NEW_WEB = OLD_WEB.parent.parent / RELEASE / "web"
BACKUP = Path("/home/mmm/backups") / RELEASE
PREVIOUS = "runtime145-20261118-r1"
OLD_API = "b0765d1d8e0fd44188cb6856468cd15926b75635e4597cafbfc20371816a060d"
NEW_API = "505f0db32306271560a7c1aa6037db0fe54936d85907f57005b14d59206ea0d7"
WEB_ARCHIVE = "c0941b0db13bf1467b64e987e8b87210e02995c550e8ad0557a1348595fdf14c"
MIGRATIONS = "68890bce05837d65c26ffb342b847c555276891cf8e4a4948cb982372735a932"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def local_health(release):
    for _ in range(30):
        try:
            with urllib.request.urlopen("http://127.0.0.1:3040/gps-tracker/health", timeout=2) as response:
                status = json.load(response)
            if status.get("ok") and status.get("db") and status.get("release") == release:
                return status
        except (OSError, ValueError):
            pass
        time.sleep(0.3)
    raise RuntimeError("unexpected local API health")


def check_migrations():
    query = """SELECT version || ':' || encode(checksum,'hex') FROM _sqlx_migrations
               ORDER BY version"""
    prefix = ["runuser", "-u", "postgres", "--", "psql", "-XAt", "-v", "ON_ERROR_STOP=1", "-d", "gps_tracker", "-c"]
    rows = subprocess.check_output(prefix + [query])
    require(hashlib.sha256(rows).hexdigest() == MIGRATIONS, "migration checksums differ")
    require(subprocess.check_output(prefix + ["SELECT count(*) FROM _sqlx_migrations WHERE NOT success"]).strip() == b"0", "unsuccessful migration")


def preflight():
    require(WEB.is_symlink() and WEB.resolve() == OLD_WEB and sha(API) == OLD_API, "baseline release changed")
    require(sha(ARTIFACTS / "gps-tracker-api") == NEW_API, "API artifact mismatch")
    require(sha(ARTIFACTS / "web.tar.gz") == WEB_ARCHIVE, "web artifact mismatch")
    require(not NEW_WEB.parent.exists() and not BACKUP.exists(), "release already staged or used")
    check_migrations()
    return local_health(PREVIOUS)


def set_web(target):
    pending = WEB.with_name(".dist-root-" + RELEASE)
    pending.symlink_to(target, target_is_directory=True)
    os.replace(pending, WEB)


def set_api(source, digest):
    pending = API.with_name("." + RELEASE + ".tmp")
    with source.open("rb") as src, pending.open("xb") as dst:
        shutil.copyfileobj(src, dst)
    require(sha(pending) == digest, "API copy mismatch")
    os.chown(pending, API.stat().st_uid, API.stat().st_gid)
    pending.chmod(0o755)
    os.replace(pending, API)
    subprocess.run(["systemctl", "restart", "gps-tracker-api"], check=True)


def prepare_web():
    NEW_WEB.mkdir(parents=True)
    with tarfile.open(ARTIFACTS / "web.tar.gz") as archive:
        for item in archive:
            path = NEW_WEB / item.name
            require(path.resolve().is_relative_to(NEW_WEB) and (item.isfile() or item.isdir()), "unexpected archive entry")
            if item.isdir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(item) as src, path.open("xb") as dst:
                    shutil.copyfileobj(src, dst)
                path.chmod(0o644)
    require('"/assets/' in (NEW_WEB / "index.html").read_text(), "unexpected web base")
    public = [p for p in (NEW_WEB / "assets").iterdir() if p.is_file()]
    require(bool(public), "missing built assets")
    for old in (OLD_WEB / "assets").iterdir():
        target = NEW_WEB / "assets" / old.name
        if old.is_file() and not target.exists():
            shutil.copy2(old, target)
    if (OLD_WEB / "uploads").is_symlink():
        (NEW_WEB / "uploads").symlink_to((OLD_WEB / "uploads").resolve(), target_is_directory=True)
    (NEW_WEB / "version.json").write_text(json.dumps(dict(release=RELEASE, api_release=RELEASE, schema=115,
        purpose="team review", source_commit=SOURCE, feature_activation=False)) + "\n")
    return public


def public_check(files):
    for url, expected in files:
        with urllib.request.urlopen("https://gps.serial.kr" + url, timeout=10) as response:
            require(hashlib.sha256(response.read()).hexdigest() == sha(expected), "public mismatch " + url)
    with urllib.request.urlopen("https://gps.serial.kr/health", timeout=10) as response:
        status = json.load(response)
    require(status["release"] == RELEASE and status["db"] and status["ok"], "public API health differs")


def apply():
    preflight()
    new_assets = prepare_web()
    BACKUP.mkdir(mode=0o700)
    previous = BACKUP / "api.previous"
    shutil.copy2(API, previous)
    require(sha(previous) == OLD_API, "backup differs")
    (BACKUP / "web.previous").write_text(str(OLD_WEB) + "\n")
    started = datetime.datetime.now(datetime.timezone.utc)
    try:
        set_api(ARTIFACTS / "gps-tracker-api", NEW_API)
        health = local_health(RELEASE)
        set_web(NEW_WEB)
        files = [("/corporate", NEW_WEB / "index.html"), ("/version.json", NEW_WEB / "version.json")]
        files.extend(("/assets/" + p.name, p) for p in new_assets)
        public_check(files)
        check_migrations()
    except BaseException:
        if WEB.resolve() == NEW_WEB:
            set_web(OLD_WEB)
        if sha(API) == NEW_API:
            set_api(previous, OLD_API)
        local_health(PREVIOUS)
        raise
    print(json.dumps(dict(started=started.isoformat(), verified=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                          health=health, public_files_verified=len(files), migrations_verified=115,
                          api_sha256=sha(API), previous_web=str(OLD_WEB), backup=str(BACKUP)), indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["check", "apply"])
    action = parser.parse_args().action
    require(socket.gethostname() == "seriallog.cafe24.com" and os.geteuid() == 0, "unexpected host or user")
    with (ARTIFACTS / "deployment.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if action == "check":
            print(json.dumps(preflight()))
        else:
            apply()
