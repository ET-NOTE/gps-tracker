# Hardware — 진화한 흔적들

> "회로도 하나 → 실 device 하나" 로 끝나는 게 정상인데, 이 프로젝트는 **PCB rev 3번 + GPS 모듈 2종 + 부저 회로 재작업 + LTE 극성 반전** 을 거쳤다. 이 문서는 그 왔다갔다의 흔적.

## 최종 셋업 (2026-07~)

- **MCU**: ESP32-C3 mini (USB Serial JTAG 내장, RISC-V single core, 4 MB flash)
- **GPS**: Quectel LC86G (Quectel 신형, `$PAIR`/`$PQTM` NMEA URC)
- **LTE**: SIMCom SIM7080G (Cat-M1/NB-IoT, 국내 1NCE SIM 로 KT/SKT/LGU+ 로밍)
- **관성**: LIS3DH (I2C @0x18, WAKE-ON-MOTION → GPIO5 interrupt)
- **전원**: 18650 리튬 1S (TP4056 충전 회로), 3.3V LDO, 공유 PWR_EN 스위치
- **표시**: OLED SSD1306 128x64 (I2C @0x3C) — 부팅 시 SIM 번호 표시, 필드 진단
- **입력**: 마그네틱 부저 (능동, GPIO1 직결, 2700Hz 공진)

핀맵 (신 PCB rev, 2026-06-17 이후):

| 신호 | GPIO | 방향 | 비고 |
|---|---|---|---|
| PWR_EN | 6 | OUT | **LOW=ON** (GPS + LTE 공유 레일, 분리 제어 불가) |
| LTE PWRKEY | 7 | OUT | **idle LOW / pulse HIGH → LOW** (aa 신 rev), **idle HIGH / pulse LOW** (sss 구 rev) |
| LTE DTR | 10 | OUT | LOW = active (HIGH 는 sleep 진입 신호 — 실측 후 datasheet 값 그대로 확정) |
| LTE RX (ESP RX ← SIM TX) | 2 | IN | 신 rev. 구 rev 는 4 |
| LTE TX (ESP TX → SIM RX) | 4 | OUT | 신 rev. 구 rev 는 2 |
| GPS RX | 20 | IN | 9600 baud (aa 계열, LC86G 배송 default) |
| GPS TX | 21 | OUT | |
| LIS3DH INT | 5 | IN | WAKE-ON-MOTION deep sleep wake source |
| I2C SDA / SCL | 8 / 9 | IO | LIS3DH + OLED 공유 |
| Buzzer | 1 | OUT | 능동 부저 (마그네틱). `digitalWrite HIGH=on`. **LEDC PWM 회피** (deep sleep hold 이슈) |
| VBAT ADC | 3 | IN | 1:1 divider → `analogReadMilliVolts × 2.0` |

## PCB rev 진화

### rev 초기 (05_sim7080g_at 시절, ~2025-Q4)
- SIM7080G 첫 통합
- **RX/TX 배선이 unclear** — 초기 sketch 주석에 "원래 2였지만 스왑해봄" 이라고 개발자가 실험 흔적
- OLED 만 표시, 서버 통신 미완
- **한 device 만 존재. 회로도 문서화 X.** — 이후 sketch (13_2) 안 `#ifdef USE_OLD_PCB` 로 남아있음

### rev sss (2026-01~05, 구 PCB)
- L80 GPS + SIM7080G
- **RX=4, TX=2, PWRKEY idle=HIGH/pulse=LOW, DTR=LOW**
- 부저 있음 (driver 회로) → `BUZZER_ENABLED=1` 문제 없음
- device_id `sim-4774347*` 계열 SIM 여러 개 등록됨
- 필드 사고 다수 — [troubleshooting.md](troubleshooting.md) 참조

### rev aa (2026-07-01 커미셔닝, 신 PCB)
- 첫 aa hardware 수리 후 극성 확정 (memory 참조)
- **RX=2, TX=4 (스왑됨), PWRKEY idle=LOW/pulse=HIGH, DTR=LOW (동일)**
- GPS 모듈 교체: L80 → **LC86G** (Quectel 신형). 안테나 URC 형식 다름 (`$PQTMANTENNASTATUS` vs 이전 `$GPTXT ANTSTATUS`)
- LC86G 는 배송 default 9600 baud. persistence 롤백 리스크 회피 위해 **9600 유지 원칙**
- **마그네틱 부저 = LTE bringup 방해** — 첫 aa 실측에서 LTE 못 켜지는 사고. `BUZZER_ENABLED=0` 필수화 (이후 하드웨어 fix 로 다시 `=1`)
- Fork: `arduino/13_4_aa_motion_aware_tracker/` — sss 원본 (`13_4_motion_aware_tracker`) 오염 방지

### rev L86 (2026-07-01 저녁, aa 하위 rev)
- 새 aa 배치의 GPS 는 마킹이 **`L86 M33 Q1 A0437` (MediaTek MTK 기반)** — LC86G 가 아닌 L86 (구형 Quectel)
- 명령 계열 다름:
  - LC86G: `$PAIR864`, `$PAIR513`
  - L86: `$PMTK*` 계열
- 안테나 URC:
  - LC86G: `$PQTMANTENNASTATUS,OK_INT/OK_EXT/OPEN/SHORT`
  - L86: `$GPTXT,01,01,02,ANTSTATUS=OK/OPEN/SHORT*XX`
- **`13_4_aa` firmware 는 두 URC 형식 다 파싱** — 같은 device fleet 에 두 GPS chip 섞여있어도 대응. UI 는 `last_antenna` 필드로 통일 매핑.

## GPS 모듈 계열별 안테나 처리

| 항목 | LC86G (Quectel 신형) | L86 (Quectel 구형, MTK) |
|---|---|---|
| Marking | LC86G | L86 M33 Q1 A0437 |
| 명령 | `$PAIR864`, `$PAIR513` 등 | `$PMTK*` 계열 |
| 안테나 URC | `$PQTMANTENNASTATUS,<status>*XX` | `$GPTXT,01,01,02,ANTSTATUS=<status>*XX` |
| status 값 | OK_EXT / OK_INT / OPEN / SHORT | OK / OPEN / SHORT (내/외부 구분 없음) |
| 내부 안테나 fallback | 자동 (칩 자체 판정) | 없음 (외부 회로 감지만) |

FE `ANT_LABEL` 매핑 (`DeviceDetail.jsx`):
```js
const ANT_LABEL = { OK_EXT: '외부 안테나', OK_INT: '내부 안테나', OK: '정상', OPEN: '단선', SHORT: '단락' };
```
`OK` 케이스 (L86) 만 처음 매핑 누락돼 UI "미보고" 로 나오는 사고 있었음 → PR #119 로 fix.

## 부저 이슈 — 마그네틱 vs LTE bringup

**증상 (2026-06-30)**: 첫 aa device flash 후 LTE 부팅 안 됨 (`AT+CFUN?` 응답 없음).

**원인 추적**:
1. sss (구 PCB) 는 부저에 별도 driver 회로 있음 → BUZZER_ENABLED=1 OK
2. aa (신 PCB) 는 **마그네틱 부저 (GPIO1 → PWM 직결)** — LEDC 채널이 clock/전력 인터럽트 유발
3. Bootup 초기 부저 beep 이 SIM7080 UART/전원 초기화와 시간적으로 겹침 → 모듈 UART wedge

**해결**: 
- 임시: `BUZZER_ENABLED=0` (aa fork) — GPIO1 을 INPUT_PULLDOWN 으로 격리
- 장기: 하드웨어 재작업 (플라이백 다이오드 등) 후 다시 `BUZZER_ENABLED=1` 로 복구 (memory `project-buzzer-lte-diagnostic`, `project-aa-hardware-polarity` 참조)

## 배터리 측정 두 소스

Firmware payload 에는 두 개의 배터리 값이 함께 있음:

| 필드 | 측정 방식 | physical 어느 지점 | 성격 |
|---|---|---|---|
| **`vbat_mv`** | ESP32 GPIO3 ADC + 2배 divider 보정 | 배터리 - + 직전 (분압 저항 앞단) | **실측 근접** |
| **`cbc_mv`** | SIM7080 자체 `AT+CBC` 응답 | 모듈 VBAT 핀 (배선/LDO/저항 IR drop 뒤) | **모듈 관점** |

두 값의 차이 = 회로 IR drop 진단:
- idle: 20-40 mV 정상
- LTE TX peak: 100-300 mV drop = 배선/PCB trace 저항이 큼 (회로 개선 필요)
- 지금 ccc device 실측: `vbat 4240 / cbc 4210` = 30 mV drop = 정상

UI (`Dashboard.jsx`, `KakaoMap tooltip`) 에는 두 값 함께 표시: `4240 mV (모듈 4210)`. 서버 `location_records.vbat_mv` 컬럼 + raw JSONB `cbc_mv` 로 저장.

## 관련

- [architecture.md](../architecture.md) — 시스템 전체 흐름 (firmware ↔ api ↔ web ↔ mobile)
- [troubleshooting.md](troubleshooting.md) — 실전 사고 log
- [SETUP.md](SETUP.md) — 로컬 개발 셋업
- `arduino/13_4_aa_motion_aware_tracker/` — 최신 aa firmware (Arduino)
- `idf_caltest/` — 최신 IDF 프로젝트 (arduino-esp32 as component)
