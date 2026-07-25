#!/usr/bin/env python3
"""
Import legacy points.ndjson (Python testbed) into PostgreSQL location_records.
Creates anon device 'legacy-l80-import' (NULL owner) so the user can claim it
via the web UI's pair form.

Run on the SERVER (where DB is reachable):
  python3 import_legacy_ndjson.py
"""
import os, json, glob, sys, re
from datetime import datetime
import psycopg2
from psycopg2.extras import execute_batch

DEVICE_UID  = "legacy-l80-import"
DEVICE_LABEL = "레거시 L80 이력"
NDJSON_GLOB = "/home/deploy/projects/gps-tracker/data/points.ndjson*"

# pull DATABASE_URL from gps-tracker-api .env
ENV_PATH = "/home/deploy/projects/gps-tracker-api/.env"
db_url = None
with open(ENV_PATH) as f:
    for line in f:
        m = re.match(r"^DATABASE_URL=(.*)$", line.strip())
        if m: db_url = m.group(1); break
if not db_url:
    print("DATABASE_URL not found in", ENV_PATH); sys.exit(1)

conn = psycopg2.connect(db_url)
conn.autocommit = False
cur = conn.cursor()

# ── 1. ensure device row (anon: owner_id NULL) ────────────────────────────
cur.execute("""
    INSERT INTO devices (device_uid, display_name, api_key_hash, last_seen_at)
    VALUES (%s, %s, '', now())
    ON CONFLICT (device_uid) DO UPDATE SET display_name = EXCLUDED.display_name
    RETURNING id, owner_id
""", (DEVICE_UID, DEVICE_LABEL))
device_id, owner_id = cur.fetchone()
print(f"device id={device_id} (owner_id={owner_id}) — uid={DEVICE_UID}")

# ── 2. iterate NDJSON files, batch-insert location rows ───────────────────
files = sorted(glob.glob(NDJSON_GLOB))
print(f"NDJSON files: {len(files)}")
rows = []
for path in files:
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try:
                rec = json.loads(line)
            except Exception as e:
                print(f"  skip bad json in {path}: {e}"); continue

            received_at = rec.get("received_at")
            if not received_at: continue
            try:
                ts = datetime.fromisoformat(received_at.replace("Z", "+00:00"))
            except Exception:
                continue

            payload = rec.get("payload") or {}
            l80     = payload.get("l80") or {}
            fix     = bool(l80.get("fix"))
            lat     = l80.get("lat")
            lng     = l80.get("lng")
            sat     = l80.get("sat")
            ttff    = l80.get("ttff_s")
            vbat    = payload.get("vbat_mv")
            csq     = payload.get("csq")
            reg     = payload.get("reg")
            uptime  = payload.get("ts")

            rows.append((device_id, ts, uptime, "l80", fix, lat, lng, sat, ttff,
                         csq, reg, vbat, json.dumps(rec)))

print(f"rows to insert: {len(rows)} (fix=true: {sum(1 for r in rows if r[4])})")

# ── 3. INSERT (idempotent via PK on device_id+recorded_at+source) ─────────
sql = """
    INSERT INTO location_records
        (device_id, recorded_at, device_uptime_s, source, fix, lat, lng,
         sat, ttff_s, csq, reg, vbat_mv, raw)
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
    ON CONFLICT (device_id, recorded_at, source) DO NOTHING
"""
execute_batch(cur, sql, rows, page_size=200)

# update device last_seen + last_fix from the latest row in this import
cur.execute("""
    UPDATE devices SET
      last_seen_at = (SELECT MAX(recorded_at) FROM location_records WHERE device_id = %s),
      last_fix_at  = (SELECT MAX(recorded_at) FROM location_records WHERE device_id = %s AND fix),
      last_lat = (SELECT lat FROM location_records WHERE device_id = %s AND fix ORDER BY recorded_at DESC LIMIT 1),
      last_lng = (SELECT lng FROM location_records WHERE device_id = %s AND fix ORDER BY recorded_at DESC LIMIT 1)
    WHERE id = %s
""", (device_id, device_id, device_id, device_id, device_id))

conn.commit()

# ── 4. show result ────────────────────────────────────────────────────────
cur.execute("SELECT COUNT(*), COUNT(*) FILTER (WHERE fix) FROM location_records WHERE device_id=%s", (device_id,))
total, with_fix = cur.fetchone()
print(f"location_records for device {device_id}: total={total}, with fix={with_fix}")
print(f"\nNext: log into the web app and pair device_uid '{DEVICE_UID}' to claim it.")

cur.close(); conn.close()
