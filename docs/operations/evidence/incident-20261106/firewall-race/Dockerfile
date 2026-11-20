# Throwaway image to reproduce the ufw / netfilter-persistent boot race in an isolated network namespace.
# Same distribution and package versions as the production host (Ubuntu 22.04).
FROM ubuntu:22.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ufw iptables iptables-persistent kmod \
 && rm -rf /var/lib/apt/lists/*
