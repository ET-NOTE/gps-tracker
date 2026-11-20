# Conditional remaining runtime

The server derives remaining time from the existing 520211 discharge evidence,
not from the rounded displayed SOC. Reference start: 2026-10-12 10:45 KST;
endpoint: 2026-10-14 13:48 KST. The interval is 183780 seconds (51 h 3 min).
MEGACANON two-cell parallel pack, sleep-disabled continuous-communication load.
The exact initial charger-disconnection time and cell capacity are unknown.
The endpoint is the user-selected repeated-brownout zero, not a safe cutoff.

`ops/build_battery_runtime.py` reproduces `battery-runtime-policy.json` from
`battery-percentage-evidence.json`, with the evidence SHA-256. Voltage anchors
map to the seconds remaining until the recorded endpoint. The top runtime anchor
is the observed 4113 mV, distinct from the 4200 mV display-SOC convention.
Calibrated ADC input is interpolated between these anchors; the reference total
caps the output. Existing voltage, percentage, and charging-warning policy stay
unchanged. This is a single-run reference model, not validated battery life for
arbitrary batteries or duty cycles.

Device list/detail responses contain `battery_runtime`, computed in Rust. Live
location events carry the same object, including no-fix messages. A new missing
ADC clears both voltage and runtime; delayed fixes cannot restore an older
estimate. Device ownership remains enforced by the existing API queries and WS
subscription policy. No DB schema changes, firmware changes, or new FCM sends.

The output includes remaining seconds, an absolute expected-empty timestamp,
measurement timestamp, reference duration, model version, and explanatory basis.
Readings older than 5 minutes (or >60 seconds in the future), missing ADC, known
sleep, and voltage above 4200 corrected mV suppress predictions. High voltage is
only an external-power possibility; this firmware does not confirm charging.
Lower-voltage charging cannot be reliably identified, so the UI explicitly says
the estimate assumes the same battery, sleep disabled, and no charging.

Device cards, device detail, and pinned home cards render the server prediction.
Long runtimes are rounded to 30 minutes; under one hour to 5 minutes. Dates use
Korean time. A visibility-aware 30-second clock expires stale predictions rather
than leaving a cached date on screen. The model's estimate is conditional and
will move with voltage recovery, load changes, and later telemetry.

Validation covers exact reference timestamps, interpolation, caps and monotonicity,
charging/sleep/stale/missing behavior, REST list/detail agreement, ownership,
phone exclusion, and delayed/missing live messages. The build runner also runs
existing web/API/notification regressions before promotion.
