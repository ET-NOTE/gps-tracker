# idf_caltest — 운영 firmware

**ESP32-C3 mini** GPS 트래커의 **현재 운영본** firmware.

- **프레임워크**: ESP-IDF v5.5 + `arduino-esp32` v3 as component
- **주변장치**: LC86G GPS · SIM7080G LTE · LIS3DH 3축 가속도 · 마그네틱 부저
- **서버**: `POST https://gps.serial.kr/ingest` (nginx → 백엔드 `/gps-tracker/ingest`)

## 신PCB / 구PCB 배선 (**중요**)

이 firmware 는 **신PCB (2026-07-30~)** 배선을 기준으로 구성됨:

| 신호 | 신PCB (2026-07-30~) | 구PCB (~2026-07-29) |
|---|---|---|
| PWRKEY GPIO | **10** | 7 |
| DTR GPIO | **7** | 10 |
| PWRKEY 극성 | idle=LOW / pulse=HIGH (NPN base) | idle=HIGH / pulse=LOW (직결) |

> **구PCB 유닛에 이 firmware 를 flash 하면 PWRKEY/DTR 이 물리적으로 misconnect** 됩니다.
> 구PCB 유닛 진단은 `arduino/13_4_aa_motion_aware_tracker/` 등 legacy 스케치 사용.

## Build

```bash
# ESP-IDF 환경 활성화 (5.5.x)
. $HOME/esp/esp-idf/export.sh   # 또는 %IDF_PATH%/export.bat (Windows)

cd idf_caltest
idf.py set-target esp32c3
idf.py build
```

빌드 이후 산출물: `build/caltest.bin`, `build/bootloader/bootloader.bin`, `build/partition_table/partition-table.bin`.

## Flash

```bash
# COM 포트는 환경에 맞게 (예: COM62 / /dev/ttyUSB0)
idf.py -p COM62 flash monitor
```

- 모니터 baud = 115200. 종료 `Ctrl+]`.
- flash 후 첫 부팅 로그: `[BOOT] ... [LTE] bringUp ... +CEREG: 0,5` 순서 확인.

## FQBN (Arduino IDE 참고)

이 프로젝트는 IDF 이지만 arduino-esp32 as component 라 CDC 옵션이 중요:

- **CDCOnBoot = default (disabled)** 필수. `cdc` 모드로 빌드하면 `Serial.print` 가 host 미연결 시 blocking → `lteBringUp` 도달 실패.
- 관련 사고: 2026-06-30 sss 1h+ stuck 사고 (`memory/project_cdc_default_required.md`).

`CMakeLists.txt` 에 `ARDUINO_USB_CDC_ON_BOOT=1 ARDUINO_USB_MODE=1` 설정 — arduino-esp32 CDC 초기화 매크로 (실제 CDC 활성 여부는 sdkconfig `CONFIG_ESP_CONSOLE_*` 로 결정).

## 소스 구조

- [`main/config.h`](main/config.h) — **모든 핀·타이밍·플래그 단일 소스**. 다른 모듈은 이 상수만 참조.
- `main/main.cpp` — setup/loop 오케스트레이션 (이관 이력 헤더 주석)
- `main/hw_power.cpp` — PWR_EN / PWRKEY / DTR 게이팅
- `main/lte.cpp` — SIM7080 AT 시퀀스 (bringUp / SHREQ POST / recovery)
- `main/gps.cpp` — LC86G NMEA 파싱 + fix freshness + drift 판정
- `main/motion.cpp` — LIS3DH INT1 wake + activity EMA
- `main/sleep_mgr.cpp` — 정지 판정 + deep sleep 진입 (motion-aware)
- `main/recovery.cpp` — stuck watchdog + soft/hardCycle/esp_restart escalation
- `main/breadcrumb.cpp` — batch fix ring buffer (POST 사이 손실 방지)
- `main/telemetry.cpp` — payload 조립 (JSON, fixes_jsonb 포함)
- `main/buzzer.cpp` — 마일스톤 부저 (POST OK · wake · low_batt)
- `main/loopwdt.h` — 60s loop-task 워치독 (라이브러리 hang 대응)

## 상세 배경

- [`../docs/hardware.md`](../docs/hardware.md) — HW rev 진화 & 부품 특성
- [`../docs/troubleshooting.md`](../docs/troubleshooting.md) — 실전 사고 log & fix
- [`../docs/blog/04-firmware.md`](../docs/blog/04-firmware.md) — Arduino → IDF 이관 서사
- [`../STATUS.md`](../STATUS.md) — 프로젝트 전체 상태
