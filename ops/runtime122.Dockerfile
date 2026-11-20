FROM gps-runtime121:20261113
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nginx-light \
 && rm -rf /var/lib/apt/lists/* && systemctl disable nginx.service
