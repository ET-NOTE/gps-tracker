# UNO shield host regression tests

Compile the actual 03_10 sketch against a deterministic modem/Arduino stub on a C++17 host. No physical serial port, credentials or server requests are used.

From the repository root:

```sh
g++ -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -fno-omit-frame-pointer -Iops/tests/uno_shield/stubs \
  ops/tests/uno_shield/host_tests.cpp -o /tmp/uno-shield-tests
/tmp/uno-shield-tests > /tmp/uno-shield-payloads.jsonl
python3 -c 'import json; rows=[json.loads(line) for line in open("/tmp/uno-shield-payloads.jsonl")]; assert len(rows)==2; assert rows[0]["lte"]["fix"] is True; assert rows[1]["lte"]["fix"] is False'

g++ -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -fno-omit-frame-pointer -DSHIELD_DIAGNOSTICS=1 -Iops/tests/uno_shield/stubs \
  ops/tests/uno_shield/host_tests.cpp -o /tmp/uno-shield-tests-dbg
/tmp/uno-shield-tests-dbg > /tmp/uno-shield-payloads-dbg.jsonl
python3 -c 'import json; rows=[json.loads(line) for line in open("/tmp/uno-shield-payloads-dbg.jsonl")]; assert len(rows)==2; assert rows[0]["lte"]["fix"] is True; assert rows[1]["lte"]["fix"] is False'
```

Covers GNSS/HTTP sequencing, cleanup after failed connection/configuration/request, timeout and modem reboot, GNSS restore failure, non-200 responses, automatic retry and periodic posting, registration loss, malformed/low-quality/stale fixes, JSON generation and buffer limits, and timer wraparound. These host tests complement the AVR build and live COM26/server verification; they do not model UART timing, electrical behavior or cellular connectivity.

Also verifies the bounded 600-second initial acquisition window, 120-second warm window after a sent fix, return to 600 seconds after sustained signal loss, 60-second reporting with a fresh fix, no network recovery during GNSS acquisition, recovery with GNSS kept off after HTTP failures, missing raw fix status, overlong coordinates, and invalid/overflowing satellite counts.

Diagnostic builds test manual RF-off GNSS timeout, early fix, uncertain CFUN=0 result, failed CFUN=1 recovery (both `i` and `n`) and modem reboot; automatic DNS diagnostics run once per failure streak. Normal builds test that manual keys and detailed diagnostics do not run. Empty GNSS replies must not refresh the timestamp of an old coordinate.

HTTP state tests include an already-open modem session after UNO reset, no redundant disconnect/query after a confirmed close, ambiguous SHCONN/SHDISC timeouts, failed closure preventing GNSS restart, state-query failure, and successful recovery on the following attempt. Payload expiry is tested against the actual HTTP function, including its updated `withFix` result.
