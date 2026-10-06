#!/usr/bin/env bash
set -euo pipefail
release="${1:?release required}"
commit="${2:?commit required}"
[[ "$release" =~ ^shield-[0-9]{8}-[0-9]{6}-[a-f0-9]{7}$ ]]
[[ "$commit" =~ ^[a-f0-9]{40}$ ]]
directory="/home/etcom-hub/build/gps-tracker/shield-releases/$release"
test -f "$directory/source.tar.gz"
docker run --rm --user 1000:1000 --cpus=4 --memory=4g \
  -e CARGO_HOME=/cache/cargo -e CARGO_TARGET_DIR=/cache/target -e CARGO_BUILD_JOBS=4 \
  -e npm_config_cache=/cache/npm -e SHIELD_RELEASE="$release" -e SHIELD_COMMIT="$commit" \
  -v /home/etcom-hub/build/gps-tracker/cache:/cache \
  -v "$directory/src:/work" -v "$directory/output:/output" \
  gps-build:rust1.88-node22.22.2 bash /work/ops/shield/build-release.sh
