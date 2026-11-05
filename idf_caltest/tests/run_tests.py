#!/usr/bin/env python3
"""Host boundary tests for actual sleep_mgr.cpp and telemetry.cpp (g++ required)."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
SCENARIOS = ["remote_short", "success", "wrap", "timeout", "post_fail", "early_bounce", "bounce_abort", "no_lis", "active",
             "stuck_low", "i2c_error", "raw_error", "during_flush", "during_event",
             "wake_error", "timer_error", "during_shutdown", "timeout_motion",
             "sensor_shutdown", "after_rail", "sensor_after_rail", "hold_error", "final_interrupt"]


def main():
    count = 0
    with tempfile.TemporaryDirectory(prefix="gps-sleep-test-") as tmp:
        cjson = Path(os.environ["IDF_PATH"]) / "components/json/cJSON"
        cjson_object = str(Path(tmp) / "cjson.o")
        subprocess.run(["gcc","-I",str(cjson),"-c",str(cjson/"cJSON.c"),"-o",cjson_object],check=True)
        config_exe=str(Path(tmp)/"report-config")
        subprocess.run(["g++","-std=c++17","-DKC_TEST_BUILD=0","-DBATTERY_TEST_BUILD=0","-Wall","-Wextra","-Werror","-Wno-unused-parameter","-I",str(ROOT/"stubs"),"-I",str(cjson),str(ROOT/"report_config_test.cpp"),cjson_object,"-o",config_exe],check=True)
        subprocess.run([config_exe],check=True)
        count+=1
        collection_exe=str(Path(tmp)/"collection-control")
        for kc in (0,1):
            subprocess.run(["g++","-std=c++17",f"-DKC_TEST_BUILD={kc}","-DBATTERY_TEST_BUILD=0","-Wall","-Wextra","-Werror","-Wno-unused-parameter","-I",str(ROOT/"stubs"),"-I",str(cjson),str(ROOT/"collection_control_test.cpp"),cjson_object,"-o",collection_exe],check=True)
            subprocess.run([collection_exe],check=True)
        count+=1
        bench_config = str(Path(tmp)/"bench-config")
        subprocess.run(["g++","-std=c++17","-DKC_TEST_BUILD=0","-DGPS_HTTPS_PILOT=1","-DGPS_HTTPS_SLEEP_TEST=1",
                        "-Wall","-Wextra","-Werror","-Wno-unused-parameter","-I",str(ROOT/"stubs"),"-I",str(cjson),
                        str(ROOT/"sleep_bench_config_test.cpp"),cjson_object,"-o",bench_config],check=True)
        subprocess.run([bench_config],check=True)
        count+=1
        pilot = str(Path(tmp) / "https-pilot")
        subprocess.run(["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror", "-Wno-unused-parameter",
                        "-DKC_TEST_BUILD=0", "-DBATTERY_TEST_BUILD=0", "-DGPS_HTTPS_PILOT=1",
                        "-ffunction-sections", "-fdata-sections", "-I", str(ROOT/"stubs"),
                        str(ROOT/"https_pilot_test.cpp"), "-Wl,--gc-sections", "-o", pilot], check=True)
        for case in ("valid_clock", "cold_clock", "gps_epoch_clock", "invalid_calendar", "clock_stuck", "clock_failure",
                     "ntp_time_reply", "ntp_error_code", "ntp_code_prefix", "ntp_invalid_code", "ntp_incomplete"):
            subprocess.run([pilot, case], check=True)
            count += 1
        tcp=str(Path(tmp)/"modem-tcp")
        subprocess.run(["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror", "-Wno-unused-parameter",
                        "-DKC_TEST_BUILD=0", "-DBATTERY_TEST_BUILD=0", "-DGPS_HTTPS_PILOT=1",
                        "-I", str(ROOT/"stubs"), str(ROOT/"modem_tcp_test.cpp"), "-o", tcp], check=True)
        subprocess.run([tcp],check=True)
        count+=1
        for profile, kc, battery in (("operating", 0, 0), ("kc", 1, 0), ("battery", 0, 1), ("https-pilot", 0, 0), ("https-sleep-test", 0, 0)):
            bench = profile == "https-sleep-test"
            is_pilot = profile in ("https-pilot", "https-sleep-test")
            sleep_enabled = profile in ("operating", "https-sleep-test")
            exe = str(Path(tmp) / f"test-{profile}")
            flags = ["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror",
                            "-Wno-unused-parameter", f"-DKC_TEST_BUILD={kc}",
                            f"-DBATTERY_TEST_BUILD={battery}", f"-DGPS_HTTPS_PILOT={int(is_pilot)}",
                            f"-DGPS_HTTPS_SLEEP_TEST={int(bench)}",
                            f'-DFIRMWARE_PROFILE="{profile}"',
                            f'-DFIRMWARE_VERSION="{profile}-test"',
                            f'-DFIRMWARE_BUILD_TAG="idf-caltest/{profile}-test"',
                            "-I", str(ROOT / "stubs")]
            subprocess.run([*flags, str(ROOT / "sleep_test.cpp"),
                            str(ROOT.parent / "main/telemetry.cpp"), "-o", exe], check=True)
            for scenario in SCENARIOS:
                subprocess.run([exe, scenario], check=True, stdout=subprocess.DEVNULL)
                count += 1
            if bench:
                subprocess.run([exe, "bench_limit"],check=True)
                count += 1
            normal, sleep = [json.loads(line) for line in subprocess.check_output(
                [exe, "payload"], text=True).splitlines()]
            assert normal["stationary"]["sleep_enabled"] == sleep_enabled
            assert normal["stationary"]["timer_wake_enabled"] == sleep_enabled
            assert normal["stationary"]["build_profile"] == profile
            assert normal["stationary"]["window_s"] == (30 if bench else 300)
            assert normal["stationary"]["timer_wake_s"] == (60 if bench else 86400)
            assert normal["stationary"]["sleep_report_remote"] == (sleep_enabled and not bench)
            assert normal["stationary"]["sleep_report_saved"] == (not bench)
            assert normal["stationary"]["no_gps_grace_s"] == (20 if bench else 600)
            assert normal["build_tag"] == sleep["build_tag"] == f"idf-caltest/{profile}-test"
            assert sleep["diag"]["sleep_phase"] == "intent"
            assert len(normal["fixes"]) > 0
            count += 1
            paused=[json.loads(line) for line in subprocess.check_output([exe,"collection_paused"],text=True).splitlines()]
            for payload in paused:
                assert set(payload)=={"build_tag","device_uid","iccid","imei","imsi"}
            count+=1
            lte_exe = str(Path(tmp) / f"lte-{profile}")
            subprocess.run([*flags, "-ffunction-sections", "-fdata-sections",
                            str(ROOT / "lte_shutdown_test.cpp"), "-Wl,--gc-sections",
                            "-o", lte_exe], check=True)
            for scenario in ("confirmed", "not_started", "silent", "ok_only", "error", "resume", "timeout_resume"):
                subprocess.run([lte_exe, scenario], check=True, stdout=subprocess.DEVNULL)
                count += 1
            power_exe = str(Path(tmp) / f"power-{profile}")
            subprocess.run([*flags, str(ROOT / "power_test.cpp"), "-o", power_exe], check=True)
            for scenario in ("success", "fail_rail", "fail_key", "fail_dtr"):
                subprocess.run([power_exe, scenario], check=True, stdout=subprocess.DEVNULL)
                count += 1
    print(f"PASS: {count} profile/scenario + JSON contract checks")


if __name__ == "__main__":
    main()
