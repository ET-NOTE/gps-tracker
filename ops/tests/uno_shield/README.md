# UNO shield host regression tests

Compile the actual 03_10 sketch against a deterministic modem/Arduino stub on a C++17 host. No physical serial port, credentials or server requests are used.

From the repository root:

```sh
g++ -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -fno-omit-frame-pointer -Iops/tests/uno_shield/stubs \
  ops/tests/uno_shield/host_tests.cpp -o /tmp/uno-shield-tests
/tmp/uno-shield-tests > /tmp/uno-shield-payloads.jsonl
python3 -c 'import json; rows=[json.loads(line) for line in open("/tmp/uno-shield-payloads.jsonl")]; assert len(rows)==2; assert rows[0]["lte"]["fix"] is True; assert rows[1]["lte"]["fix"] is False'
```

Covers GNSS/HTTP sequencing, cleanup after failed connection/configuration/request, timeout and modem reboot, GNSS restore failure, non-200 responses, automatic retry and periodic posting, registration loss, malformed/low-quality/stale fixes, JSON generation and buffer limits, and timer wraparound. These host tests complement the AVR build and live COM26/server verification; they do not model UART timing, electrical behavior or cellular connectivity.
