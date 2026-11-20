#!/bin/bash
# Production disk cleanup: superseded web builds, and the rebuildable files inside superseded
# staging directories. Records (json), scripts and anything named backup/rollback stay.
#   bash -s          dry run: lists what would go, changes nothing
#   bash -s apply    removes exactly that list
# Never touches: the live and the previous web release, the staging directories production's
# recovery relies on, /home/mmm/backups, /home/mmm/backup, databases, uploads, logs, other projects.
set -euo pipefail
mode=${1:-dry}
R=/home/mmm/releases; A=/home/mmm/gps-artifacts; D=/home/mmm/gps-downloads; W=/home/mmm/gps-tracker-web
KEEP_RELEASE=" privacy-facts-20261106-r1 privacy-pdf-20261106-r1 "
KEEP_STAGE=" privacy-facts-20261106-r1 privacy-facts-20261106-r1-smoke pdf-service-20261106 runtime-account-20261106 privacy-pdf-20261106-r1 "
live=$(readlink -f "$W/dist-root")
case "$live" in "$R"/privacy-facts-20261106-r1/web) ;; *) echo "STOP: the live web is $live, not the release this script was written for"; exit 1;; esac
prod_api=$(sudo -n sha256sum /home/mmm/projects/gps-tracker-api/bin/gps-tracker-api | cut -d' ' -f1)
dev_api=$(sudo -n sha256sum /home/gps-dev/projects/gps-tracker-api/bin/gps-tracker-api-dev | cut -d' ' -f1)
served=$(sudo -n find "$D" -maxdepth 1 -type f \( -name '*.apk' -o -name '*.zip' \) -exec sha256sum {} + | cut -d' ' -f1 | sort -u)
list=$(mktemp); trap 'rm -f "$list"' EXIT
drop() { # category path
  case "$2" in "$R"/*/web|"$R"/*/source.tar.gz|"$A"/*/*|"$W"/node_modules|"$W"/gps-tracker-web/node_modules) ;; *) echo "STOP: refusing unexpected path $2"; exit 1;; esac
  case "$2" in *..*|"$live"*) echo "STOP: refusing $2"; exit 1;; esac
  printf '%s\t%s\t%s\n' "$(sudo -n du -xsk "$2" | cut -f1)" "$1" "$2" >> "$list"
  if [ "$mode" = apply ]; then sudo -n rm -rf -- "$2"; fi
}
# 1. web builds of superseded releases (each rebuilds from its commit); their small records stay
for d in "$R"/*/; do n=$(basename "$d")
  case "$KEEP_RELEASE" in *" $n "*) continue;; esac
  [ -d "$R/$n/web" ] && drop web-build "$R/$n/web"
  [ -f "$R/$n/source.tar.gz" ] && drop source-archive "$R/$n/source.tar.gz"
done
# 2. rebuildable files inside superseded staging directories
kept_running=""
for d in "$A"/*/; do n=$(basename "$d")
  case "$KEEP_STAGE" in *" $n "*) continue;; esac
  runs=no
  for b in gps-tracker-api gps-tracker-api-dev; do
    if [ -f "$A/$n/$b" ]; then h=$(sudo -n sha256sum "$A/$n/$b" | cut -d' ' -f1); if [ "$h" = "$prod_api" ] || [ "$h" = "$dev_api" ]; then runs=yes; fi; fi
  done
  if [ "$runs" = yes ]; then kept_running="$kept_running $n"; continue; fi
  while IFS= read -r f; do b=$(basename "$f")
    case "$b" in
      *backup*|*rollback*|*previous*|*before*) continue;;
      gps-tracker-api|gps-tracker-api-dev|gps-pdf-render) drop binary "$f";;
      *.tar.gz|*.tgz) drop archive "$f";;
      *.apk|*.zip) h=$(sudo -n sha256sum "$f" | cut -d' ' -f1); if echo "$served" | grep -qx "$h"; then drop duplicate-of-served-download "$f"; fi;;
      smoke-private.json) drop one-time-credential "$f";;
    esac
  done < <(sudo -n find "$A/$n" -maxdepth 1 -mindepth 1 -type f)
  [ -d "$A/$n/__pycache__" ] && drop python-cache "$A/$n/__pycache__"
done
# 3. dependency trees of the old on-server web build
for p in "$W/node_modules" "$W/gps-tracker-web/node_modules"; do [ -d "$p" ] && drop node-modules "$p"; done

echo "== mode: $mode | live web $live | staging directories kept because they hold what runs now:${kept_running:- none}"
echo "== by category"
awk -F'\t' '{k[$2]+=$1; c[$2]++} END {for (x in k) printf "   %-32s %5d items %8.1f MiB\n", x, c[x], k[x]/1024}' "$list" | sort
echo "== file names (count)"; awk -F'\t' '{n=split($3,a,"/"); print a[n]}' "$list" | sort | uniq -c | sort -rn | head -n 30 | sed 's/^/   /'
echo "== total: $(awk -F'\t' '{s+=$1} END {printf "%.2f GiB in %d items", s/1048576, NR}' "$list")"
echo "== what stays in the touched areas"
echo "   releases: $(sudo -n du -xsh "$R" | cut -f1) now | artifacts: $(sudo -n du -xsh "$A" | cut -f1) now"
echo "   largest things left untouched in gps-artifacts:"; sudo -n find "$A" -mindepth 1 -maxdepth 2 -type f -size +5M -printf '%s\t%p\n' | sort -rn | awk -F'\t' '{printf "      %6.1f MiB %s\n", $1/1048576, $2}' > /tmp/left.$$ ; grep -v -F -f <(cut -f3 "$list") /tmp/left.$$ | head -n 25 || true; rm -f /tmp/left.$$
echo "   subdirectories inside superseded staging directories (not touched): $(sudo -n find "$A" -mindepth 2 -maxdepth 2 -type d ! -name __pycache__ | wc -l)"
echo "== disk: $(df -h / | tail -n 1 | awk '{print $3" used, "$4" free, "$5}')"
