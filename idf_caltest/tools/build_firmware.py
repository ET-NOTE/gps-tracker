#!/usr/bin/env python3
"""Build one explicit profile in an activated ESP-IDF environment. Never flashes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

PROJECT = Path(__file__).resolve().parents[1]
REPO = PROJECT.parent


def output(*args, cwd=REPO):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_digest():
    # Includes uncommitted/new source files, excludes generated profile output.
    files = [p for p in PROJECT.rglob("*") if p.is_file()
             and not any(part in {"build", "managed_components", "__pycache__"}
                         for part in p.relative_to(PROJECT).parts)
             and p.name != "sdkconfig.old"]
    entries = {p.relative_to(PROJECT).as_posix(): sha(p) for p in sorted(files)}
    digest = hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest()
    return digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", choices=("operating", "https-operating", "https-pilot", "https-sleep-test", "tls-cert-test", "kc", "battery"))
    parser.add_argument("--test-ca-header", type=Path)
    parser.add_argument("--source-manifest", type=Path,
                        help="Hash-verified Git source archive metadata for an isolated build host")
    args = parser.parse_args()
    if (args.profile == "tls-cert-test") != bool(args.test_ca_header):
        parser.error("Only tls-cert-test requires --test-ca-header")
    extra = []
    ca_hash = None
    if args.test_ca_header:
        args.test_ca_header = args.test_ca_header.resolve(strict=True)
        ca_hash = sha(args.test_ca_header)
        extra = ["-D", f"TLS_TEST_CA_HEADER={args.test_ca_header.as_posix()}"]
    idf = Path(os.environ["IDF_PATH"])
    # The dependency lock is part of the source contract. Don't silently resolve
    # it against the older SDK installed on some developer PCs.
    version = output(sys.executable, str(idf / "tools/idf.py"), "--version")
    if not re.search(r"\bv5\.5\.4\b", version):
        raise SystemExit(f"ESP-IDF v5.5.4 required by dependencies.lock; found {version}")
    if args.source_manifest:
        metadata = json.loads(args.source_manifest.read_text(encoding="utf-8"))
        commit, dirty = metadata["git_commit"], metadata["dirty"]
        if not re.fullmatch(r"[0-9a-f]{40}", commit) or not isinstance(dirty, bool):
            raise SystemExit("Invalid source archive identity")
        for name, expected in metadata["files_sha256"].items():
            file = (REPO / name).resolve()
            if not file.is_relative_to(PROJECT) or sha(file) != expected:
                raise SystemExit(f"Source archive hash mismatch: {name}")
    else:
        commit = output("git", "rev-parse", "HEAD")
        dirty = bool(output("git", "status", "--porcelain", "--", "idf_caltest"))
    revision = commit[:8] + ("-dirty" if dirty else "")
    before = source_digest()
    lock_before = sha(PROJECT / "dependencies.lock")
    build = PROJECT / "build" / args.profile
    build.mkdir(parents=True, exist_ok=True)
    # Fresh output metadata prevents a failed build leaving a successful manifest.
    manifest = build / "manifest.json"
    manifest.unlink(missing_ok=True)
    sdkconfig = build / "sdkconfig"
    shutil.copyfile(PROJECT / "sdkconfig", sdkconfig)
    if args.profile in ("https-operating", "https-pilot", "https-sleep-test", "tls-cert-test"):
        config = sdkconfig.read_text().replace("# CONFIG_MBEDTLS_HAVE_TIME_DATE is not set", "CONFIG_MBEDTLS_HAVE_TIME_DATE=y")
        sdkconfig.write_text(config)
    subprocess.run([sys.executable, str(idf / "tools/idf.py"), "-B", str(build),
                    "-D", f"SDKCONFIG={sdkconfig.as_posix()}",
                    "-D", f"FIRMWARE_PROFILE={args.profile}",
                    "-D", f"FIRMWARE_REVISION={revision}", *extra, "build"],
                   cwd=PROJECT, check=True)
    if sha(PROJECT / "dependencies.lock") != lock_before or source_digest() != before:
        raise SystemExit("Source/dependency lock changed during build; inspect and rebuild")
    if args.test_ca_header and sha(args.test_ca_header) != ca_hash:
        raise SystemExit("Test CA changed during build")
    binary = build / "caltest.bin"
    match = re.search(rb'FW-CONFIG:(\{[^\x00]+\})\x00', binary.read_bytes())
    if not match:
        raise SystemExit("Compiled firmware settings missing from binary")
    settings = json.loads(match[1])
    if settings["profile"] != args.profile:
        raise SystemExit("Compiled profile mismatch")
    if args.profile == "kc" and (settings["kc_test"] != 1 or
            settings["sleep_disabled"] != 1 or settings["loop_wdt_enabled"] != 0 or
            settings["buzzer_enabled"] != 0):
        raise SystemExit("KC protection mismatch")
    expected_url = ("https" if args.profile in ("https-operating", "https-pilot", "https-sleep-test") else "http") + "://gps.serial.kr/ingest"
    if args.profile == "tls-cert-test":
        expected_url = "https://gps.serial.kr:18443/tls-probe"
        if settings["request_auth"] != "none_test_probe" or settings["credential_store"] != "unused":
            raise SystemExit("Certificate test must not use production credentials")
    if settings["ingest_url"] != expected_url:
        raise SystemExit("Compiled ingest URL mismatch")
    if args.profile in ("operating", "https-operating") and (settings["kc_test"] != 0 or
                                       settings["sleep_disabled"] != 0 or
                                       settings["timer_wake_s"] != 86400):
        raise SystemExit("Operating sleep configuration mismatch")
    if args.profile in ("https-pilot", "tls-cert-test") and (settings["kc_test"] != 0 or
            settings["sleep_disabled"] != 1 or settings["timer_wake_enabled"] != 0 or
            settings["loop_wdt_enabled"] != 1):
        raise SystemExit("HTTPS bench profile must stay awake with the watchdog enabled")
    if args.profile == "battery" and (settings["kc_test"] != 0 or
            settings["sleep_disabled"] != 1 or settings["loop_wdt_enabled"] != 1 or
            settings["buzzer_enabled"] != 1):
        raise SystemExit("Battery measurement configuration mismatch")
    if args.profile == "https-sleep-test" and (settings["sleep_bench"] != 1 or
            settings["sleep_disabled"] != 0 or settings["timer_wake_enabled"] != 1 or
            settings["timer_wake_s"] != 60 or settings["sleep_bench_max_cycles"] != 3 or
            settings["loop_wdt_enabled"] != 1 or settings["tls_hostname_verify"] != 1 or
            settings["request_auth"] != "hardware_hmac_sim_v2" or
            settings["stationary_ms"] != "30000UL" or settings["no_gps_grace_ms"] != "20000UL"):
        raise SystemExit("HTTPS sleep bench configuration mismatch")
    if args.profile != "https-sleep-test" and settings["sleep_bench"] != 0:
        raise SystemExit("Sleep bench leaked into another profile")
    flash = json.loads((build / "flasher_args.json").read_text())
    # Include every flash segment, including ota_data_initial.bin. Hashing only
    # bootloader/partitions/app would leave the transfer package incomplete.
    files = sorted(set(flash["flash_files"].values()) |
                   {"caltest.elf", "flasher_args.json", "flash_args", "sdkconfig"})
    manifest.write_text(json.dumps({
        "git_commit": commit, "dirty": dirty, "source_sha256": before,
        "source_archive_manifest_sha256": sha(args.source_manifest) if args.source_manifest else None,
        "dependency_lock_sha256": lock_before, "idf_version": version,
        "firmware": settings, "test_ca_header_sha256": ca_hash,
        "files_sha256": {f: sha(build / f) for f in files},
        "hardware": "ESP32-C3 new PCB: PWRKEY GPIO10 active HIGH, DTR GPIO7 LOW",
        "flashed": False,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"PROFILE VERIFIED: {manifest}")


if __name__ == "__main__":
    main()
