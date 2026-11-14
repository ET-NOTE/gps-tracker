#!/bin/bash
# One boot-order case inside a fresh container (its own network namespace).
#   case.sh netfilter-first | ufw-first | inject <K> | count
# "inject K": netfilter-persistent restores /etc/iptables/rules.v4 just before ufw-init's K-th
# iptables-restore call, i.e. in the middle of ufw's start, as two unordered boot units can.
set -u
mode=$1; k=${2:-0}

# --- host configuration as on production (structure only; documentation addresses) -------------
sed -i 's/^IPT_SYSCTL=.*/IPT_SYSCTL=/' /etc/default/ufw            # no sysctl in a container; unrelated to the race
grep -q '^MANAGE_BUILTINS=no' /etc/default/ufw || { echo "unexpected ufw default"; exit 9; }
sed -i 's/^ENABLED=.*/ENABLED=yes/' /etc/ufw/ufw.conf
for p in 22 80 443; do ufw allow $p/tcp >/dev/null; done              # written to user.rules; nothing is loaded yet
mkdir -p /etc/iptables
cat > /etc/iptables/rules.v4 <<'EOF'
*raw
:OUTPUT ACCEPT [0:0]
COMMIT
*filter
:INPUT ACCEPT [0:0]
:FORWARD DROP [0:0]
:OUTPUT ACCEPT [0:0]
:DOCKER - [0:0]
:DOCKER-USER - [0:0]
-A INPUT -s 203.0.113.10/32 -p tcp -m tcp --dport 5432 -j ACCEPT
-A INPUT -s 203.0.113.11/32 -p tcp -m tcp --dport 5432 -j ACCEPT
-A INPUT -p tcp -m tcp --dport 5432 -j DROP
COMMIT
*nat
:INPUT ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:DOCKER - [0:0]
COMMIT
EOF
: > /etc/iptables/rules.v6

netfilter() { RACE_INNER=1 /usr/share/netfilter-persistent/plugins.d/15-ip4tables start; }

# --- a counting wrapper around iptables-restore, so the other unit can run "in the middle" -------
real=$(readlink -f /usr/sbin/iptables-restore)                     # xtables-nft-multi
rm /usr/sbin/iptables-restore
cat > /usr/sbin/iptables-restore <<EOF
#!/bin/bash
if [ -z "\${RACE_INNER:-}" ]; then
  n=\$(( \$(cat /run/race.count 2>/dev/null || echo 0) + 1 )); echo \$n > /run/race.count
  if [ "\$n" = "\$(cat /run/race.at 2>/dev/null)" ]; then RACE_INNER=1 /usr/share/netfilter-persistent/plugins.d/15-ip4tables start; fi
fi
exec $real iptables-restore "\$@"
EOF
chmod 755 /usr/sbin/iptables-restore
echo 0 > /run/race.count; echo "$k" > /run/race.at

case "$mode" in
  netfilter-first) netfilter; /lib/ufw/ufw-init start quiet > /run/ufw.out 2>&1; code=$? ;;
  ufw-first)       /lib/ufw/ufw-init start quiet > /run/ufw.out 2>&1; code=$?; netfilter ;;
  inject|count)    /lib/ufw/ufw-init start quiet > /run/ufw.out 2>&1; code=$? ;;
esac

# --- what the kernel ended up with ------------------------------------------------------------
policy=$(iptables -S INPUT | head -n 1 | awk '{print $3}')
jumps=$(iptables -S INPUT | grep -c -- '-j ufw-')
before=$(iptables -S INPUT | grep -c -- '-j ufw-before-input')
chains=$(iptables -S | grep -c '^-N ufw')
user=$(iptables -S ufw-user-input 2>/dev/null | grep -c '^-A')
lo=$(iptables -S ufw-before-input 2>/dev/null | grep -c -- '-i lo -j ACCEPT')
# Would an inbound packet to 443, or anything on loopback, get through?
if [ "$policy" = ACCEPT ] && [ "$jumps" = 0 ]; then verdict="OPEN: no ufw filtering, every port reachable"
elif [ "$before" = 1 ] && [ "$jumps" = 6 ] && [ "$user" -ge 3 ]; then verdict="correct"
elif [ "$policy" = DROP ] && [ "$before" = 0 ]; then verdict="BLOCKED: everything inbound dropped, loopback included"
else verdict="other"; fi
err=$(grep -m1 -oE 'RULE_APPEND failed[^:]*: rule in chain [a-z-]+|No chain/target/match|CHAIN_[A-Z_]+ failed[^\n]*' /run/ufw.out | head -n 1)
printf '%-16s k=%-3s ufw-init exit=%s restores=%-2s INPUT policy=%-6s ufw jumps=%s chains=%-2s user rules=%-2s lo accept=%s -> %s%s\n' \
  "$mode" "$k" "$code" "$(cat /run/race.count)" "$policy" "$jumps" "$chains" "$user" "$lo" "$verdict" "${err:+  [$err]}"
