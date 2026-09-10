# 03_8 — UNO + SIM7080G 쉴드 테스트

## HW팀 전달 빌드

`hw-handoff-20260910-v3-ko`: 한글 의미 설명을 포함한 HW 진단 빌드. D6 **LOW** 기본값, D7 **LOW** idle. 무응답 부팅 조건에서만 D7 HIGH 1500ms 펄스 1회. 자동 2×2 시험은 실행하지 않습니다. 2026-09-10 COM8에 업로드했습니다.

시리얼 모니터 **115200 baud**로 연결하면 자동으로 5초 AT 점검과 60초 SIM/망 조회가 실행됩니다. `[BUILD]`로 버전, `[STATE]`로 D6/D7 및 부팅 URC 누계, `[BOOT-URC]`로 RDY 수신 시각(ms)과 누계를 확인합니다. 부팅 URC 누계는 전기적으로 측정한 리셋 횟수가 아닙니다. `s`는 즉시 SIM/망 재조회, `h`는 통계 출력입니다.

AT/SIM 조회 동작은 확인했으나 망 등록 실패, RDY 반복, 일부 USB 로그 문자 깨짐은 미해결입니다. 상세 시험 결과와 UNO 3.3V 공급 조건은 아래 검증 기록을 함께 전달하세요. 이 빌드는 원인 분석용이며 안정성 검증 완료 펌웨어가 아닙니다.

컴파일: flash 13,718 bytes (42%), RAM 603 bytes (29%). 한글 문자열은 `F()`로 플래시에 저장합니다. 모니터는 115200 baud, UTF-8 표시를 사용합니다.

### 한글 로그 읽는 방법

| 표시 | 의미 |
|---|---|
| `[모듈 생사] AT 응답 OK` | 모듈과 UART 명령 통신 정상. 인터넷 연결 성공은 아님 |
| `[SIM 삽입/인식] 정상` | SIM READY 확인. SIM을 읽을 수 있고 PIN 잠금이 해제됨. 개통/로밍 보장은 아님 |
| `[SIM 정보] 조회 성공` | CCID 카드 번호, CIMI 가입자 번호를 수신함. CNUM은 비어 있을 수 있음 |
| `[신호] CSQ 99` | 신호 세기 미확인. SIM 불량으로 단정 불가 |
| `[망 등록] 탐색 중` | CEREG 상태 2. 아직 등록되지 않았으며 최종 실패 판정도 아님 |
| `[망 등록] 등록 거절` | CEREG 상태 3. 개통/로밍 허용/사업자 정책 및 망 설정 점검 |
| `[망 등록] 성공` | CEREG 상태 1 또는 5. 홈망/로밍 등록. 데이터 및 서버 송신은 별도 시험 필요 |
| `[부팅] RDY 수신` | 부팅 알림. 반복되면 전원/제어 신호와 재부팅 정황 점검 |

각 조회의 TX/RX 원문은 그대로 출력합니다. 명령 echo와 OK만으로 식별번호 조회나 망 등록 성공을 판정하지 않습니다. 상세 조회 상태가 없거나 응답이 실패하면 미확인으로 표시합니다.

실기 업로드/모니터링 결과: [2026-09-10 검증 기록](VALIDATION_20260910.md). COM8 업로드 및 AT/SIM 조회 성공, 망 등록 미확인. 전원 용량 및 일부 USB 로그 깨짐은 후속 확인 필요.

대상: **Arduino UNO R3 / ATmega328P**, `arduino:avr:uno`. UNO R4용이 아닙니다.
UNO AVR 코어에 포함된 `SoftwareSerial`만 사용합니다.

## 배선과 회로 조건

| UNO | 쉴드 신호 | 방향/기본 동작 |
|---|---|---|
| D6 | DTR | LOW 유지, 모듈 wake |
| D9 | SIM RX | UNO TX → SIM RX |
| D8 | SIM TX | SIM TX → UNO RX |
| D7 | PWRKEY 제어 입력 | 기본 HIGH 1.5초 펄스, idle LOW |
| GND | GND | 공통 접지 |

UNO의 5V GPIO와 SIM7080G 원시 핀을 직접 연결하지 말고 쉴드의 전압 변환 회로를 사용합니다. 모뎀 전원은 쉴드 규격에 맞는 별도 공급원을 사용합니다.

PWRKEY 기본값은 `idf_caltest/main/config.h`의 NPN 드라이버 방식과 같습니다. **새 쉴드 입력이 LOW 활성 방식이면 스케치의 `PWRKEY_ACTIVE_HIGH`를 `false`로 변경**합니다. 모듈 원시 PWRKEY의 극성과 쉴드 제어 입력의 극성은 다를 수 있습니다. D6은 DTR을 반전하지 않는 회로를 가정합니다. 별도 PWR_EN 핀은 사용하지 않습니다.

## 실행 내용

1. DTR/PWRKEY idle 설정 후 UART 9600을 시작합니다. 300ms 안정 대기 후 3초 동안 800ms 간격 AT로 생명신호를 확인합니다. AT OK이면 이미 켜짐으로 판단해 PWRKEY를 생략합니다.
2. AT가 안 붙으면 UNO용 baud 탐색(9600 → 115200 → 19200 → 38400 → 57600)을 추가로 수행합니다. 다른 속도에서 응답하면 `AT+IPR=9600` 전환 후 새 AT로 검증합니다. 탐색까지 수신 바이트가 전혀 없을 때만 idle 100ms → HIGH 1500ms → idle 펄스 1회. 생명신호가 있으면 펄스 없이 기다립니다. 이후 최대 12초 동안 800ms 간격 AT를 확인하며, 실패하면 baud를 다시 탐색합니다. 두 번째 펄스나 자동 전원 사이클은 없습니다.
3. 운영본과 같은 초기화 순서로 `ATE0` → `AT+IFC=0,0` → `AT+IPR=9600` → `AT+CMEE=2` → `AT+CSCLK=0`을 요청한 뒤 ATI 및 SIM 상태를 조회합니다. 운영본의 IPR=115200 대신 UNO에서는 9600을 사용합니다.
4. 평상시 5초 간격 AT 점검: 정확한 `OK`만 성공으로 집계합니다. echo나 URC는 성공이 아닙니다. ERROR, timeout, 연속 실패, 마지막 성공 경과 시간, 최대 응답 시간, 수신 오버플로우와 긴 줄 폐기 횟수를 출력합니다.
5. 최초 정상 응답 후 및 이후 60초마다 SIM/망 정보를 조회합니다. SIM 조회와 설정 명령은 순차 실행하므로 해당 구간에는 5초 AT 점검이 지연될 수 있습니다. 통계의 OK/error/timeout은 AT 점검만 집계하며 개별 조회 실패는 바로 앞 명령의 로그로 확인합니다.

전원 제어 기준은 `idf_caltest/main/hw_power.cpp`, `config.h`, `lte.cpp`입니다. UNO에는 PWR_EN이 없어 300ms는 연결된 외부 전원의 안정 대기일 뿐, 실제 레일 ON/OFF나 복구 사이클이 아닙니다. baud 탐색과 USB 로그 준비 시간이 추가되어 전체 부팅 시간은 운영본과 다릅니다. 12초는 AT 부팅 대기 구간의 상한이며 전체 시퀀스 상한이 아닙니다.

| 명령 | 확인 내용 |
|---|---|
| `AT+CPIN?` | `READY`: PIN 해제/인식됨. SIM PIN/PUK나 CME 오류는 원문 확인 |
| `AT+CCID` | ICCID, SIM 카드 식별 번호 |
| `AT+CIMI` | IMSI, 가입자 식별 번호 |
| `AT+CNUM` | SIM에 저장된 전화번호. IoT SIM은 빈 응답일 수 있음 |
| `AT+CSQ` | 신호 값. RSSI 99는 미확인 |
| `AT+CEREG?` | `<n>,<stat>` 중 stat 1=홈망 등록, 5=로밍 등록, 2=탐색, 3=거절 |
| `AT+COPS?` | 현재 사업자/접속 정보 |

`CPIN READY`만으로 개통/데이터 통신 성공을 판단할 수 없습니다. APN, 밴드, RAT, PIN 입력, 데이터 접속 및 서버 전송은 수행하지 않습니다. 식별 번호는 로컬 시리얼에 출력됩니다.

USB 시리얼 모니터는 **115200 baud**입니다. 입력은 `s`=SIM 재조회, `h`=통계, `b`=baud 재탐색입니다. 줄바꿈은 무시합니다. 무응답 중 모뎀을 다시 켰거나 baud가 바뀌었으면 `b`로 재탐색합니다.

D6 비교 시험: `1`은 D6 HIGH, `0`은 D6 LOW로 전환합니다. 전환 직후 `[DTR]` 확인 로그, `AT+CSCLK?`, AT 점검, SIM/망 조회를 출력합니다. 시험 후 `0`으로 LOW를 복원합니다. 기본 `CSCLK=0`에서의 비교이며 슬립 진입/복귀 시험은 아닙니다.

`m`은 D6/D7 정적 레벨 2×2 시험입니다. LOW/LOW → HIGH/LOW → HIGH/HIGH → LOW/HIGH 순서로 각 30초 유지 후 두 핀을 LOW로 복원하고 AT를 확인합니다. D7 HIGH 유지 시 실제 시험에서 반복 부팅이 발생했으므로 진단할 때만 실행합니다. 시험은 UNO 내부에서 진행되어 PC 연결 유지에 의존하지 않습니다. **실측 정상 유지 조합은 D6 LOW + D7 LOW**이며, CSCLK=0에서 D6 HIGH + D7 LOW도 AT/SIM 응답은 정상입니다. 상세 수치는 검증 기록에 있습니다.

115200 탐색은 UNO 소프트웨어 UART의 초기 연결 단계입니다. 이 단계에서 계속 실패하면 전압 변환된 USB UART로 모듈에 `AT+IPR=9600`을 먼저 설정하고 UNO를 재시작합니다. 이 스케치는 모듈 baud를 변경하므로 이후 다른 호스트에서도 9600 또는 재탐색을 사용해야 합니다. 저장/전원 재인가 동작은 모듈 펌웨어 설정에 따라 확인합니다.

## 컴파일 / 업로드

```powershell
$cli = 'C:\Program Files\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe'
& $cli compile --fqbn arduino:avr:uno --warnings all --output-dir "$env:TEMP\uno_sim7080g_shield_build" arduino/03_8_uno_sim7080g_shield_test
& $cli board list
# COMx를 실제 UNO 포트로 바꿉니다.
& $cli upload --fqbn arduino:avr:uno -p COMx --input-dir "$env:TEMP\uno_sim7080g_shield_build" arduino/03_8_uno_sim7080g_shield_test
& $cli monitor -p COMx --config baudrate=115200
```

2026-09-10 컴파일 성공: flash 7,084 / 32,256 bytes (21%), RAM 553 / 2,048 bytes (27%). 산출물은 `%TEMP%\uno_sim7080g_shield_build`에 생성합니다. 실제 장치의 장시간 응답/SIM 상태는 업로드 후 확인해야 합니다.

AT 명령 기준: [SIMCom SIM7070/SIM7080/SIM7090 AT Command Manual V1.07](https://download.mikroe.com/documents/datasheets/SIM70x0_AT_Command.pdf), UART 구현: [Arduino SoftwareSerial](https://docs.arduino.cc/learn/built-in-libraries/software-serial/).

## [2026-09-10] HW팀 전달용 한글 개편
- 출력 전면 개편: AT 원문([TX]/[RX])·영문 태그 제거, **한글 단계별 안내만** 출력
  (`[1/5]모뎀통신 → [2/5]초기설정 → [3/5]유심 → [4/5]망등록 → [5/5]서버전송`)
- 각 실패 지점에 점검 힌트(전원/배선/유심/안테나) 출력, 모뎀 재부팅(RDY) 감지 시
  "[경고] … 전원 용량 부족 의심" (3초 스로틀 + 누적 횟수)
- 망 등록 성공 시 **gps.serial.kr 서버 전송까지 자동 진행**, HTTP 200 판정 출력.
  `device_uid=uno-shield-test` 로만 전송(ICCID 미포함 → 운영 데이터와 격리)
- 키: `r`=재검사, `s`=유심/망 재확인, `p`=서버 재시험, `1/0`=DTR HIGH/LOW
- DTR(D6) 기본값 HIGH — LOW 는 모뎀 전원붕괴 순간 UNO 까지 멈추는 현상 실측(5회 재현)
- 실측 결론(현 배선): 모뎀이 신호를 잡고 등록 송신을 시작하는 순간(약 10초 주기)
  브라운아웃 재부팅 반복 → **모뎀 별도 전원(3.3~4.2V/500mA↑, GND 공통) 필수**

## [2026-09-10 확정] 전원 조건 — 검사 시 DC 어댑터 필수
- **UNO 배럴잭에 7~12V DC 어댑터를 꽂고 검사할 것.** PC USB 단독 급전(500mA)으로는
  모뎀 송신 피크에서 5V 레일이 무너져 4단계에서 약 10초 주기 "[경고] 모뎀이 재부팅됨" 반복.
- 어댑터(12V/1A) 인가 후 실측: **연속 5회 부팅 시험 전부 통과** — 매회 망 등록 7.7초,
  서버 HTTP 200 판정까지 26초, 재부팅 경고 0회. 서버측 uno-shield-test last_seen 갱신 확인.
- USB 케이블은 시리얼 모니터용으로 같이 꽂아 두면 됨 (어댑터가 있으면 UNO 가 어댑터 전원 우선).
