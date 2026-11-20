#!/bin/bash
# Round 22D build-host development helper. Isolated: internal Docker network, throwaway DB, APP_ENV=test.
#   api-check | api-release       build steps for the API on its pinned toolchain
#   up | api | down               throwaway test environment (the PDF processor of round 16 next to the API)
#                                 LEDGER=on records reads of location (durable per operation)
#                                 KEEP_DAYS=n sets the retention and runs housekeeping every 30 s
#   suite <script.py>             run one integration suite with the pinned Python
set -euo pipefail
job="$(cd "$(dirname "$0")" && pwd)"
[[ "$job" == /home/etcom-hub/build/gps-provision22-* ]] || { echo "disposable build job required" >&2; exit 1; }
root=/home/etcom-hub/build/gps-tracker
net=gps-provision22-test-20261111cumulative110
db=gps-provision22-db-20261111cumulative110
api=gps-provision22-api-20261111cumulative110
python=/home/etcom-hub/build/gps-location-erasure-20261105/venv/bin/python
mkdir -p "$job/out"
[ -f "$job/out/gps-pdf-render" ] || cp /home/etcom-hub/build/gps-privacy-pdf-20261106-r1/out/gps-pdf-render "$job/out/gps-pdf-render"

build() { # script
  docker run --rm --network "${BUILD_NETWORK:-bridge}" -e LEDGER_TEST_DATABASE_URL -e GPS_AI_TEST_DB -e GPS_FCM_TEST_DB --cpus=6 --memory=8g --pids-limit=1024 --cap-drop=ALL --security-opt=no-new-privileges \
    --user "$(id -u):$(id -g)" -e CARGO_HOME=/cache/cargo -e CARGO_TARGET_DIR=/cache/target -e CARGO_BUILD_JOBS=6 \
    -e GPS_RELEASE=query110-20261111-dev -v "$root/cache:/cache" -v "$job/src:/work" -v "$job/out:/out" \
    -w /work/gps-tracker-api gps-build:rust1.88-node22.22.2 bash -euc "$1"
}

start_api() {
  docker rm -f "$api" >/dev/null 2>&1 || true
  mkdir -p "$job/test-storage/uploads" "$job/test-storage/private"
  extra=()
  [ "${SUBJECTS:-off}" = on ] && extra+=(-e GPS_SUBJECT_PROVISION=on)
  [ -n "${LEDGER:-}" ] && extra+=(-e "GPS_LOCATION_ACCESS_LOG=$LEDGER" -e GPS_LOCATION_ACCESS_FLUSH_SECONDS=1)
  [ -n "${ERASURE:-}" ] && extra+=(-e "GPS_LOCATION_ACCESS_ERASURE=$ERASURE")
  [ -n "${KEEP_DAYS:-}" ] && extra+=(-e "GPS_LOCATION_ACCESS_KEEP_DAYS=$KEEP_DAYS" -e GPS_HOUSEKEEPING_POLL_SECONDS=30)
  [ "${ADMIN_SECURITY:-off}" = on ] && extra+=(-e GPS_ADMIN_SECURITY=on -e GPS_ADMIN_MFA_KEY=YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=)
  [ -n "${RUNTIME_DSN:-}" ] && extra+=(-e "DATABASE_URL=$RUNTIME_DSN" -e GPS_DATABASE_MODE=runtime)
  [ "${STORAGE:-off}" = pilot ] && extra+=(-e GPS_LOCATION_ENCRYPTION=pilot -e GPS_LOCATION_KEYRING_FILE=/keys.json -v "$job/test-keys.json:/keys.json:ro")
  [ "${TLS_REQUIRED:-off}" = on ] && extra+=(-e GPS_INGEST_TLS_REQUIRED=on -e "GPS_TLS_TRUSTED_PROXIES=$TLS_PROXY")
  docker run -d --name "$api" --network "$net" --memory=550m --user "$(id -u):$(id -g)" \
    --cap-drop=ALL --security-opt=no-new-privileges \
    -e APP_ENV=test -e BIND_ADDR=0.0.0.0:3043 \
    -e DATABASE_URL=postgres://postgres:closure-test-only@closure-db:5432/gps_closure_test \
    -e JWT_SECRET=closure-test-only-jwt-key-32-characters -e SMS_DEV_MODE=1 "${extra[@]}" \
    -e UPLOAD_DIR="$job/test-storage/uploads" -e PRIVATE_UPLOAD_DIR="$job/test-storage/private" \
    -v "$job/test-storage:$job/test-storage" -v "$job/out/gps-tracker-api:/api:ro" \
    -v "$job/out/gps-pdf-render:/gps-pdf-render:ro" \
    gps-build:rust1.88-node22.22.2 /api >/dev/null
  ip=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$net\").IPAddress}}" "$api")
  for _ in $(seq 1 90); do
    if curl -fsS -m 2 "http://$ip:3043/gps-tracker/health" 2>/dev/null | grep -q '"db":true'; then echo "api ready at $ip (ledger ${LEDGER:-off})"; return 0; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$api")" != "true" ]; then echo "api exited:"; docker logs --tail 20 "$api"; return 1; fi
    sleep 1
  done
  echo "api readiness timeout"; docker logs --tail 20 "$api"; return 1
}

case "${1:-}" in
  api-check)
    exec 9>"$root/build.lock"; flock -w 900 9
    # Archives can preserve old mtimes: never certify a stale first-party artifact.
    build 'cargo clean -p gps-tracker-api && cargo fmt && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked' ;;
  external-check)
    exec 9>"$root/build.lock"; flock -w 900 9
    export BUILD_NETWORK="$net" LEDGER_TEST_DATABASE_URL=postgres://postgres:closure-test-only@closure-db:5432/gps_closure_test
    build 'cargo test --locked external_intents_commit_before_mock_network -- --ignored --nocapture' ;;
  external-boundary)
    exec 9>"$root/build.lock"; flock -w 900 9
    export BUILD_NETWORK="$net" LEDGER_TEST_DATABASE_URL=postgres://postgres:closure-test-only@closure-db:5432/gps_closure_test
    build 'cargo test --locked external_company_boundary22d -- --ignored --nocapture' ;;
  external-all)
    exec 9>"$root/build.lock"; flock -w 900 9
    for testdb in gps_ai_test gps_fcm_test; do
      docker exec "$db" dropdb -U postgres --if-exists --force "$testdb"
      docker exec "$db" createdb -U postgres "$testdb"
    done
    export BUILD_NETWORK="$net" LEDGER_TEST_DATABASE_URL=postgres://postgres:closure-test-only@closure-db:5432/gps_closure_test
    export GPS_AI_TEST_DB=postgres://postgres:closure-test-only@closure-db:5432/gps_ai_test GPS_FCM_TEST_DB=postgres://postgres:closure-test-only@closure-db:5432/gps_fcm_test
    build 'cargo test --locked -- --ignored --skip lifecycle_external_and_realtime_fences_without_ledger --skip external_company_boundary22d --test-threads=1 --nocapture && cargo test --locked lifecycle_external_and_realtime_fences_without_ledger -- --ignored --nocapture' ;;
  api-release)
    exec 9>"$root/build.lock"; flock -w 900 9
    build 'cargo clean --release -p gps-tracker-api && cargo build --locked --release && cp /cache/target/release/gps-tracker-api /out/gps-tracker-api.next && mv /out/gps-tracker-api.next /out/gps-tracker-api' ;;
  up)
    docker network create --internal "$net" >/dev/null
    docker run -d --name "$db" --network "$net" --network-alias closure-db --memory=700m \
      --tmpfs /var/lib/postgresql/data:rw,size=400m -e POSTGRES_PASSWORD=closure-test-only -e POSTGRES_DB=gps_closure_test \
      timescale/timescaledb:2.19.3-pg14 -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0 >/dev/null
    ok=0
    for _ in $(seq 1 90); do
      if docker exec "$db" psql -U postgres -d gps_closure_test -Atc 'select 1' >/dev/null 2>&1; then ok=$((ok+1)); else ok=0; fi
      [ "$ok" -ge 3 ] && break
      sleep 1
    done
    [ "$ok" -ge 3 ] || { echo "db readiness timeout"; exit 1; }
    start_api ;;
  api) start_api ;;
  stop) docker stop -t 15 "$api" >/dev/null && echo "stopped (exit $(docker inspect -f '{{.State.ExitCode}}' "$api"))" ;;
  kill) docker kill "$api" >/dev/null && echo killed ;;
  down)
    docker rm -f "$api" "$db" >/dev/null 2>&1 || true
    docker network rm "$net" >/dev/null 2>&1 || true
    rm -rf "$job/test-storage"; echo removed ;;
  suite)
    cd "$job" && PYTHONPATH="$job/python-deps:$job/src/ops" "$python" "$2" ;;
  *) echo "usage: dev22.sh api-check|api-release|up|api|stop|kill|down|suite <script.py>" >&2; exit 2 ;;
esac
