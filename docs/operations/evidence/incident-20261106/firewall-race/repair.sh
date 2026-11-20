#!/bin/bash
# In a fresh container: reproduce the broken boot (other unit in the middle of ufw's start), add the
# two rules that were added by hand on production, then try the candidate ways back to the standard
# layout and show what each leaves.   repair.sh reload | restart-units
set -u
how=$1
show() { printf '   %-34s policy=%s ufw jumps in INPUT=%s  [%s]\n' "$1" "$(iptables -S INPUT | head -n1 | awk '{print $3}')" "$(iptables -S INPUT | grep -c -- '-j ufw-')" "$(iptables -S INPUT | grep '^-A' | sed -E 's/-A INPUT //; s/-m tcp //' | tr '\n' '|' | cut -c1-170)"; }

bash /case.sh inject 3 > /run/case.out 2>&1          # broken state: chains present, no jumps, policy DROP
tail -n 1 /run/case.out | sed 's/^/   start: /' | cut -c1-200
# case.sh replaced iptables-restore with a counting wrapper; stop it from injecting again.
echo 0 > /run/race.at
iptables -I INPUT -p tcp -m tcp --dport 22 -j ACCEPT   # as added by hand on production
iptables -A INPUT -j ufw-before-input                  # as added by hand on production
show "as production is now"

case "$how" in
  reload)
    ufw reload > /run/reload.out 2>&1; echo "   ufw reload exit=$? $(tr '\n' ' ' < /run/reload.out | cut -c1-120)"
    show "after ufw reload" ;;
  restart-units)
    # What the next boot does once ufw is ordered after netfilter-persistent, done by hand:
    /lib/ufw/ufw-init stop > /run/stop.out 2>&1; echo "   ufw-init stop exit=$? $(tr '\n' ' ' < /run/stop.out | cut -c1-100)"
    show "after ufw stop"
    RACE_INNER=1 /usr/share/netfilter-persistent/plugins.d/15-ip4tables start
    show "after netfilter-persistent start"
    /lib/ufw/ufw-init start quiet > /run/start.out 2>&1; echo "   ufw-init start exit=$? $(tr '\n' ' ' < /run/start.out | cut -c1-100)"
    show "after ufw start" ;;
esac
echo "   ufw chains=$(iptables -S | grep -c '^-N ufw') user rules=$(iptables -S ufw-user-input 2>/dev/null | grep -c '^-A') status: $(ufw status 2>/dev/null | head -n 1)"
