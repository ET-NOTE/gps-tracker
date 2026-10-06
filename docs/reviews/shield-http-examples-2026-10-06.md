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

## Production result

Deployed `shield-20261006-182948-3fee7c8` from the clean Git source on etcom-hub.
Archive SHA256: `6796d5c24bb39460bae86e680808030273c55248f3d3087fa33f9a8ab2f208ac`.
Schema 1–13 healthy; Shield and GPS services active. Deployment verified the GPS
binary hash/process and every non-Shield nginx configuration remained unchanged.
Shield environment and credentials remained unchanged. nginx syntax and recent
Shield warning/error journal checks passed.

- 34 existing production smoke/isolation/WebSocket checks passed.
- 20 production checks passed for the four actual UNO templates, HTTP issuance,
  one-time/no-store response, duplicate handling, rejected sensor data, HTTPS
  redirects, owner visibility and revocation. Only synthetic fixture data used.
- Synthetic device, sensor channels, readings and sessions removed. One disabled
  synthetic actor is retained because HTTP setting changes have immutable audit
  records. Cleanup now respects that constraint; no audit trigger was bypassed.
- No real device enabled for HTTP: `http_demo_links` has zero rows after testing.
- New post https://shield.serial.kr/examples/shield-uno-http-pairing is public,
  revision 1. All 28 previous posts and guide/order/thumbnail/payment settings
  preserved. Three anonymous Google Drive download hashes and metadata redirects
  passed. Browser checked the published four-step page and three attachment links.
- ZIP: https://drive.google.com/file/d/1n5q4T2X4QWVSZFphOJ1Q_k1OUrJWpdkv/view
- Sketch: https://drive.google.com/file/d/1t-G4LUXglseUnit7Y7oppiw8RPQSQosJ/view
- Guide: https://drive.google.com/file/d/161DnGlZWts9SkLHrf1fYMtf0H9oKEVcJ/view

Before backup: `shield-20261006T092948Z.tar.gz`, SHA256
`b7e67bf30ae04e05959ac971ac8e086dfa07d1111feb79c29d5e008bdb93b508`.
After backup: `shield-20261006T093254Z.tar.gz`, SHA256
`8317be52daa575c72016ec4141d29c45e74401d06d43f7b35ac22a5f4dd83c06`.
Both restored offsite on PostgreSQL 14. After restore: 29 posts, 64 verified image
hashes, 44 verified file hashes, schema 1–13; original one device, 1,774 readings,
8,116 location records preserved. Financial tables remain empty.

Physical LTE/TLS execution remains pending; server compatibility is verified,
not a substitute for uploading and running each sketch on the actual shield.
