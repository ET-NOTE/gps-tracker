#!/bin/bash
# Order ufw after netfilter-persistent at boot. Run as root on the production host:
#
#     sudo bash fix_firewall_boot_order.sh
#
# Why: both units rewrite the packet filter early in boot and nothing orders them. When
# netfilter-persistent restores /etc/iptables/rules.v4 (which flushes the filter table) while ufw
# is building its chains, the INPUT jumps to ufw are lost: everything inbound is dropped, loopback
# included (2026-11-06 outage), or, if it runs after ufw, nothing is filtered at all.
# See docs/operations/incident-20261106-hosting-maintenance.md.
#
# What it changes: one systemd drop-in for ufw.service. The running firewall is not touched, so
# the effect starts with the next boot.
# To undo: rm /etc/systemd/system/ufw.service.d/10-after-netfilter-persistent.conf && systemctl daemon-reload
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
first=netfilter-persistent.service
systemctl cat ufw.service > /dev/null
systemctl cat "$first" > /dev/null 2>&1 || { echo "$first is not installed: there is nothing to order"; exit 1; }
directory=/etc/systemd/system/ufw.service.d
file=$directory/10-after-netfilter-persistent.conf
mkdir -p "$directory"
cat > "$file.new" <<EOF
# netfilter-persistent flushes the filter table when it restores /etc/iptables/rules.v4.
# ufw must build its chains after that, never during or before it.
[Unit]
After=$first
EOF
mv "$file.new" "$file"
systemctl daemon-reload
if systemctl show ufw.service -p After --value | tr ' ' '\n' | grep -qx "$first"; then
    echo "ok: at boot ufw.service now starts after $first."
    echo "    The running firewall was not changed. Verify after the next boot with check_firewall_layout.sh."
else
    echo "the ordering is not in effect; remove $file and investigate"
    exit 1
fi
