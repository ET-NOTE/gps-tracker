#!/bin/bash
# GPS external watch on the watching machine (the office build host). Runs as the ordinary
# account: no sudo, no package, no system file. Run from the directory that holds the files.
#
#   bash install_gps_watch.sh files     copy the script and the units, create an empty configuration (nothing runs yet)
#   bash install_gps_watch.sh start     start the every-minute timer (after the configuration is filled in)
#   bash install_gps_watch.sh stop      stop the timer; files and state stay
#   bash install_gps_watch.sh remove    stop and remove script and units; the configuration and state stay
#   bash install_gps_watch.sh show      what is installed and what the watch believes
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
app=$HOME/gps-watch
units=$HOME/.config/systemd/user
config=$HOME/.config/gps-watch/config.ini

case "${1:-}" in
  files)
    [ "$(id -u)" -ne 0 ] || { echo "run as the ordinary account, not root"; exit 1; }
    for f in gps_watch.py gps-watch.service gps-watch.timer gps-watch.example.ini; do [ -f "$here/$f" ] || { echo "missing $here/$f"; exit 1; }; done
    install -d -m 700 "$app" "$(dirname "$config")"
    install -d "$units"
    install -m 644 "$here/gps_watch.py" "$here/gps-watch.example.ini" "$app/"
    install -m 644 "$here/gps-watch.service" "$here/gps-watch.timer" "$units/"
    if [ ! -e "$config" ]; then install -m 600 "$here/gps-watch.example.ini" "$config"; echo "created $config (fill in [mail] and [heartbeat])"; else echo "kept the existing $config"; fi
    systemctl --user daemon-reload
    systemd-analyze --user verify "$units/gps-watch.service" "$units/gps-watch.timer"
    echo "files are in place; the timer is not started"
    ;;
  start)
    python3 "$app/gps_watch.py" status | grep -q '"mail_configured": true' || { echo "fill in [mail] in $config first (host, username, password, from, to)"; exit 1; }
    [ "$(loginctl show-user "$(id -un)" -p Linger --value)" = yes ] || echo "warning: lingering is off; the timer stops when the last session ends"
    systemctl --user enable --now gps-watch.timer
    systemctl --user list-timers gps-watch.timer --no-pager
    ;;
  stop)
    systemctl --user disable --now gps-watch.timer
    ;;
  remove)
    systemctl --user disable --now gps-watch.timer 2>/dev/null || true
    rm -f "$units/gps-watch.service" "$units/gps-watch.timer" "$app/gps_watch.py" "$app/gps-watch.example.ini"
    rmdir "$app" 2>/dev/null || true
    systemctl --user daemon-reload
    echo "removed; $config and ~/.local/state/gps-watch were left"
    ;;
  show)
    systemctl --user list-timers gps-watch.timer --all --no-pager || true
    systemctl --user show gps-watch.service -p Result -p ExecMainExitTimestamp --no-pager || true
    journalctl --user -u gps-watch.service -n 5 --no-pager -o cat 2>/dev/null || true
    python3 "$app/gps_watch.py" status
    ;;
  *)
    sed -n '2,10p' "$0"; exit 1
    ;;
esac
