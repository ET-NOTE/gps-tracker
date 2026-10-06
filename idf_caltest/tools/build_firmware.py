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
    parser.add_argument("profile", choices=("operating", "kc"))
    args = parser.parse_args()
    idf = Path(os.environ["IDF_PATH"])
    # The dependency lock is part of the source contract. Don't silently resolve
    # it against the older SDK installed on some developer PCs.
    version = output(sys.executable, str(idf / "tools/idf.py"), "--version")
    if not re.search(r"\bv5\.5\.4\b", version):
        raise SystemExit(f"ESP-IDF v5.5.4 required by dependencies.lock; found {version}")
    commit = output("git", "rev-parse", "HEAD")
    dirty = bool(output("git", "status", "--porcelain", "--", "idf_caltest"))
    revision = commit[:10] + ("-dirty" if dirty else "")
    before = source_digest()
    lock_before = sha(PROJECT / "dependencies.lock")
    build = PROJECT / "build" / args.profile
    build.mkdir(parents=True, exist_ok=True)
    # Fresh output metadata prevents a failed build leaving a successful manifest.
    manifest = build / "manifest.json"
    manifest.unlink(missing_ok=True)
    sdkconfig = build / "sdkconfig"
    shutil.copyfile(PROJECT / "sdkconfig", sdkconfig)
    subprocess.run([sys.executable, str(idf / "tools/idf.py"), "-B", str(build),
                    "-D", f"SDKCONFIG={sdkconfig.as_posix()}",
                    "-D", f"FIRMWARE_PROFILE={args.profile}",
                    "-D", f"FIRMWARE_REVISION={revision}", "build"],
                   cwd=PROJECT, check=True)
    if sha(PROJECT / "dependencies.lock") != lock_before or source_digest() != before:
        raise SystemExit("Source/dependency lock changed during build; inspect and rebuild")
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
    if args.profile == "operating" and (settings["kc_test"] != 0 or
                                       settings["sleep_disabled"] != 0):
        raise SystemExit("Operating sleep configuration mismatch")
    flash = json.loads((build / "flasher_args.json").read_text())
    # Include every flash segment, including ota_data_initial.bin. Hashing only
    # bootloader/partitions/app would leave the transfer package incomplete.
    files = sorted(set(flash["flash_files"].values()) |
                   {"caltest.elf", "flasher_args.json", "flash_args", "sdkconfig"})
    manifest.write_text(json.dumps({
        "git_commit": commit, "dirty": dirty, "source_sha256": before,
        "dependency_lock_sha256": lock_before, "idf_version": version,
        "firmware": settings,
        "files_sha256": {f: sha(build / f) for f in files},
        "hardware": "ESP32-C3 new PCB: PWRKEY GPIO10 active HIGH, DTR GPIO7 LOW",
        "flashed": False,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"PROFILE VERIFIED: {manifest}")


if __name__ == "__main__":
    main()
