# 3. 하드웨어 진화

> "회로 하나 → device 하나" 로 끝날 줄 알았다. 실제로는 PCB rev 3번 · GPS 두 세대 · 부저 회로 재작업.

기술 spec 은 [docs/hardware.md](../hardware.md) 에 정리. 이 챕터는 **왜 바뀌었나** 위주.

## rev 0 (05_sim7080g_at 시절, 2025 말)

첫 device 는 breadboard 수준. ESP32-C3 mini + SIM7080G + L80 GPS + OLED. 배선은 그때그때.

이 시절 sketch (`arduino/05_sim7080g_at/`) 안 정의 :
```c
#define PIN_LTE_RX  4   // ESP RX (원래 2였지만 스왑해봄)
#define PIN_LTE_TX  2   // ESP TX (원래 4였지만 스왑해봄)
```

주석이 이미 heading — 개발자 (당시 나) 도 어느 쪽이 정답인지 몰라서 실험 중이었다. 어떻게 부팅했는지 로그가 나오는 조합을 찾아 정착. 회로도는 없었다.

**교훈**: 이 rev 는 나중에 진단이 될 때마다 발목을 잡음. 예를 들어 **9개월 후 이 옛 하드웨어를 재시도했더니 어떤 조합도 응답 안 함** (사고 #2 참조). 그때 다른 사용자 성공 코드에서 `PIN_LTE_TX = 3` (GPIO 3) 발견. 우리는 2/4 만 시도했으니 못 찾을 수밖에.

## rev sss (2026-01~05, 구 PCB)

Fritzing 으로 PCB 발주. 이때부터 device 여러 대 병렬 개발.

- **RX=4, TX=2, PWRKEY idle HIGH / pulse LOW, DTR LOW**
- 부저: 별도 driver 회로 (트랜지스터 + 저항) → `BUZZER_ENABLED=1` 문제없음
- L80 GPS (레거시)
- Firmware: `arduino/13_2_motion_aware_tracker/`

이 rev 로 몇 개월 필드 테스트. 자동차 트래킹, 실내 실외 모두. 여러 사고 발생 (INT-WDT, brownout 등). Firmware 진화 계속.

## rev aa (2026-07-01 커미셔닝, 신 PCB)

새 PCB rev. **주요 변화 5가지**:

1. **LTE RX/TX 스왑**: RX=2, TX=4 (SIM7080G 방향에 맞춰 정정)
2. **PWRKEY 극성 반전**: idle=LOW / pulse=HIGH → LOW. 하드웨어 회로 반전
3. **DTR 은 동일 (LOW)** — 처음엔 "반전" 정보 있었으나 실측 후 SIM7080 datasheet default 확인
4. **GPS 모듈 교체**: L80 → LC86G (Quectel 신형). NMEA URC 형식 변경 (`$PAIR864` 등)
5. **부저 회로 간소화 (재앙)**: driver 회로 제거 → **마그네틱 부저 GPIO1 직결** → LTE bringup 방해 (아래)

### 첫 aa 부팅 실패 — 부저가 원인이라니

첫 aa flash 후 LTE 부팅 안 됨. `AT+CFUN?` 응답 zero. sss 로직으로는 잘 되던 코드인데 왜?

**진단**:
1. sss 극성 (`PWRKEY_INVERT=1`) 은 아님 — aa 는 반전. `PWRKEY_INVERT=0` 확정
2. 그래도 안 됨. 배선 재확인. RX=2 / TX=4 맞음
3. Firmware log 자세히 봄. **부저 boot beep 이 나오는 순간 LTE UART 응답 무엇도 안 옴** 발견
4. `BUZZER_ENABLED=0` 로 flash → **즉시 LTE 정상 부팅**

**Root cause**: aa 신 PCB 는 마그네틱 부저를 GPIO1 → PWM 직결 방식으로 간소화. LEDC PWM 이 clock/전력 인터럽트 유발 → SIM7080 부팅 초기 UART/전원 초기화와 시간적으로 겹침 → 모듈 wedge.

**Fix (short-term)**: `arduino/13_4_aa_motion_aware_tracker/` fork 생성. sss 원본 오염 방지. `BUZZER_ENABLED=0` 로 GPIO1 을 `INPUT_PULLDOWN` 격리.

**Fix (long-term)**: 하드웨어 재작업 (플라이백 다이오드 등) 후 다시 `BUZZER_ENABLED=1` 로 복원. 지금 사용 중.

## rev L86 (2026-07-01 저녁 발견, aa 하위 rev)

같은 aa 배치 안에서도 GPS chip 이 두 종류. 마킹 실측:
- 첫 aa: **LC86G** (Quectel 신형)
- 이후 aa: **L86 M33 Q1 A0437** (MediaTek MTK 기반 Quectel 구형)

**증상**: 새 aa device flash 후 GPS 통신 안 됨. `$PAIR*` 명령 발사했는데 응답 zero. `$PMTK*` 로 보내야 응답.

**Fix**: `13_4_aa` firmware 안 두 명령 계열 모두 지원. 안테나 URC 도 두 형식:
- LC86G: `$PQTMANTENNASTATUS,OK_INT/OK_EXT/OPEN/SHORT*XX`
- L86: `$GPTXT,01,01,02,ANTSTATUS=OK/OPEN/SHORT*XX`

같은 `last_antenna` 페이로드 필드로 통일. Frontend 는 `ANT_LABEL` 딕셔너리로 매핑:
```js
const ANT_LABEL = {
  OK_EXT: '외부 안테나', OK_INT: '내부 안테나',
  OK: '정상',           // L86 케이스 — 처음 매핑 누락으로 "미보고" 로 뜨는 사고
  OPEN: '단선', SHORT: '단락'
};
```

**교훈**: 같은 부품 발주여도 chip 세대 섞일 수 있음. **부품 마킹 항상 실사**.

## 배터리 두 소스

Firmware payload 에는 **두 개의 배터리 값**이 함께 있다:

- **`vbat_mv`**: ESP32 GPIO3 ADC + 2배 divider 보정. 배터리 - + 직전 (분압 저항 앞단) → **실측 근접**
- **`cbc_mv`**: SIM7080 자체 `AT+CBC` 응답. 모듈 VBAT 핀 (배선/LDO/저항 IR drop 뒤) → **모듈 관점**

두 값 차이 = 회로 IR drop 진단:
- idle: 20-40 mV 정상
- LTE TX peak: 100-300 mV drop = 배선/PCB trace 저항이 큼

지금 ccc device (id=3009) 실측: `vbat 4240 / cbc 4210` = 30 mV drop = 정상 범위.

UI 에는 `4240 mV (모듈 4210)` 형태로 함께 표시. 사용자가 "왜 두 값이 다르지?" 물어봐서 tooltip 에 명시하게 됐다.

## Firmware 개발 흐름의 진화

각 사고마다 새 sketch 폴더가 생겼다:

```
arduino/
├── 03_1_lis3dsh_test         # 관성 첫 테스트
├── 03_2_i2c_scan_basic       # I2C 스캔
├── 03_3_l80_basic_test       # L80 GPS 첫
├── 03_4_sim7080_at_basic_test          # sss SIM7080 진단
├── 03_4_aa_sim7080_at_basic_test       # aa fork
├── 03_5_legacy_lte_swap_test           # 옛 하드웨어 스왑 순환 (사고 #2)
├── 03_6_lc86g_antenna_test             # LC86G 안테나
├── 03_6_aa_lc86g_antenna_test          # aa fork
├── 03_7_lc86g_set_baud                 # LC86G baud persistence
├── ...
├── 13_1~13_5_motion_aware_tracker      # sss 필드 iteration
├── 13_4_aa_motion_aware_tracker        # aa fork (부저 격리 등)
├── 14_a~14_m                           # 진단 sketches (부저·sleep·crash 조합 실험)
├── 15_a_modular                        # IDF from-source 리팩터 (Arduino IDE 로 도)
├── 15_field_v1, v2                     # 필드 검증본
├── hwdiag_lte_buzz                     # 부저↔LTE 상호작용
├── hwteam_oldmod_test{,2}              # HW팀 인계용 old 모듈
├── oldmod_pinsweep                     # 구 모듈 pin 자동 sweep
├── zz_antenna_diag, zz_buzzer_*_test   # 단일 이슈 재현본
├── idf_caltest/                        # 최종 IDF 프로젝트 (arduino-esp32 as component)
└── idf_lteonly/                        # LTE 단독 IDF test
```

**폴더 이름 자체가 사고 이력**. 새 문제 발견하면 새 sketch 파고, 원인 확정되면 main firmware 에 통합. 이 폴더들이 다 남아있는 이유는 다음 사고 때 참조하기 위해서. 매끈하게 정리해서 지웠으면 이번 rev 2 개 문제 진단할 때 훨씬 오래 걸렸을 것.

## 다음

- [4. 펌웨어 리팩터 (Arduino → IDF)](04-firmware.md) — draft
- [8. 실전 사고](08-troubleshooting.md)
