# GPS profile layout and annual entitlements — 2026-11-03

## Request and result

Correct the imbalanced My Info account panel and add one year of account-type access for `user@user.com` and `user@user4.com`.

- Production web release: `profile-layout-20261103-r1`.
- Web build commit: `de6246b47992cb7cc7a8b357de74a9fa31b93392`.
- Company actions now use equal-width grid cells without an offset on the second button.
- Narrow-panel tabs wrap into a three-column grid; account-type cards align at the top and share row heights. At panel widths of 360px or less, actions/cards use one column.
- Headings, card surfaces, spacing, field wrapping and selected states are consistent. Fixed the existing undefined `st.btnPrimary` reference on the apply button.
- Account-type changes and invitation-modal focus were checked with an isolated fixture; real account preferences were not changed during UI verification.

## Annual entitlements

Added 365 days after each existing final expiry, preserving the remaining period and all existing records. These are complimentary subscriptions, not wallet credit or paid purchases.

| Account | Kind | Final expiry (Asia/Seoul) | Inserted subscription |
| --- | --- | --- | --- |
| user@user.com | corporate_report | 2027-12-05 19:56:15 | 10 |
| user@user.com | rentcar_report | 2027-11-22 18:43:18 | 11 |
| user@user4.com | corporate_report | 2027-11-22 19:04:07 | 12 |
| user@user4.com | rentcar_report | 2027-11-22 19:04:07 | 13 |

Delivery has no paid entitlement gate, so no invented delivery subscription was inserted. User credits, account types, old subscriptions, device data and credit ledger counts are unchanged.

Grant marker: `operator-grant:20261103:business-365d:455498a4`. The grant script acquires the same per-user/kind advisory locks as purchasing, validates exact accounts and runs atomically. Replaying it returned the same four records without duplication.

Restricted server evidence: `/home/mmm/gps-artifacts/profile-layout-20261103/subscription-before.json` and `subscription-grant.json`.

## Verification

- Web tests: 196 passed, 0 failed, 0 skipped; production Vite build succeeded.
- Initial archive omitted the shared `gps-tracker-api/battery-policy.json`, causing nine test-file failures. Included that tracked file in the source archive and reran the full suite successfully. The initial failed log is retained on the build host.
- The build completed, but a CRLF on the final shell `tail` caused its wrapper to return nonzero. The successful test/build log and artifact were independently checked; normalized the helper to LF. No application change was needed.
- Isolated fixture: 440px panel, 390px and 320px mobile layouts, administrator and ordinary member views, dark theme, account-type apply, invitation initial focus and Escape focus return.
- Production signed-in user4: desktop panel, 390px and 320px widths. At 390px, all four type cards measured 162px by 116.89px and both company actions 162px by 44px. At 320px, actions/cards measured 262px wide in one column. Document and tab scroll widths equal their available widths. No browser console errors recorded.
- Public asset hashes, SPA routes, health and existing diagnostic endpoints checked after deployment. Health remains `location-storage-20261031-r1`.
- API binary/source tree, environment, nginx, service process identities, dev web/API and Shield targets unchanged. API/database schema and APK were not changed.

## Release and rollback

Production web: `/home/mmm/releases/profile-layout-20261103-r1/web`.
Previous web: `/home/mmm/releases/gps-final-20261031-r1/web`.
The guarded release script switches only the web symlink and automatically rolls back on verification failure. Existing immutable assets were inherited with hard links (901 files) for already-open clients.

Source/archive hashes, validation, baseline and deployment evidence are under `/home/mmm/gps-artifacts/profile-layout-20261103-r1` and `/home/mmm/releases/profile-layout-20261103-r1`.

Local evidence: `C:/Users/msb/AppData/Local/GPS-Builds/profile-layout-20261103/`, including `production-desktop.png`, `production-mobile.png`, build log and grant result.
