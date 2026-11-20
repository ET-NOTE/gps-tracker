# Isolated Ubuntu 22.04 / real systemd / PostgreSQL 14 protection rehearsal.
# No host devices, host network, production data or production configuration.
FROM gps-runtime-rehearsal:20261106
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
 && chmod 755 /usr/sbin/policy-rc.d \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends postgresql-14 gcc libc6-dev \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl disable postgresql.service postgresql@14-main.service
COPY runtime118_nodump.c /root/runtime118_nodump.c
RUN gcc -shared -fPIC -Wall -Wextra -Werror -O2 -o /usr/local/lib/gps-nodump.so /root/runtime118_nodump.c \
 && chmod 644 /usr/local/lib/gps-nodump.so
COPY runtime118_guard.py /usr/local/lib/runtime118_guard.py
