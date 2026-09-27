#!/usr/bin/env bash
# Run on seriallog by the Windows controller. This entry point has no prod target.
set -euo pipefail
stage=${1:?artifact directory required}
[[ "$stage" =~ ^/home/mmm/gps-artifacts/dev-[0-9]{8}-[0-9]{6}-[a-f0-9]{7}$ ]] || exit 2
release=$(basename "$stage")
target="/home/gps-dev/releases/$release"
backup="/home/gps-dev/backups/$release"
api=/home/gps-dev/projects/gps-tracker-api/bin/gps-tracker-api-dev
dist=/home/gps-dev/gps-tracker-web-dev/dist
unit="gps-dev-preflight-$release"
sudo test ! -e "$target"
python3 - "$stage" "$release" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);m=json.loads((root/'manifest.json').read_text())
assert m['target']=='dev' and m['release']==sys.argv[2]
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(root/'gps-tracker-api-dev')==m['api_sha256']
assert sha(root/'source.tar.gz')==m['source_sha256']
for path,h in m['web_files'].items():
 p=(root/'web'/path).resolve();assert p.is_relative_to(root/'web');assert sha(p)==h
print('PASS artifact hashes and dev target')
PY
sudo install -d -o gps-dev -g gps-dev -m 0700 "$backup"
sudo cp -a "$api" "$backup/api.previous"
sudo cp -a /home/gps-dev/projects/gps-tracker-api/.env.dev "$backup/env.dev"
previous_dist=$(sudo readlink -f "$dist")
sudo python3 - "$backup" <<'PY'
import os,pathlib,subprocess,sys,urllib.parse
e=dict(l.split('=',1) for l in pathlib.Path('/home/gps-dev/projects/gps-tracker-api/.env.dev').read_text().splitlines() if '=' in l and not l.startswith('#'))
u=urllib.parse.urlparse(e['DATABASE_URL'].strip().strip('"').strip("'"))
assert u.path.startswith('/gps_tracker_dev') and u.username=='gps_tracker_dev_app'
env=os.environ.copy();env.update(PGHOST=u.hostname,PGPORT=str(u.port or 5432),PGDATABASE=u.path[1:],PGUSER=u.username,PGPASSWORD=urllib.parse.unquote(u.password))
path=pathlib.Path(sys.argv[1])/'dev.dump'
with path.open('wb') as f:subprocess.run(['pg_dump','-Fc','--no-owner','--no-acl'],env=env,stdout=f,check=True)
path.chmod(0o600)
PY
sudo install -d -o gps-dev -g gps-dev -m 0755 "$target"
sudo cp -a "$stage/web" "$target/web"
sudo cp "$stage/manifest.json" "$stage/source.tar.gz" "$target/"
sudo chown -R gps-dev:gps-dev "$target"
sudo find "$target/web" -type d -exec chmod 0755 {} +
sudo find "$target/web" -type f -exec chmod 0644 {} +
sudo ln -s /home/gps-dev/uploads "$target/web/uploads"
sudo install -o gps-dev -g gps-dev -m 0755 "$stage/gps-tracker-api-dev" "$api.next"
cleanup() { sudo systemctl stop "$unit" >/dev/null 2>&1 || true; }
trap cleanup EXIT
if ss -ltn 'sport = :3042' | tail -n +2 | grep -q .; then echo 'Validation port 3042 is occupied.' >&2; exit 4; fi
sudo systemd-run --collect --unit="$unit" -p User=gps-dev -p Group=gps-dev \
  -p WorkingDirectory=/home/gps-dev/projects/gps-tracker-api \
  -p EnvironmentFile=/home/gps-dev/projects/gps-tracker-api/.env.dev.validation \
  -p MemoryMax=500M -p NoNewPrivileges=true -p ProtectSystem=strict -p ProtectHome=read-only \
  -p ReadWritePaths=/home/gps-dev/uploads -p 'InaccessiblePaths=/home/mmm /etc/gps-tracker' \
  -p PrivateTmp=true "$api.next"
curl --silent --fail --retry 5 --retry-delay 1 --retry-connrefused http://127.0.0.1:3042/health >/dev/null
sudo python3 "$stage/test_dev_api.py" /home/gps-dev/projects/gps-tracker-api/.env.dev.validation http://127.0.0.1:3042
sudo python3 "$stage/test_dev_resilience.py" /home/gps-dev/projects/gps-tracker-api/.env.dev.validation http://127.0.0.1:3042
sudo python3 "$stage/test_dev_speed.py" /home/gps-dev/projects/gps-tracker-api/.env.dev.validation http://127.0.0.1:3042
sudo python3 "$stage/test_app_fcm_kc.py" /home/gps-dev/projects/gps-tracker-api/.env.dev.validation http://127.0.0.1:3042
cleanup
sudo mv -f "$api.next" "$api"
sudo ln -s "$target/web" "$dist.next"
sudo mv -Tf "$dist.next" "$dist"
sudo systemctl restart gps-tracker-api-dev
if ! curl --silent --fail --retry 5 --retry-delay 1 --retry-connrefused http://127.0.0.1:3041/health | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["environment"]=="development" and d["release"]==sys.argv[1]' "$release"; then
  sudo install -o gps-dev -g gps-dev -m 0755 "$backup/api.previous" "$api.rollback"
  sudo mv -f "$api.rollback" "$api"
  sudo ln -s "$previous_dist" "$dist.rollback"
  sudo mv -Tf "$dist.rollback" "$dist"
  sudo systemctl restart gps-tracker-api-dev
  echo 'Dev health failed; restored previous API/web. Database backup retained.' >&2
  exit 5
fi
sudo python3 "$stage/test_dev_api.py" /home/gps-dev/projects/gps-tracker-api/.env.dev https://dev-gps.serial.kr
sudo python3 "$stage/test_dev_resilience.py" /home/gps-dev/projects/gps-tracker-api/.env.dev https://dev-gps.serial.kr
sudo python3 "$stage/test_dev_speed.py" /home/gps-dev/projects/gps-tracker-api/.env.dev https://dev-gps.serial.kr
echo "Dev release active: $release"
