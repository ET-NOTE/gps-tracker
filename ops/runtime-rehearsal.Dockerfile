# Build-host rehearsal host for ops/runtime_account.py: the production distribution with a real
# systemd as PID 1, so that unit accounts, drop-ins and sandboxing behave as they do on the
# production host. Never deployed. Units that would reach outside the container are masked.
FROM ubuntu:22.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus sudo python3 python3-psycopg2 curl ca-certificates openssl iproute2 procps util-linux passwd \
 && rm -rf /var/lib/apt/lists/* \
 && for unit in systemd-sysctl.service systemd-modules-load.service systemd-udevd.service systemd-udev-trigger.service \
      systemd-udevd-kernel.socket systemd-udevd-control.socket systemd-remount-fs.service systemd-logind.service \
      systemd-timesyncd.service systemd-resolved.service systemd-networkd.service getty.target console-getty.service \
      sys-kernel-config.mount sys-kernel-debug.mount sys-kernel-tracing.mount dev-hugepages.mount dev-mqueue.mount \
      systemd-journald-audit.socket apt-daily.timer apt-daily-upgrade.timer motd-news.timer e2scrub_all.timer fstrim.timer; do \
      ln -sf /dev/null /etc/systemd/system/$unit; done
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
