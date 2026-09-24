#!/usr/bin/env bash
# Invoked by Windows over SSH. Builds artifacts only; no VPS keys or deployment.
set -euo pipefail
release=${1:?release required}
commit=${2:?commit required}
[[ "$release" =~ ^dev-[0-9]{8}-[0-9]{6}-[a-f0-9]{7}$ ]] || exit 2
[[ "$commit" =~ ^[a-f0-9]{40}$ ]] || exit 2
root="$HOME/build/gps-tracker"
mkdir -p "$root/cache/cargo" "$root/cache/target" "$root/cache/npm"
exec 9>"$root/build.lock"
flock -n 9 || { echo 'Another GPS build is running.' >&2; exit 3; }
job="$root/incoming/$release"
mkdir -p "$job/src" "$job/out"
tar -xzf "$job/source.tar.gz" -C "$job/src"
image="gps-build:rust1.88-node22.22.2"
docker build -t "$image" -f "$job/src/ops/hub-builder.Dockerfile" "$job/src/ops"
docker run --rm --name "gps-build-$release" --cpus=4 --memory=6g --memory-swap=6g \
  --pids-limit=512 --cap-drop=ALL --security-opt=no-new-privileges \
  --user "$(id -u):$(id -g)" \
  -e GPS_RELEASE="$release" -e CARGO_HOME=/cache/cargo -e CARGO_TARGET_DIR=/cache/target \
  -e CARGO_BUILD_JOBS=4 -e npm_config_cache=/cache/npm \
  -v "$root/cache:/cache" -v "$job/src:/work" -v "$job/out:/out" -w /work "$image" \
  bash -euc '
    cd gps-tracker-api
    cargo fmt --check
    cargo clippy --locked --all-targets -- -D warnings
    cargo test --locked --release
    cargo build --locked --release
    cp /cache/target/release/gps-tracker-api /out/gps-tracker-api-dev
    cd ../gps-tracker-web
    npm ci --no-audit --no-fund
    npm test
    VITE_BASE=/ npm run build
    cp -R dist /out/web
    cp /work/ops/test_dev_api.py /out/test_dev_api.py
    cp /work/ops/test_dev_resilience.py /out/test_dev_resilience.py
    cp /work/ops/test_dev_speed.py /out/test_dev_speed.py
    cp /work/ops/deploy-dev-artifact.sh /out/deploy-dev-artifact.sh
    rustc --version > /out/toolchain.txt
    node --version >> /out/toolchain.txt
    getconf GNU_LIBC_VERSION >> /out/toolchain.txt
  '
cp "$job/source.tar.gz" "$job/out/source.tar.gz"
builder_image=$(docker image inspect "$image" --format '{{.Id}}')
python3 - "$job/out" "$release" "$commit" "$builder_image" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
web_files={p.relative_to(root/'web').as_posix():sha(p) for p in sorted((root/'web').rglob('*')) if p.is_file()}
manifest=dict(release=sys.argv[2],git_commit=sys.argv[3],target='dev',builder='etcom-hub',builder_image=sys.argv[4],
              api_sha256=sha(root/'gps-tracker-api-dev'),source_sha256=sha(root/'source.tar.gz'),web_files=web_files,
              toolchain=(root/'toolchain.txt').read_text().splitlines())
(root/'manifest.json').write_text(json.dumps(manifest,indent=2))
(root/'web'/'version.json').write_text(json.dumps(manifest,indent=2))
PY
tar -czf "$job/artifacts.tar.gz" -C "$job/out" .
sha256sum "$job/artifacts.tar.gz"
