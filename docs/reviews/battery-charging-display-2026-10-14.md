# Charging voltage display, 2026-10-14

The user reported that device 520211 displayed an unknown battery voltage while
fully charged and connected to a fast charger. A read-only production query found
ADC `vbat_mv=4772` and modem `cbc_mv=4792` at
`2026-10-14T16:56:54.975569+09:00` (device 3163). The previous display validation
rejected all ADC readings above 4500 mV. Recent ADC readings were 4770–4776 mV;
the maximum during the 16:00 hour at the time of inspection was 4858 mV.

The user requested a normal ceiling at the current received voltage plus 500 mV.
The shared policy now uses **5272 raw ADC mV**, inclusive, as that fixed ceiling.
It is not recomputed from future readings. Above it, the UI and server battery
formatter use `과충전`; voltage remains visible and percentage remains capped at
100. Existing low-voltage thresholds and the discharge/SOC fit are unchanged.
The existing endpoint calibration adds 3 mV in this range (4772 raw → 4775 display
mV). The classification ceiling is explicitly in raw units to avoid changing the
requested 500 mV headroom through calibration.

Input validity and classification are separate. GPS firmware sends an unsigned
16-bit ADC mV value, so the accepted upper limit is 65535 mV rather than the old
4500 mV. Missing, nonfinite, negative, below-minimum and out-of-protocol values
remain unknown. CBC is never substituted for missing ADC. Raw database telemetry
is preserved. This change does not introduce additional push notifications.

`정상` and `과충전` are user-selected application classifications. These readings
alone do not establish the cell-terminal voltage, charger negotiation, a safe
charging limit, or a physical overcharge diagnosis. Charging/USB operation remains
outside the validated discharge fit. The battery tooltip records this limitation.

Regression coverage includes the old 4500 mV limit, the observed charging values,
the inclusive 5272/5273 boundary, continued voltage display above the boundary,
the firmware range, missing ADC behavior, offline priority, and SQL/Rust integer
calibration parity over 0–65536 mV.
