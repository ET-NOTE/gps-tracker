# idf_caltest — 운영 firmware

**ESP32-C3 mini** GPS 트래커의 **현재 운영본** firmware.

- **프레임워크**: ESP-IDF v5.5.4 + `arduino-esp32` v3.3.10 as component (dependencies.lock 고정)
- **주변장치**: LC86G GPS · SIM7080G LTE · LIS3DH 3축 가속도 · 마그네틱 부저
- **서버**: `POST http://gps.serial.kr/ingest` (nginx → 백엔드 `/gps-tracker/ingest`)

## 신PCB / 구PCB 배선 (**중요**)

이 firmware 는 **신PCB (2026-07-30~)** 배선을 기준으로 구성됨:

| 신호 | 신PCB (2026-07-30~) | 구PCB (~2026-07-29) |
|---|---|---|
| PWRKEY GPIO | **10** | 7 |
| DTR GPIO | **7** | 10 |
| PWRKEY 극성 | idle=LOW / pulse=HIGH (NPN base) | idle=HIGH / pulse=LOW (직결) |

> **구PCB 유닛에 이 firmware 를 flash 하면 PWRKEY/DTR 이 물리적으로 misconnect** 됩니다.
> 구PCB 유닛 진단은 `arduino/13_4_aa_motion_aware_tracker/` 등 legacy 스케치 사용.

## 운영 / KC 빌드 (프로파일 필수)

ESP-IDF **5.5.4** 환경을 활성화한 뒤 저장소 루트에서 실행합니다.
Windows 설치 폴더 이름만으로 SDK 버전을 판단하지 말고 `idf.py --version`으로 확인합니다.

```sh
python idf_caltest/tools/build_firmware.py operating
python idf_caltest/tools/build_firmware.py kc
```

`config.h`를 수정해 KC 플래그를 켜고 끄지 않습니다. 프로파일 없는 CMake 빌드는 실패합니다.
각 프로파일은 sdkconfig까지 별도로 사용하며, 기존 `build/caltest.bin`과 시험소 제출본은 덮어쓰지 않습니다.

| 산출물 | 운영 | KC 시험 후보 |
|---|---|---|
| 디렉터리 | `idf_caltest/build/operating/` | `idf_caltest/build/kc/` |
| 바이너리 | `caltest.bin` | `caltest.bin` |
| 빌드 증빙 | `manifest.json` | `manifest.json` |
| 절전 / 부저 / loop WDT | ON / ON / ON | OFF / OFF / OFF |
| 버전 접두사 | `operating-<git revision>` | `kc-<git revision>` |

manifest에는 실제 바이너리에 컴파일된 설정, 소스/의존성/산출물 SHA-256과 Git 커밋을 기록합니다.
미커밋 펌웨어 변경은 버전에 `-dirty`가 붙습니다. 빌드 실패 또는 의존성 변경 시 성공 manifest를 남기지 않습니다.
KC의 B5 락, Cat-M only, COPS=0, 서버 통신 및 복구 제한은 유지합니다.

Linux 빌드 러너에서는 `espressif/idf:v5.5.4` 컨테이너에서 동일 명령을 사용합니다.
VPS에서 컴파일하지 않습니다. 두 프로파일은 같은 managed_components를 사용하므로 순서대로 빌드합니다.

## Flash (빌드 명령은 자동 업로드하지 않음)

보드가 신PCB 배선인지, 대상 장치와 COM 포트가 맞는지 확인합니다.
해당 프로파일의 manifest와 바이너리 SHA-256을 확인한 다음, **그 빌드를 만든 IDF 환경**에서:

```sh
cd idf_caltest
idf.py -B build/operating -p COMxx flash monitor
# KC 대상은 build/kc. 시험센터 입고 장치는 임의 갱신하지 않습니다.
```

다른 PC로 옮길 때는 manifest에 적힌 bootloader, partition table, app 파일과
`flasher_args.json`의 오프셋을 함께 사용합니다. 오래된 공용 build 경로를 사용하지 않습니다.

## USB / 시리얼

현재 CMake는 USB Serial/JTAG CDC를 활성화합니다. setup에서
`Serial.setTxTimeoutMs(0)`을 사용하므로 USB 리더가 없어도 추적을 시작합니다.
과거 Arduino 스케치의 CDCOnBoot 지침을 이 IDF 빌드에 그대로 적용하지 않습니다.

## 빌드 식별과 절전 진단

- 부팅 로그: `FW-CONFIG:{...}`에 프로파일, 버전, 절전, 타이머, 핀/펄스 설정을 출력합니다.
- 모든 POST: `build_tag`와 `stationary.fw_version/build_profile/sleep_enabled`를 보냅니다.
- `stationary`에 정지 창(300초), GPS 없을 때 유예(600초), 타이머(600초), 절전 취소 횟수와
  정상 종료 미확인 누적 횟수도 보냅니다. KC의 유효 절전/타이머 활성값은 false입니다.
- 기존 서버는 `stationary` 객체 전체를 `devices.last_stationary`에 보존하고,
  wake/sleep 이벤트의 `build_tag`를 저장합니다. API/DB 변경 없이 수신됩니다.
  기존 `devices.fw_version` 필드와는 별개이므로 그 필드만 조회하면 구분할 수 없습니다.

절전 순서: 부저 잔진동/정지 확인 → 잔여 GPS 전송 → 절전 예정 이벤트 → wake 설정 검증 →
`AT+CPOWD=1` 및 `NORMAL POWER DOWN` 확인(최대 12초) → 공유 레일 OFF →
마지막 움직임/센서/INT 검사 → 전원 GPIO hold → deep sleep.
정상 종료 응답이 없으면 미확인으로 기록하고 레일을 차단합니다. PWRKEY를 무조건 토글하지 않습니다.

통신/종료 대기 중 움직임은 취소 시점까지 기억합니다. 종료 후 취소는 LTE를 재기동하고,
레일이 꺼졌다면 GPS도 재설정합니다. 종료 미확인 시에는 기존 12초 방전 후 재기동합니다.
절전 예정 이벤트까지 전송한 뒤 취소했다면 다음 성공 POST에 `event=wake, wake=sleep_abort`를 보고합니다.
최종 INT 검사 뒤 발생한 움직임은 latch를 지우지 않아 GPIO wake로 처리됩니다.

## 검증

```sh
python3 idf_caltest/tests/run_tests.py  # Linux g++, 실제 sleep_mgr/telemetry/lte 소스 + 가짜 HW 경계
```

정상/타임아웃/전송 실패, 각 종료 단계의 움직임, 센서 오류, wake/hold 실패, 취소 후 복구,
KC의 직접/타이머 절전 차단, 분할 UART 응답 및 payload JSON/4096바이트 제한을 검사합니다.
실제 장치에서는 추가로 정지 후 소비전류, 모션 wake, 10분 타이머 wake, 이동 재개 후 GPS/LTE 복구를 확인해야 합니다.
UART 종료 응답만으로 물리적인 전류/레일 전압까지 확인한 것은 아닙니다.

## 소스 구조

- [`main/config.h`](main/config.h) — **모든 핀·타이밍·플래그 단일 소스**. 다른 모듈은 이 상수만 참조.
- `main/main.cpp` — setup/loop 오케스트레이션 (이관 이력 헤더 주석)
- `main/hw_power.cpp` — PWR_EN / PWRKEY / DTR 게이팅
- `main/lte.cpp` — SIM7080 AT 시퀀스 (bringUp / SHREQ POST / recovery)
- `main/gps.cpp` — LC86G NMEA 파싱 + fix freshness + drift 판정
- `main/motion.cpp` — LIS3DH INT1 wake + activity EMA
- `main/sleep_mgr.cpp` — 정지 판정 + deep sleep 진입 (motion-aware)
- `main/recovery.cpp` — stuck watchdog + soft/hardCycle/esp_restart escalation
- `main/breadcrumb.cpp` — 마지막 실행 단계 RTC 기록
- `main/telemetry.cpp` — payload 조립 (JSON, fixes_jsonb 포함)
- `main/buzzer.cpp` — 마일스톤 부저 (POST OK · wake · low_batt)
- `main/loopwdt.h` — 60s loop-task 워치독 (라이브러리 hang 대응)

## 상세 배경

- [`../docs/hardware.md`](../docs/hardware.md) — HW rev 진화 & 부품 특성
- [`../docs/troubleshooting.md`](../docs/troubleshooting.md) — 실전 사고 log & fix
- [`../docs/blog/04-firmware.md`](../docs/blog/04-firmware.md) — Arduino → IDF 이관 서사
- [`../STATUS.md`](../STATUS.md) — 프로젝트 전체 상태
