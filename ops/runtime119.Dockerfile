FROM gps-runtime118:20261112 AS controller
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends docker.io python3-pip \
 && pip3 install --no-cache-dir 'psycopg[binary]==3.2.10' \
 && rm -rf /var/lib/apt/lists/*
COPY runtime119_entry.py runtime119_profiles.py /usr/local/lib/
RUN python3 /usr/local/lib/runtime119_profiles.py
ENV LD_PRELOAD=/usr/local/lib/gps-nodump.so
ENTRYPOINT ["python3", "/usr/local/lib/runtime119_entry.py"]

FROM timescale/timescaledb:2.19.3-pg14 AS database
RUN apk add --no-cache python3 gcc musl-dev
COPY runtime118_nodump.c /root/runtime118_nodump.c
RUN gcc -shared -fPIC -Wall -Wextra -Werror -O2 -o /usr/local/lib/gps-nodump.so /root/runtime118_nodump.c
COPY runtime118_guard.py runtime119_entry.py runtime119_profiles.py /usr/local/lib/
RUN python3 /usr/local/lib/runtime119_profiles.py
ENV LD_PRELOAD=/usr/local/lib/gps-nodump.so GPS_RUNTIME_PROFILE=db-memory
ENTRYPOINT ["python3", "/usr/local/lib/runtime119_entry.py", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["postgres"]

FROM nginx:stable-alpine AS proxy
RUN apk add --no-cache python3 gcc musl-dev
COPY runtime118_nodump.c /root/runtime118_nodump.c
RUN gcc -shared -fPIC -Wall -Wextra -Werror -O2 -o /usr/local/lib/gps-nodump.so /root/runtime118_nodump.c
COPY runtime118_guard.py runtime119_entry.py runtime119_profiles.py /usr/local/lib/
RUN python3 /usr/local/lib/runtime119_profiles.py
ENV LD_PRELOAD=/usr/local/lib/gps-nodump.so GPS_RUNTIME_PROFILE=proxy
ENTRYPOINT ["python3", "/usr/local/lib/runtime119_entry.py"]
