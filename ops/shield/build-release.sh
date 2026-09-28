#!/usr/bin/env bash
# Run inside the etcom-hub builder with /work at this repository and /output writable.
set -euo pipefail
: "${SHIELD_RELEASE:?Set an immutable Shield release ID}"
[[ "$SHIELD_RELEASE" =~ ^shield-[0-9]{8}-[0-9]{6}-[a-f0-9]{7,40}$ ]]
cd /work/gps-tracker-api
cargo test --locked --release --features shield --bin shield-api
cargo clippy --locked --features shield --bin shield-api -- -D warnings
GPS_RELEASE="$SHIELD_RELEASE" cargo build --locked --release --features shield --bin shield-api
cd /work/shield-web
npm ci --no-audit --no-fund
npm test
npm run build
destination="/output/$SHIELD_RELEASE"
test ! -e "$destination"
mkdir -p "$destination/web" "$destination/ops"
cp "${CARGO_TARGET_DIR:-/work/gps-tracker-api/target}/release/shield-api" "$destination/"
cp -a dist/. "$destination/web/"
cp /work/ops/shield/{shield-api.service,shield.serial.kr.conf,postgres-hba.fragment,bootstrap-database.sql,shield.env.example,backup.py} "$destination/ops/"
printf '%s\n' "$SHIELD_RELEASE" > "$destination/release.txt"
printf '%s\n' "${SHIELD_COMMIT:?Set the source commit}" > "$destination/commit.txt"
cd "$destination"
find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
cd /output
tar -czf "$SHIELD_RELEASE.tar.gz" "$SHIELD_RELEASE"
sha256sum "$SHIELD_RELEASE.tar.gz" > "$SHIELD_RELEASE.tar.gz.sha256"
