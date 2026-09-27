#!/usr/bin/env bash
# Disposable runner-only PostgreSQL + loopback fake FCM. No production credentials.
set -euo pipefail
job=${1:?job required}
root=${2:?cache root required}
image=${3:?builder image required}
[[ "$job" == "$root/incoming/dev-"* ]] || exit 2
name="gps-fcm-policy-$$"
cleanup() {
  docker rm -f "$name-db" >/dev/null 2>&1 || true
  docker network rm "$name-net" >/dev/null 2>&1 || true
}
docker network create --internal "$name-net" >/dev/null
trap cleanup EXIT
docker run -d --name "$name-db" --network "$name-net" --network-alias postgres \
  --cpus=1 --memory=256m --pids-limit=128 --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=gps_fcm_test postgres:16-alpine >/dev/null
for _ in {1..30}; do
  if docker exec "$name-db" pg_isready -U postgres -d gps_fcm_test >/dev/null; then break; fi
  sleep 1
done
docker run --rm --network "$name-net" --cpus=2 --memory=3g --pids-limit=256 \
  --cap-drop=ALL --security-opt=no-new-privileges --user "$(id -u):$(id -g)" \
  -e CARGO_HOME=/cache/cargo -e CARGO_TARGET_DIR=/cache/target \
  -e GPS_FCM_TEST_DB=postgresql://postgres@postgres/gps_fcm_test \
  -v "$root/cache:/cache" -v "$job/src:/work" -w /work/gps-tracker-api "$image" \
  cargo test --locked --offline --release durable_queue_recovers -- --ignored --nocapture
