#!/bin/sh
# Read-only capacity/settings. No environment files, credentials or user rows.
set -eu
date --iso-8601=seconds
nproc
free -m
df -h /
systemctl show gps-tracker-api.service -p User -p ActiveState -p NRestarts -p MemoryMax -p CPUQuotaPerSecUSec -p TasksMax
sudo -n -u postgres psql -X -A -F '|' -t -c "SELECT name,setting,unit FROM pg_settings WHERE name IN ('max_connections','superuser_reserved_connections','shared_buffers','effective_cache_size','work_mem','max_parallel_workers_per_gather','jit','statement_timeout') ORDER BY name"
