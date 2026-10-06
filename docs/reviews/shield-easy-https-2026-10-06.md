# Independent easy HTTPS example — 2026-10-06

- Added `arduino/shield_examples/07_easy_https`, without changing examples 01–06 or their shared driver.
- Public article: https://shield.serial.kr/examples/shield-uno-easy-https
- ZIP: https://drive.google.com/file/d/12SCq4XQOdIFfflFD2bEJvyIREBy-s0Aj/view
- Sketch: https://drive.google.com/file/d/10TKny-9mIBUULH5TH-3s9W_5z8xxEATw/view
- Guide: https://drive.google.com/file/d/1C8-a8s_OE6M91kylWec17n6nbJDgI8Fv/view
- Local package: `E:/project/2025/shield-examples/2026-10-06/https/07_easy_https.zip`.

The sketch embeds public ISRG Root X1 in flash, compares its dedicated modem PEM
file by size and content, repairs a missing/corrupt file and confirms conversion
at boot. APN, UID and the existing per-device HTTPS key are the only user settings.
It sends actual LTE status, without fabricated sensors/coordinates. TLS failures
do not trigger HTTP fallback. An uncertain command/data stream stops until reset.

Validation: UNO AVR core 1.8.6 compile (17,408 B flash, 1,018 B SRAM); maximum UID
and configured test-key compile (17,524 B flash, 1,092 B SRAM); 17 modem transcript
scenarios under ASan/UBSan; actual JSON template authentication, claim and ingest
checks against isolated `shield_test`. PC TLS 1.2 chain and hostname verified.
**Physical modem CA provisioning and LTE HTTPS transmission remain unverified.**
No device was flashed or sent production telemetry by this task.

Public Drive downloads were verified anonymously against all three local hashes.
The create-only publisher registered metadata and checked anonymous 307 redirects;
no binary files were uploaded to the VPS attachment store. Existing 27 posts,
start-guide setting, library order, category thumbnails and financial counts were
unchanged. No app/service/nginx change was needed for this article.

Pre-publication backup `shield-20261006T085829Z.tar.gz`, SHA-256
`d433570150bba7c16456d23f1589505efc66c57fd6d7ca2f8bcc50255d4c7a7f`, was copied to
etcom-hub and restored successfully on PostgreSQL 14 (schema 1–12).
