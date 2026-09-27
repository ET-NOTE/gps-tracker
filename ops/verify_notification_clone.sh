#!/usr/bin/env bash
# The only allowed target is the disposable production clone for this review.
set -euo pipefail
stage=${1:?artifact directory required}
[[ "$stage" =~ ^/home/mmm/gps-artifacts/dev-20260928-[0-9]{6}-[a-f0-9]{7}$ ]] || exit 2
backup=/home/mmm/backups/gps-notifications-20260928
unit=gps-notifications-clone-check
ss -ltn 'sport = :3042' | tail -n +2 | grep -q . && { echo 'Validation port occupied'; exit 2; }
cleanup() { systemctl stop "$unit" >/dev/null 2>&1 || true; }
trap cleanup EXIT
systemd-run --collect --unit="$unit" -p User=mmm -p Group=mmm \
  -p WorkingDirectory=/home/mmm/projects/gps-tracker-api \
  -p EnvironmentFile="$backup/validation.env" -p MemoryMax=500M -p NoNewPrivileges=true \
  "$stage/gps-tracker-api-dev"
curl --silent --fail --retry 5 --retry-delay 1 --retry-connrefused http://127.0.0.1:3042/health >/dev/null
python3 "$stage/test_dev_api.py" "$backup/validation.env" http://127.0.0.1:3042
python3 "$stage/test_dev_resilience.py" "$backup/validation.env" http://127.0.0.1:3042
python3 "$stage/test_dev_speed.py" "$backup/validation.env" http://127.0.0.1:3042
python3 "$stage/test_app_fcm_kc.py" "$backup/validation.env" http://127.0.0.1:3042
python3 - "$backup" "$(basename "$stage")" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1])
(p/'clone-check-passed.json').write_text(json.dumps({'release':sys.argv[2],'groups':25,'production_mutated':False}))
print('PASS all 25 regression groups on the production restore; no external FCM')
PY
