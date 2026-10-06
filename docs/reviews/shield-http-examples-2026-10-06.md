# Four paired Shield examples — 2026-10-06

User approved Shield server support for existing 04/06, new 07 HTTPS, and new 08
plain HTTP. Explicitly confirmed: owner-issued, 24-hour educational UID; LTE status
only. This does not authorize weakening the GPS/KC or normal Shield ingestion path.

## Implementation

- Schema 13 adds only `http_demo_links`, with hash-only UID storage and owner/expiry.
- Owner session settings API and 내 장치 → HTTP 학습 연결 dialog. Off by default;
  one-time credential display, rotation and disabling, no local-storage persistence.
- Dedicated `/ingest/shield-demo`, 1 KiB, explicit v2 status contract. No GPS/sensors/
  voltage/operational key. Plain HTTP elsewhere still redirects to HTTPS.
- Row-lock recheck serializes credential changes and ingestion. Owner mismatch,
  disabled accounts, expiry and revocation fail closed. Device/IP request bounds.
- Existing 04/06 sources, existing 07, original common modem driver, device keys,
  team-authored posts, GPS/KC binaries and settings remain unchanged.
- New independent `08_shield_http_pairing`: two placeholders, clear failure stages,
  no certificate/clock setup, no insecure fallback, no immediate/offline retries.
  SHCHEAD follows SHCONN as required by SIMCom, before SHREQ. Stored TLS/CA settings
  are not changed. It is not a security-equivalent production pairing mechanism.
- Backup/restore includes the new table. Exact schema/config deployment guard and
  fix-forward recovery instructions are in `ops/shield/README.md`.

## Validation before production

- Arduino UNO core 1.8.6, CLI 1.2: placeholder 7,534 B flash / 553 B SRAM;
  configured synthetic UID/APN 11,850 B flash / 849 B SRAM (1,199 B remaining).
- Ten actual HTTP driver transcript scenarios under ASan/UBSan, including unknown
  prompt/result stream, modem restart, bad SIM, redirects, errors and rate limits.
- 38 isolated API checks using actual 04/06/07/08 printf templates, including
  ownership/expiry/rotation/rate/disable concurrency and retained DHT channels.
- 40 existing API integration checks and seven WebSocket checks passed.
- PostgreSQL 14 additive migration and role/DB isolation checks passed; nine exact
  nginx proxy checks passed against disposable loopback listeners.
- Existing GPS binary check, Shield six unit tests, clippy, web 21 tests and release
  build passed in preview. Final artifact is built again from a clean Git commit.
- Browser checked anonymous disabled control, synthetic owner device data, and
  HTTP learning dialog default state. No actual device was enabled or flashed.

Package: `E:/project/2025/shield-examples/2026-10-06/http/08_shield_http_pairing.zip`.
New lesson slug: `shield-uno-http-pairing`; create-only publication with Drive
downloads, preserving all existing posts. Physical UNO/SIM7080G LTE transmission
remains unverified and is labelled as such in the lesson and README.

SIMCom references:
- https://files.waveshare.com/upload/0/02/SIM7070_SIM7080_SIM7090_Series_AT_Command_Manual_V1.03.pdf
- https://files.waveshare.com/upload/b/bb/SIM7070_SIM7080_SIM7090_Series_HTTP%28S%29_Application_Note_V1.02.pdf
