#!/bin/bash
# Read-only. Is the packet filter in the layout a clean ufw start produces? Run as root:
#
#     sudo bash check_firewall_layout.sh
#
# Use it after every reboot and after any firewall change. Exit status 1 when something is off.
# Background: docs/operations/incident-20261106-hosting-maintenance.md
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
status=0
report() { printf '%-4s %s\n' "$1" "$2"; if [ "$1" = FAIL ]; then status=1; fi; }

if [ "$(systemctl is-active ufw 2>/dev/null)" = active ] && [ "$(systemctl show ufw -p Result --value 2>/dev/null)" = success ]; then
    report ok "ufw.service is active and its last start succeeded"
else
    report FAIL "ufw.service did not start cleanly"
fi
if systemctl show ufw -p After --value 2>/dev/null | tr ' ' '\n' | grep -qx netfilter-persistent.service; then
    report ok "ufw is ordered after netfilter-persistent at boot"
elif systemctl cat netfilter-persistent.service > /dev/null 2>&1; then
    report FAIL "ufw is not ordered after netfilter-persistent: the boot race is possible"
else
    report ok "netfilter-persistent is not installed: no second unit rewrites the filter"
fi
for tool in iptables ip6tables; do
    prefix=ufw; [ "$tool" = ip6tables ] && prefix=ufw6
    policy=$($tool -S INPUT 2>/dev/null | awk 'NR==1 {print $3}')
    jumps=$($tool -S INPUT 2>/dev/null | grep -c -- "-j $prefix-")
    if [ "$policy" = DROP ] && [ "$jumps" = 6 ]; then
        report ok "$tool INPUT: policy DROP and all 6 jumps to ufw"
    else
        report FAIL "$tool INPUT: policy ${policy:-?} and $jumps of 6 jumps to ufw"
    fi
    # The loopback rule lives in ufw's chain, so it only counts when INPUT reaches that chain.
    if $tool -S INPUT 2>/dev/null | grep -q -- "-j $prefix-before-input" \
        && $tool -S "$prefix-before-input" 2>/dev/null | grep -q -- '-i lo -j ACCEPT'; then
        report ok "$tool: loopback is accepted"
    else
        report FAIL "$tool: loopback is not accepted (local services cannot reach each other)"
    fi
done
for port in 22 80 443; do
    if iptables -S ufw-user-input 2>/dev/null | grep -q -- "--dport $port -j ACCEPT"; then
        report ok "port $port has an allow rule"
    else
        report FAIL "port $port has no allow rule in ufw-user-input"
    fi
done
exit $status
