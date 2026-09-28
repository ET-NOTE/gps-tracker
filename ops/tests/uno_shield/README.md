# UNO shield host regression tests

Compile the actual 03_10 sketch with deterministic Arduino/modem stubs. No serial ports or servers are accessed.

```sh
g++ -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -Iops/tests/uno_shield/stubs ops/tests/uno_shield/host_tests.cpp -o /tmp/shield-tests
/tmp/shield-tests > /tmp/shield-payloads.jsonl
```

Repeat with `-DSHIELD_DIAGNOSTICS=1` and `-DSHIELD_PLATFORM_TARGET=0` (legacy regression only). The included credentials header is an unmistakable synthetic test fixture; never use it for a device. The three stdout lines are valid JSON: one fix, an empty status report, and a full eight-point batch. Check their `shield_v`, `points`, byte length (<=1024) and integer UTC/microdegree coordinates with a JSON parser.

Covers GNSS quality/freshness, UTC/leap-year conversion, fixed-point precision, bounded sampling, oldest-sample eviction, retry retention, age expiry, timer wraparound, streamed body length, HTTP/GNSS exclusion, modem reset, non-200 responses, failed/uncertain connect/disconnect, 60/120/600-second reporting policy and automatic recovery. Physical UART, radio and SRAM margin still need AVR/live validation.

v12 also verifies NTP/RTC gating, no repeated clock synchronization on each POST, CA/time settings before connection, withholding key/body after TLS failures, redaction of private header failures/timeouts/echoes, and clock invalidation after both modem-reset paths. See the sketch's TLS validation record for actual modem checks; stubs alone cannot validate a certificate chain.
