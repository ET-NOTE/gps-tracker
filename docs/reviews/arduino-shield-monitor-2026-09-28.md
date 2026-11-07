# Arduino shield monitor deployment — 2026-09-28

## Delivered

- Production: https://gps.serial.kr/arduino-shield
- Development: https://dev-gps.serial.kr/arduino-shield
- JSON: same path plus `/data`.
- API source commit: `a7be64e`, release `dev-20260928-101122-a7be64e`.
- API SHA-256: `a0084ef91249bfccf951875d45c7751e6d2112691ef9b5757d742771f09c219d`.

The page shows last receipt age, count in the last 24 hours, PV voltage and trend,
GPS fix availability, signal/registration, firmware and the latest 100 receipt
records. Refresh is every 10 seconds while visible, with manual refresh, explicit
empty/error/stale states, and CSV export. It uses only the existing unclaimed
`uno-shield-test` device. Unknown query fields return 400; a claimed device is
excluded. Coordinates, raw payloads and SIM identifiers are not returned.

The new route is independent of `/diagnostic`. Exact nginx locations were added
for the new page/data; the existing diagnostic, ingest and web locations remain
unchanged. This was an API-only deployment: the product SPA and its version.json
remain on the previous `18c829d` release. No schema/env change or DB data migration.

## Validation

- Built on etcom-hub using the existing bounded Docker runner, not on the VPS.
- Rust fmt/clippy passed, 8 unit tests plus the isolated FCM DB integration test
  passed, and all 29 web regression tests passed.
- Disposable PostgreSQL SQL tests passed for the fixed UID, ownership exclusion,
  24-hour boundary, 100-row cap, field minimization and malformed/oversized PV.
- Page JavaScript syntax check and browser preview with real received values passed.
- Dev deployed first; its empty data response is expected because the physical
  shield posts to prod. Prod then displayed the actual shield receipt history.
- Both environments return no-store data responses and reject arbitrary UID query
  arguments. Production `/`, `/version.json`, `/diagnostic`, and `/diagnostic/device`
  bytes equal their pre-deployment hashes. The same checks passed on dev.
- HTTP and HTTPS `/ingest` still return the expected 400 for an invalid payload,
  without inserting test records or redirecting the HTTP firmware route.
- Migration version/count remains 65/65. Environment-file hashes are unchanged.
- Production API error/panic log count since 10:16 KST: 0 at the follow-up check.
- First dev deployment safely rolled back when an old nginx worker answered the
  immediate post-reload probe. The deploy helper now waits for the new route;
  the retry and prod deployment succeeded.

At 10:19 KST the page reported 18 real receipts and the current
`shield-http-20260928-v7` firmware. GPS remained in acquisition; no successful
physical coordinate upload is claimed. After COM26 monitoring ended at 10:13:39,
server receipts continued, including 10:18:32 and 10:19:36 KST.

Firmware work is separate: branch `codex/uno-shield-http-recovery`, source commit
`3ced2a7`, PR https://github.com/ET-NOTE/gps-tracker/pull/244. It modifies 03_10,
not 03_8 or KC firmware. Its 10-minute final serial capture contained 9 HTTP 200
responses and no final HTTP failures.

## Rollback artifacts

The original API binary/nginx configuration and preflight hashes were saved on
the VPS and copied to Windows before each deployment. API deployment automatically
restores the previous binary/configuration if verification fails.

- VPS `/home/mmm/backups/gps-shield-prod-dev-20260928-101122-a7be64e`
- VPS `/home/mmm/backups/gps-shield-dev-dev-20260928-101122-a7be64e`
- Windows `%LOCALAPPDATA%\GPS-PrivateBackups\` with the same directory names.
- Prod backup archive SHA-256:
  `889c9d22002677b1c3482e779df33cb3dae5d46ae43e5468dfa77085177d48d4`.
- Dev backup archive SHA-256:
  `4227f95f9eefab1da069730ed9cba2b307f3a322472709f512585655f3c7d0d5`.

Backups and physical-device logs are private local artifacts, not Git content.
