#!/usr/bin/env python3
"""Host boundary tests for actual sleep_mgr.cpp and telemetry.cpp (g++ required)."""
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
SCENARIOS = ["success", "timeout", "post_fail", "early_bounce", "no_lis", "active",
             "stuck_low", "i2c_error", "raw_error", "during_flush", "during_event",
             "wake_error", "timer_error", "during_shutdown", "timeout_motion",
             "sensor_shutdown", "after_rail", "sensor_after_rail", "hold_error", "final_interrupt"]


def main():
    count = 0
    with tempfile.TemporaryDirectory(prefix="gps-sleep-test-") as tmp:
        for kc in (0, 1):
            profile = "kc" if kc else "operating"
            exe = str(Path(tmp) / f"test-{profile}")
            flags = ["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror",
                            "-Wno-unused-parameter", f"-DKC_TEST_BUILD={kc}",
                            f'-DFIRMWARE_PROFILE="{profile}"',
                            f'-DFIRMWARE_VERSION="{profile}-test"',
                            f'-DFIRMWARE_BUILD_TAG="idf-caltest/{profile}-test"',
                            "-I", str(ROOT / "stubs")]
            subprocess.run([*flags, str(ROOT / "sleep_test.cpp"),
                            str(ROOT.parent / "main/telemetry.cpp"), "-o", exe], check=True)
            for scenario in SCENARIOS:
                subprocess.run([exe, scenario], check=True, stdout=subprocess.DEVNULL)
                count += 1
            normal, sleep = [json.loads(line) for line in subprocess.check_output(
                [exe, "payload"], text=True).splitlines()]
            assert normal["stationary"]["sleep_enabled"] == (not kc)
            assert normal["stationary"]["timer_wake_enabled"] == (not kc)
            assert normal["stationary"]["build_profile"] == profile
            assert normal["stationary"]["window_s"] == 300
            assert normal["stationary"]["timer_wake_s"] == 600
            assert normal["stationary"]["no_gps_grace_s"] == 600
            assert normal["build_tag"] == sleep["build_tag"] == f"idf-caltest/{profile}-test"
            assert sleep["diag"]["sleep_phase"] == "intent"
            assert len(normal["fixes"]) > 0
            count += 1
            lte_exe = str(Path(tmp) / f"lte-{profile}")
            subprocess.run([*flags, "-ffunction-sections", "-fdata-sections",
                            str(ROOT / "lte_shutdown_test.cpp"), "-Wl,--gc-sections",
                            "-o", lte_exe], check=True)
            for scenario in ("confirmed", "not_started", "silent", "ok_only", "error", "resume", "timeout_resume"):
                subprocess.run([lte_exe, scenario], check=True, stdout=subprocess.DEVNULL)
                count += 1
    print(f"PASS: {count} profile/scenario + JSON contract checks")


if __name__ == "__main__":
    main()
