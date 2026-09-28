# 03_10 — UNO + SIM7080G 쉴드 검사 + GPS/OLED/배터리 (HW팀 확장판)

03_8 의 한글 5단계 검사에 HW 팀이 확장(2026-09-23 feedback 흡수):
- **OLED**(SSD1306 128x64 I2C, A4/A5; SH1106 은 `OLED_SH1106 1`) — 단계/재부팅수/PV전압/배터리%/망/GPS/HTTP 8행 로테이션
- **GPS**: 모뎀 내장 GNSS(CGNSINF) 5초 폴링. 품질 기준을 통과한 좌표를 10초 이상 간격으로 최대 8개 모아 전송
- **배터리**: A0=PV 분압(100k/100k) 실측 표시. 1S Li-ion OCV 근사 % (연료게이지 아님)
- 서버 주소 `http://gps.serial.kr/ingest/shield`, `device_uid=uno-shield-test`, ICCID 미전송. 여러 쉴드에서 동시에 같은 UID를 사용하지 않을 것

## 2026-09-28 통신 복구 / 일반·진단 빌드 분리

**v11은 전용 서버 경로 배포가 먼저 필요하다. prod 반영은 명시적 승인 후 서버 → 펌웨어 순서로 수행한다.** `SHIELD_DEV_TARGET=1`은 dev-gps.serial.kr만 사용한다.

기본 일반 빌드 식별자: `shield-batch-20260928-v11`. `SHIELD_DIAGNOSTICS=1`인 진단 빌드는 `shield-batch-20260928-v11-dbg`이다. 대상은 UNO R3(`arduino:avr:uno`)이며 **03_8 및 KC 펌웨어는 수정하지 않는다.**

일반 빌드는 수동 RF/DTR 조작, 상세 좌표 로그, 모뎀 정보 조회, 자동 DNS 진단, SRAM 계측을 컴파일에서 제외한다. 자동 통신 복구·위치 유효성 검사·OLED·PV 측정·서버 진단 코드는 두 빌드에서 동일하다. 일반 로그에는 전송 결과와 GNSS 상태 코드·위성 수·PV 요약을 남긴다. 변경 검증은 [OPTIMIZATION_VALIDATION_20260928.md](OPTIMIZATION_VALIDATION_20260928.md) 참고.

실기 결과: [GNSS_VALIDATION_20260928.md](GNSS_VALIDATION_20260928.md). 실내 비교 시험 이후 하늘이 보이는 실외로 옮기자 동일한 v9에서 유효 위치를 확보했고, 2026-09-28 11:15:51 KST부터 좌표·위성 수가 서버에 저장됐다. 초기 좌표 수렴 중 큰 변화가 관찰되어 측위 성공과 위치 정확도는 구분해서 평가한다.

- HTTP 작업 전에 `CGNSPWR=0` 성공을 확인한다. 전송 성공 후 GNSS를 복구한다. 전송 실패 중에는 GNSS를 끈 상태로 통신부터 복구하여 짧은 재시도 때문에 측위를 반복 중단하지 않는다. 도중 `RDY`가 수신되면 전송을 중단하고 초기 검사로 복귀한다.
- 초기 LTE 등록/재등록 중에는 GNSS를 켜지 않는다. 서버 전송 대기 단계에서만 GNSS를 폴링한다.
- SSL 설정은 `AT+SHSSL=0`으로 초기화한다. 기존 `AT+SHSSL=0,""`는 실기에서 거부됐으며, 0번 인덱스는 인증서 인자를 받지 않는다(AT manual 13.2.2).
- 부팅 직후 상태를 한 번 전송한다. 유효한 위치가 있으면 이전 전송 완료부터 최소 60초 간격으로 전송한다. 최초 측위와 장시간 미수신은 최대 600초를 기다린다. 위치를 전송한 직후 구간에서는 일시적인 위치 상실에 최대 120초를 기다린 뒤 상태를 전송한다. 그 보고에 위치가 없거나 전송에 실패하면 다음 구간은 다시 600초로 돌아가 장시간 미수신 중 짧은 중단이 반복되지 않게 한다. 측위 중에는 서버 수신 페이지가 일시적으로 오래된 수신으로 표시될 수 있다. GNSS 켜기 실패 시에는 60초 상태 보고를 유지한다. 이 시간은 전송 완료 기준 대기이며 실제 수신 간격에는 HTTP 작업 시간이 더해진다.
- 연속 HTTP 실패 시 15/30/60/120초 대기 후 자동 재시도한다. 실패 시 PDP를 정리하고 다음 시도에서 재연결한다.
- 등록 상태 확인·재등록은 GNSS가 꺼진 통신 단계에서 실행한다. 측위 도중 일시적인 LTE 조회 실패가 GNSS를 끄지 않도록 했다. GNSS가 꺼진 재시도 대기 중에는 15초마다 확인하며 마지막 조회의 성공값을 계속 재사용하지 않는다.
- SIM7080G는 LTE/GNSS 수신 회로 일부를 공유하여 동시 동작을 지원하지 않는다([SIMCom Hardware Design V1.05, GNSS Application Guide](https://curtocircuito.com.br/datasheet/modulo/SIM7080G_Hardware_Design.pdf)). 120/600초는 이 시험 펌웨어의 정책 상한이며 수신 성공을 보장하는 시간이 아니다.
- `[AT ERROR]`, `[AT FAIL]`, `[AT TIMEOUT]`에 실제 오류와 실패 명령을 표시한다. HTTP 종료를 확인한 상태이면 다음 전송 직전의 중복 `SHDISC`를 생략한다. 부팅·연결 응답 시간 초과·재부팅으로 상태가 불명확하면 `SHSTATE?`로 확인하고, 열려 있으면 종료한다. 종료 확인 실패 시 GNSS를 켜지 않고 통신 복구를 재시도한다.
- **진단 빌드에서만** HTTP 연결 실패 시 GNSS 전원·망 등록·데이터 접속·IP·DNS 진단을 출력하며, 연속 실패의 첫 시도에 한정한다. 이 진단에는 통신 주소가 포함될 수 있으므로 원본은 개인 로컬 로그로 보관한다.
- 고정 시험값 `ts=1`, `vbat_mv=3300`을 제거했다. `ts`는 UNO 가동 초, `diag.pv_mv`는 A0의 PV 실측값이다. PV를 배터리 VBAT로 보내지 않는다.
- GNSS 실행·fix 플래그, 좌표 범위, UTC 형식/날짜, HDOP 0.1~5.0, 가시 위성 4개 이상, 새 UTC를 확인한 지 15초 미만일 때만 위치를 사용한다. 최신 fix 판정과 별개로 이미 검증된 배치 좌표는 원래 GNSS UTC와 함께 보존한다. 10분 이상 보관한 표본은 버리고, 남은 표본이 없으면 `points: []` 상태 보고를 보낸다.
- CGNSINF의 16번째 필드(0부터 세면 15)는 reserved이므로 위성 사용 수로 해석하지 않는다. [SIMCom AT manual V1.07, 8.2.2](https://download.mikroe.com/documents/datasheets/SIM70x0_AT_Command.pdf)
- 너무 긴 필드를 잘라 유효 좌표로 취급하지 않는다. 위성 수는 0~99 정수만 받으며 `260`이 8비트 정수 변환 후 4로 바뀌어 통과하는 등의 오류를 방지한다.
- 마지막 유효 UTC는 빈 응답 이후에도 기억한다. 빈 응답과 오래된 좌표가 번갈아 도착해도 위치 신선도가 갱신되지 않는다.
- 진단 빌드의 5초 간격 시리얼 로그 `reason`, `raw_fix`, `window_s`로 모뎀의 측위 미완료와 품질 필터 거절을 구분한다. 일반 빌드는 전송 시 숫자 상태 코드를 요약한다. `raw_fix=-1`, `SV=-1`은 값이 비어 있거나 잘못된 응답이며 실제 음수 위성 수가 아니다. HDOP=0.1만으로 측위 성공이라고 판단하지 않는다.
- 진단 빌드에서만 시작 시 `CGMR`, `CGNSMOD?`를 읽어 모뎀 버전/위성 모드를 기록한다. 재부팅을 일으키는 위성 모드 쓰기나 콜드 스타트를 자동 반복하지 않는다.

### `diag.gnss` 진단 코드

| 코드 | 의미 |
| --- | --- |
| 0 | 응답 미확인 / 조회 실패 |
| 1 | GNSS 꺼짐 |
| 2 | 모뎀이 fix=0 보고 |
| 3 | 모뎀 fix 상태 값 없음 / 잘못된 값 |
| 4 | 잘리거나 잘못된 필드 |
| 5 | 좌표 형식 / 범위 오류 |
| 6 | UTC 형식 / 날짜 오류 |
| 7 | HDOP 기준 미달 |
| 8 | 위성 수 기준 미달 / 값 없음 |
| 9 | 오래된 위치 |
| 10 | 유효한 위치 |

코드는 기존 수신 본문의 `diag`에 추가하며 서버 변경은 필요하지 않다. 공개 수신 페이지에는 아직 이 세부 코드가 표시되지 않는다.

v11은 별도 `shield_v: 1` 형식이다. `points` 원소는 `[GNSS UTC 초, 위도×10⁶ 정수, 경도×10⁶ 정수, 가시 위성 수]`이며 새 GNSS 측정 시각을 10초 이상 간격으로 보관한다. 정상 POST 대기 60초는 유지하고 중간 좌표만 복원한다. 전체 JSON을 RAM에 쌓지 않고 192-byte 임시 조각으로 두 번 순회(길이 계산/전송)한다. 서버는 `lte_gnss`의 `fixes_jsonb`로 정규화하고 공통 좌표·속도 조회를 사용한다. 기존 `l80`/`fixes`/KC 파서는 변경하지 않는다.

실패 또는 응답 유실 때는 큐를 유지하고, HTTP 200이면 비운다. GNSS UTC로 재전송 중복을 제거한다. 8개를 넘으면 가장 오래된 표본부터 교체하며, 전원 재시작 시 RAM 큐는 유실된다. 통신 실패 중 GNSS를 끄는 기존 하드웨어 제약도 유지하므로 장기 오프라인 이동 궤적 전체를 보존하는 기능은 아니다. 계정 귀속은 서버가 보존하며 원격 제어 명령은 적용하지 않는다.

USB 모니터 115200 baud. **다음 수동 키는 진단 빌드에서만 동작한다.** `p`=즉시 서버 전송(망 등록 후), `s`=SIM/망 재확인, `g`=GNSS 설정/응답 상세 조회, `r`=검사 재시작, `d`=통신 상태 진단, `n`=무선 기능 재등록 1회(`CFUN=0/1`, 전원/PWRKEY 조작 아님). `n`은 진단자가 명시적으로 입력할 때만 실행하며 복구 응답 실패 시 자동 재시도한다. USB 포트 개방만으로 UNO가 리셋될 수 있다.

`i`는 전송 대기 단계에서만 실행하는 **수동 비교 시험**이다. GNSS를 끈 뒤 `CFUN=0`으로 LTE RF를 중지하고 GNSS만 최대 180초 가동한다. 유효한 위치를 얻으면 일찍 종료한다. 결과는 시리얼에 남기며 종료 후 GNSS off → `CFUN=1` → 초기 망 검사로 자동 복귀한다. LTE 복구 명령이 실패/시간 초과하거나 모뎀이 재부팅해도 복구 대기 상태를 유지하여 재시도한다. 이 시험의 180초 동안 일반 키 입력과 HTTP 전송은 대기하며 위치는 시험 로그로 확인한다. 정상 동작에서 `CFUN=0/1`을 반복 실행하지 않는다. 상세 조회 로그에는 좌표가 포함될 수 있으므로 개인 로그로 보관한다.

빌드 예시(현재 prod용 업로드는 서버 배포 승인 후 실행):

```powershell
$cli = 'C:\Program Files\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe'
$output = Join-Path $env:LOCALAPPDATA 'GPS-Builds\uno-shield-20260928-v11'
& $cli compile --fqbn arduino:avr:uno --warnings all --output-dir $output arduino/03_10_uno_shield_gps_oled
if ($LASTEXITCODE -eq 0) {
  & $cli upload --fqbn arduino:avr:uno --port COM26 --verify --input-dir $output arduino/03_10_uno_shield_gps_oled
}
```

진단 빌드는 별도 출력 경로에 생성한다. 일반 빌드와 업로드 대상을 혼동하지 않는다.

```powershell
$diagnosticOutput = Join-Path $env:LOCALAPPDATA 'GPS-Builds\uno-shield-20260928-v11-dbg'
& $cli compile --fqbn arduino:avr:uno --warnings all --build-property 'compiler.cpp.extra_flags=-DSHIELD_DIAGNOSTICS=1' --output-dir $diagnosticOutput arduino/03_10_uno_shield_gps_oled
```

포트는 실제 연결 장치에 맞춰 확인한다. 회귀 시험은 `ops/tests/uno_shield` 참고.

## ★ 신쉴드 PWRKEY 회로 교훈 (HW 확인)
D7 → T2(NPN) → PWRKEY. **D7 HIGH 유지 = PWRKEY 계속 누름 = 약 12.6초마다 강제 리셋**
(SIMCom 설계서 24–25쪽). 반드시 idle LOW, AT 무응답일 때만 1.5s HIGH 펄스.
"오토부트라 펄스 불필요 + D7 상시 HIGH" 시도는 이 리셋 루프를 만들었음 (2026-09-23 실증).
RDY 수신은 원인 단정 불가 — 경고 문구도 중립으로 변경됨.

필요 라이브러리: U8g2. 로컬 검증 조합은 AVR core 1.8.6, U8g2 2.36.12이다.
