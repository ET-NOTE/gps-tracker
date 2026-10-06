#!/usr/bin/env bash
# Web-only release: never compile or package the API on this path.
set -euo pipefail
release=${1:?release required}
commit=${2:?commit required}
[[ "$release" =~ ^gps-web-[0-9]{8}-[0-9]{6}-[a-f0-9]{7}$ ]] || exit 2
[[ "$commit" =~ ^[a-f0-9]{40}$ ]] || exit 2
root="$HOME/build/gps-tracker"
exec 9>"$root/build.lock"
flock -n 9 || exit 3
job="$root/incoming/$release"
mkdir -p "$job/src" "$job/out" "$root/cache/npm"
tar -xzf "$job/source.tar.gz" -C "$job/src"
image='gps-build:rust1.88-node22.22.2'
docker run --rm --name "$release" --cpus=4 --memory=4g --memory-swap=4g \
  --pids-limit=512 --cap-drop=ALL --security-opt=no-new-privileges \
  --user "$(id -u):$(id -g)" -e npm_config_cache=/cache/npm \
  -v "$root/cache/npm:/cache/npm" -v "$job/src:/work" -v "$job/out:/out" \
  -w /work/gps-tracker-web "$image" bash -euc '
    npm ci --no-audit --no-fund
    npm test > /out/test-results.txt 2>&1 || { cat /out/test-results.txt; exit 1; }
    VITE_BASE=/ npm run build
    cp -R dist /out/web
    node --version > /out/toolchain.txt
  '
cp "$job/source.tar.gz" "$job/out/source.tar.gz"
builder_image=$(docker image inspect "$image" --format '{{.Id}}')
python3 - "$job/out" "$release" "$commit" "$builder_image" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
sha=lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
manifest=dict(release=sys.argv[2],git_commit=sys.argv[3],component='web',builder='etcom-hub',builder_image=sys.argv[4],
              source_sha256=sha(root/'source.tar.gz'),
              web_files={p.relative_to(root/'web').as_posix():sha(p) for p in sorted((root/'web').rglob('*')) if p.is_file()},
              toolchain=(root/'toolchain.txt').read_text().splitlines())
(root/'manifest.json').write_text(json.dumps(manifest,indent=2))
PY
tar -czf "$job/artifacts.tar.gz" -C "$job/out" .
sha256sum "$job/artifacts.tar.gz"
