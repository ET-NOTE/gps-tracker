# 03_10 — UNO + SIM7080G 쉴드 검사 + GPS/OLED/배터리 (HW팀 확장판)

03_8 의 한글 5단계 검사에 HW 팀이 확장(2026-09-23 feedback 흡수):
- **OLED**(SSD1306 128x64 I2C, A4/A5; SH1106 은 `OLED_SH1106 1`) — 단계/재부팅수/PV전압/배터리%/망/GPS/HTTP 8행 로테이션
- **GPS**: 모뎀 내장 GNSS(CGNSINF) 5초 폴링. 품질 기준을 통과한 좌표는 서버 `lte` 필드로 전송
- **배터리**: A0=PV 분압(100k/100k) 실측 표시. 1S Li-ion OCV 근사 % (연료게이지 아님)
- 서버 주소 `http://gps.serial.kr/ingest`, `device_uid=uno-shield-test`, ICCID 미전송. 여러 쉴드에서 동시에 같은 UID를 사용하지 않을 것

## 2026-09-28 통신 복구판

빌드 식별자: `shield-http-20260928-v7`. 대상은 UNO R3(`arduino:avr:uno`)이며 **03_8 및 KC 펌웨어는 수정하지 않는다.**

- HTTP 작업 전에 `CGNSPWR=0` 성공을 확인한다. 성공/실패 모두 HTTP 정리 후 GNSS를 복구한다. 도중 `RDY`가 수신되면 전송을 중단하고 초기 검사로 복귀한다.
- 초기 LTE 등록/재등록 중에는 GNSS를 켜지 않는다. 서버 전송 대기 단계에서만 GNSS를 폴링한다.
- SSL 설정은 `AT+SHSSL=0`으로 초기화한다. 기존 `AT+SHSSL=0,""`는 실기에서 거부됐으며, 0번 인덱스는 인증서 인자를 받지 않는다(AT manual 13.2.2).
- 전송 성공 후 60초 대기, 연속 실패 시 15/30/60/120초 대기 후 자동 재시도한다. 대기 시간은 이전 전송 완료부터 센다. 실패 시 PDP를 정리하고 다음 시도에서 재연결한다.
- 등록 상태를 15초마다 확인하며 해제/조회 실패 시 SIM·망 등록 단계로 돌아간다. 마지막 조회의 성공값을 계속 재사용하지 않는다.
- `[AT ERROR]`, `[AT FAIL]`, `[AT TIMEOUT]`에 실제 오류와 실패 명령을 표시한다. 이미 연결이 없는 상태의 `SHDISC` 오류 등은 정리 단계에서 허용한다. 최종 HTTP 결과와 함께 해석한다.
- HTTP 연결 실패 시 GNSS 전원·망 등록·데이터 접속·IP·DNS 진단을 출력한다. 이 진단에는 통신 주소가 포함될 수 있으므로 원본은 개인 로컬 로그로 보관한다.
- 고정 시험값 `ts=1`, `vbat_mv=3300`을 제거했다. `ts`는 UNO 가동 초, `diag.pv_mv`는 A0의 PV 실측값이다. PV를 배터리 VBAT로 보내지 않는다.
- GNSS 실행·fix 플래그, 좌표 범위, UTC 형식/날짜, HDOP 0.1~5.0, 가시 위성 4개 이상, 새 UTC를 확인한 지 15초 미만일 때만 위치를 사용한다. 연결 지연으로 전송 시점에 60초 이상 지난 좌표도 제외한다. 나머지는 `lte.fix=false` 상태 보고이며 좌표를 포함하지 않는다.
- CGNSINF의 16번째 필드(0부터 세면 15)는 reserved이므로 위성 사용 수로 해석하지 않는다. [SIMCom AT manual V1.07, 8.2.2](https://download.mikroe.com/documents/datasheets/SIM70x0_AT_Command.pdf)

현재 서버의 단일 `lte` 위치는 서버 수신 시각으로 기록한다. 이 스케치는 저장 배치/오프라인 큐를 구현하지 않으며 전송 실패 중의 이동 궤적을 보존하지 않는다. 앱에 보이려면 이 시험 UID의 소유 관계도 별도 설정되어 있어야 한다. 전송 응답의 원격 제어 명령은 적용하지 않는다.

USB 모니터 115200 baud. `p`=즉시 서버 전송(망 등록 후), `s`=SIM/망 재확인, `g`=GPS 조회(전송 대기 중), `r`=검사 재시작, `d`=통신 상태 진단, `n`=무선 기능 재등록 1회(`CFUN=0/1`, 전원/PWRKEY 조작 아님). `n`은 진단자가 명시적으로 입력할 때만 실행하며 자동 반복하지 않는다. USB 포트 개방만으로 UNO가 리셋될 수 있다.

빌드/검증 업로드:

```powershell
$cli = 'C:\Program Files\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe'
$output = Join-Path $env:LOCALAPPDATA 'GPS-Builds\uno-shield-20260928-v7'
& $cli compile --fqbn arduino:avr:uno --warnings all --output-dir $output arduino/03_10_uno_shield_gps_oled
if ($LASTEXITCODE -eq 0) {
  & $cli upload --fqbn arduino:avr:uno --port COM26 --verify --input-dir $output arduino/03_10_uno_shield_gps_oled
}
```

포트는 실제 연결 장치에 맞춰 확인한다. 회귀 시험은 `ops/tests/uno_shield` 참고.

## ★ 신쉴드 PWRKEY 회로 교훈 (HW 확인)
D7 → T2(NPN) → PWRKEY. **D7 HIGH 유지 = PWRKEY 계속 누름 = 약 12.6초마다 강제 리셋**
(SIMCom 설계서 24–25쪽). 반드시 idle LOW, AT 무응답일 때만 1.5s HIGH 펄스.
"오토부트라 펄스 불필요 + D7 상시 HIGH" 시도는 이 리셋 루프를 만들었음 (2026-09-23 실증).
RDY 수신은 원인 단정 불가 — 경고 문구도 중립으로 변경됨.

필요 라이브러리: U8g2. 로컬 검증 조합은 AVR core 1.8.6, U8g2 2.36.12이다.
