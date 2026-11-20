#!/usr/bin/env bash
set -euo pipefail
root=/home/etcom-hub/build/gps-tracker
job="$root/connection-rollback-20261009"
exec 9>"$root/build.lock"
flock -n 9
mkdir -p "$job/src"
tar -xzf "$job/predecessor.tar.gz" -C "$job/src"
cp "$root/incoming/dev-20261009-152034-2cb78a7/src/gps-tracker-api/migrations/0068_connection_alert_episodes.sql" "$job/src/gps-tracker-api/migrations/"
docker run --rm --cpus=4 --memory=6g --user "$(id -u):$(id -g)" \
  -e CARGO_HOME=/cache/cargo -e CARGO_TARGET_DIR=/cache/target \
  -e GPS_RELEASE=dev-20261008-005228-97aa52b -e CARGO_BUILD_JOBS=4 \
  -v "$root/cache:/cache" -v "$job/src:/work" -w /work/gps-tracker-api \
  gps-build:rust1.88-node22.22.2 cargo build --locked --offline --release
cp "$root/cache/target/release/gps-tracker-api" "$job/api.rollback-schema68"
sha256sum "$job/api.rollback-schema68"
