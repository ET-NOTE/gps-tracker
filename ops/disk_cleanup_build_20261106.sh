#!/bin/bash
# Build host cleanup of the GPS build area: compiler output caches and installed web dependencies.
# Both are recreated by the next build (cargo from the kept registry cache, npm ci from the lock file).
#   bash -s          dry run        bash -s apply    remove
# Never touches: staged outputs (out/), source archives, logs, the pinned Python environment,
# the cargo registry and npm download caches, firmware trees, shield-*, docker, other projects.
set -euo pipefail
mode=${1:-dry}
cd /home/etcom-hub/build
[ "$(pgrep -af 'build/gps-' | grep -vc pgrep || true)" = 0 ] || { echo "STOP: something runs from the build area"; exit 1; }
[ "$(docker ps -q | xargs -r docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' 2>/dev/null | grep -c 'build/gps-' || true)" = 0 ] || { echo "STOP: a container mounts the build area"; exit 1; }
list=$(mktemp); trap 'rm -f "$list"' EXIT
drop() { # category path (relative)
  case "$2" in gps-tracker/cache/target|gps-tracker/cache/target-pdf|gps-*/node_modules|gps-*/*/node_modules|gps-*/*/*/node_modules|gps-*/*/*/*/node_modules) ;; *) echo "STOP: refusing unexpected path $2"; exit 1;; esac
  case "$2" in *..*|*shield-*|*/venv/*|*/cache/cargo*|*/cache/npm*) echo "STOP: refusing $2"; exit 1;; esac
  printf '%s\t%s\t%s\n' "$(du -xsk "$2" | cut -f1)" "$1" "$2" >> "$list"
  if [ "$mode" = apply ]; then
    # Four trees were installed by a build container running as root; they need root to remove.
    if [ -n "$(find "$2" ! -user "$(id -un)" -print -quit 2>/dev/null)" ]; then sudo -n rm -rf -- "$2"; else rm -rf -- "$2"; fi
  fi
}
exec 8>gps-tracker/build.lock 9>gps-tracker/cache/build.lock
flock -w 60 8 && flock -w 60 9 || { echo "STOP: a build holds the lock"; exit 1; }
for t in gps-tracker/cache/target gps-tracker/cache/target-pdf; do [ -d "$t" ] && drop compiler-output "$t"; done
while IFS= read -r d; do drop web-dependencies "$d"; done < <(find gps-* -xdev -maxdepth 5 -name node_modules -type d -prune 2>/dev/null | grep -v 'shield-')
echo "== mode: $mode"
awk -F'\t' '{k[$2]+=$1; c[$2]++} END {for (x in k) printf "   %-20s %4d items %8.1f MiB\n", x, c[x], k[x]/1024}' "$list" | sort
echo "== total: $(awk -F'\t' '{s+=$1} END {printf "%.2f GiB in %d items", s/1048576, NR}' "$list")"
echo "== largest"; sort -rn "$list" | head -n 6 | awk -F'\t' '{printf "   %7.1f MiB %s\n", $1/1024, $3}'
echo "== kept: cargo registry $(du -xsh gps-tracker/cache/cargo | cut -f1), npm cache $(du -xsh gps-tracker/cache/npm | cut -f1), python $(du -xsh gps-location-erasure-20261105/venv | cut -f1), staged outputs of the current chain: $(for d in gps-privacy-facts-20261106-r1 gps-pdf-service-20261106-r1 gps-privacy-pdf-20261106-r1 gps-privacy-facts-20261106; do printf '%s=%s ' "$d" "$(ls "$d/out" | wc -l)"; done)"
echo "== GPS build area now: $(du -xsch gps-* 2>/dev/null | tail -n1 | cut -f1) | disk: $(df -h / | tail -n 1 | awk '{print $3" used, "$4" free, "$5}')"
