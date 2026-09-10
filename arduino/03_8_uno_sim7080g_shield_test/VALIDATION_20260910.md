# UNO 쉴드 실기 검증 — 2026-09-10

COM8 (FTDI USB serial)에 `arduino:avr:uno` 스케치를 업로드했습니다. CLI 종료 코드 0 및 실제 스케치 부팅 배너로 실행을 확인했습니다. 모니터는 115200 baud입니다.

## 확인 결과

| 항목 | 관측 결과 |
|---|---|
| 부팅/baud | 최초 무응답 후 D7 LOW → HIGH 1500ms → LOW 펄스 1회. 이후 57600에서 AT OK 확인, 9600 전환 성공 |
| 재연결 | 모니터 재연결 후 UNO 부팅 배너가 다시 출력됨. 9600에서 바로 AT OK, 추가 PWRKEY 펄스 없음 |
| AT 유지성 | 첫 구간 정상 통계 16회 이상 성공. 두 번째 약 120초 수집 구간에서 마지막 uptime=115초, ping_ok=23, error=0, timeout=0, fail_streak=0 |
| 응답 시간/버퍼 | 출력된 최대 RTT 17ms, rx_overflow=0, long_lines=0 |
| ATI | R1951.04 |
| SIM | 최초 및 주기 재조회에서 `+CPIN: READY` |
| ICCID | 조회 성공, 끝 6자리 743458 (전체 값은 원시 로그) |
| IMSI | 조회 성공, 끝 6자리 774345 (전체 값은 원시 로그) |
| 전화번호 | CNUM은 OK만 반환, 저장된 번호 없음/미제공 |
| 신호/망 | CSQ=99,99. CEREG=0,2 후 0,0. COPS=0. 망 등록 성공은 확인되지 않음 |

## 검증 한계 및 후속 조건

- 최초 180초 수집은 PC 콘솔의 cp949 인코딩 오류로 약 115초 시점에 중단되었습니다. UTF-8 출력으로 수정하여 추가 120초 수집을 완료했습니다. 두 구간을 단일 연속 무중단 시험으로 취급하지 않습니다.
- USB 로그 일부에 문자 누락/깨짐이 있으며 재연결 직후 `MS Ready` 반복 출력도 수집되었습니다. 원인은 미확인입니다. AT 성공 통계와 SIM 조회는 확인했지만 전체 시스템의 장기 안정성을 통과 판정하지 않습니다.
- 사용자 확인 전원: UNO 3.3V 핀에서 모듈에 분배. UNO R3의 공식 3.3V 출력 한도는 50mA이고 SIM7080G의 피크 전류는 500mA 사양이므로, 충분한 별도 전원과 공통 GND를 구성한 뒤 망 등록/송신 및 장기 시험이 필요합니다. 현재 미등록/문자 깨짐의 원인을 전원으로 확정하지 않습니다.
- D7은 HIGH 펄스 설정으로 통신이 가능했습니다. LOW 활성 설정을 별도로 업로드하여 비교하지는 않았으므로 회로 극성을 확정하는 시험은 아닙니다. 이미 켜진 상태에서 추가 전원 토글을 하지 않았습니다.
- 데이터 접속/서버 송신은 수행하지 않았습니다. 수집 종료 후 COM8은 닫았고, UNO 스케치는 계속 실행됩니다.

원시 로그: [monitor_20260910.log](monitor_20260910.log)

## 추가 D6 HIGH/LOW 시험

- `1`=D6 HIGH, `0`=D6 LOW 명령을 추가하여 재컴파일/업로드 완료. Flash 7,180 bytes (22%), RAM 553 bytes (27%). 첫 업로드 동기화 실패 후 재시도 성공.
- 초기 LOW에서 AT 성공 3회 및 SIM READY 확인.
- `[DTR] D6=HIGH` 확인 후 `+CSCLK: 0`, AT 성공 누계 10회(전환 후 7회), SIM READY 및 ICCID/IMSI 재조회 성공. HIGH 전환 시 uptime 약 18초, 마지막 수집 uptime 45초. 마지막 통계 줄에는 일부 문자 누락이 있으며 그 전 정상 줄의 error/timeout/overflow는 0.
- HIGH에서도 CSQ=99,99 / CEREG=0,0으로 망 미등록 상태 유지. CSCLK=0 조건이라 DTR 슬립 제어 극성을 판별하는 시험은 아님.
- LOW 복원 명령 전송 시 COM8 Write timeout/Access denied 발생. 수집 프로세스를 종료한 뒤에도 포트 재열기가 Access denied로 실패. **LOW 복원은 확인되지 않았으며 HIGH 상태일 수 있음.** UNO reset 시 setup에서 D6 LOW로 초기화됨.
- USB 재연결 후 LOW 전환 확인 및 비교 시험을 마쳐야 함. 완전한 HIGH/LOW 왕복 검증으로 판정하지 않음.
- 로그: [monitor_d6_20260910.log](monitor_d6_20260910.log).

전원 기준: [UNO R3 핀맵](https://content.arduino.cc/assets/Pinout-UNOrev3_latest.pdf), [SIMCom 호환 설계 문서 Table 4](https://static.maritex.eu/file/display/LCKickxJ4yhVWkDct52E5Yo19YYK9cxD).

## USB 재연결 후 2×2 시험 완료

`m` 명령 추가 빌드: flash 8,316 bytes (25%), RAM 557 bytes (27%). COM8 업로드 종료 코드 0 및 새 메뉴/실제 MATRIX 실행으로 확인. 업로드 출력에 protocol error 한 줄이 있었으나 실행은 확인됨.

조건: MODEM UART 9600, USB 115200, CSCLK=0, 기존 UNO 3.3V 분배 전원 그대로. 각 정적 레벨 조합을 약 30초 유지하며 순서대로 AT 점검. 중간 강제 복구 없이 LL → HL → HH → LH 순서로 시험했으므로 전환 전 상태의 영향이 포함됨. 단독 냉간 부팅 극성 시험은 아님.

| D6 DTR | D7 PWRKEY | AT 성공 | AT timeout | ERROR | RDY 부팅 URC | 종료 SIM 조회 | 판단 |
|---|---|---:|---:|---:|---:|---|---|
| LOW | LOW | 7 | 0 | 0 | 0 | READY | 정상 유지 |
| HIGH | LOW | 7 | 0 | 0 | 0 | READY | CSCLK=0 조건에서 정상 유지 |
| HIGH | HIGH | 5 | 2 | 0 | 2 | 미확인 | 반복 부팅/응답 중단 |
| LOW | HIGH | 4 | 3 | 0 | 3 | 미확인 | 반복 부팅/응답 중단 |

HIGH/HIGH 및 LOW/HIGH의 `sim_ready=0`은 마지막 AT 실패로 종료 SIM 조회를 생략했기 때문이며 SIM 불량 판정이 아님. 중간에 CPIN READY URC는 관측됨. HIGH/LOW 결과 줄 일부 문자가 USB 로그에서 누락됐지만 성공 수와 SIM READY가 확인되며, 해당 구간 개별 AT 응답은 OK이고 TIMEOUT 출력 없음.

**결론: D6 LOW + D7 LOW를 기본 유지 상태로 사용. D7 HIGH는 유지하면 안 되며 펄스 제어에 사용.** D6 HIGH도 CSCLK=0에서는 동작하지만 슬립 모드에서의 DTR 극성까지 검증한 결과는 아님. D7 HIGH 구간의 RDY 반복은 이 배선에서 활성 상태가 유지된 영향과 부합하나 전압 실측/전원 분리 비교는 하지 않았음.

마지막 `[MATRIX] RESTORED D6=0 D7=0` 및 `[MATRIX] DONE restored_at=1` 확인. 복원 후 SIM READY 및 지속 AT OK 확인. 이전 D6 시험의 LOW 복원 미확인 상태는 이번 시험으로 해소됨. CSQ 99,99 및 망 미등록은 계속되어 정상 조합 판정 범위는 AT/SIM 응답 유지에 한정.

원시 로그: [monitor_matrix_20260910.log](monitor_matrix_20260910.log).

## 창가 이동 후 USB 재연결 — 3분 모니터링

2026-09-10 13:16:19 로컬 시각에 COM8 모니터 시작. 첫 수신부터 monotonic 기준 **180.2초** 수집 완료, 프로세스 정상 종료 및 포트 닫힘. 별도 제어 명령/업로드 없이 기존 스케치의 주기 조회를 관측. 포트 열기 직후 UNO 부팅 배너 1회 확인.

- 마지막 uptime=180초 통계: AT 성공 **35**, timeout **1**, ERROR **0**, fail_streak **0**, max_rtt **18ms**, rx_overflow **0**, long_lines **0**.
- 약 120초 점검에서 timeout 1회 발생, uptime=125초에서 AT 응답 복구.
- SIM 주기 조회 3회에서 READY, ICCID/IMSI 조회 성공.
- CSQ 조회 3회 모두 **99,99**. 읽을 수 있는 CEREG 응답 2회 모두 **0,2**(탐색 중). 중간 CEREG 응답은 로그가 깨져 해석 제외. COPS는 **0**만 반환. 등록 성공(1/5) 미확인.
- 수집 중 **RDY 부팅 URC 3회**(약 45~50초, 115~123초, 175~180초 구간) 및 CPIN/SMS Ready 재출력 관측. 첫 RDY 이후 echo가 다시 나타남. 모듈 재부팅 정황이므로 무중단 안정성은 통과 판정하지 않음. 발생 원인은 미확정.
- 일부 USB 로그 문자 누락/깨짐도 지속. 창가 이동으로 신호/망 등록이 개선됐다는 근거는 얻지 못함. 기존 UNO 3.3V 분배 전원 조건의 용량 문제는 앞서 기록한 대로 별도 전원으로 분리 검증 필요.

원시 로그: [monitor_window_20260910_131619.log](monitor_window_20260910_131619.log).

## D6 HIGH — 3분 비교 모니터링

2026-09-10 13:23:45 로컬 시각 COM8 연결. 기존 스케치 `1` 명령으로 D6 HIGH 전환, **`[DTR] D6=HIGH` 수신 이후 monotonic 기준 180초** 측정. D7 LOW 유지, 전환 직후 `+CSCLK: 0` 확인. 새 펌웨어 업로드/전원 토글 명령은 수행하지 않음.

- HIGH 이전 AT 성공 누계 2, HIGH 종료 직전 누계 38: **HIGH 구간 AT 성공 36회, timeout 1회, ERROR 0회**. 전환 직후 수동 점검 1회를 포함하므로 이전 LOW 시험의 35회와 샘플 수가 다름.
- timeout은 uptime 약 55초 점검에서 발생, 60초에서 응답 복구. 마지막 max_rtt=18ms, rx_overflow=0, long_lines=0.
- HIGH 구간 RDY 부팅 URC **3회**: uptime 50~58초, 110~115초, 165~170초 구간. CPIN READY 재출력 및 echo 재등장 동반. 실제 전압/리셋 신호 측정은 하지 않았으므로 재부팅 정황으로 기록.
- SIM 조회는 READY 유지. HIGH 구간 조회 CSQ는 모두 **99,99**, CEREG는 모두 **0,2**, COPS는 **0**. 망 등록 성공 미확인.
- 일부 USB 로그 문자 깨짐/누락 지속. D6 HIGH로 바꿔도 이전 LOW 시험의 부팅 메시지 3회/timeout 1회/신호 미확인 현상이 개선되지 않음. 원인을 D6 또는 전원으로 확정하지 않음.
- 180초 종료 후 `0`을 전송. 원시 로그 **`[DR] D6=LOW`**(접두어 T 누락) 및 그 직후 CSCLK 조회/AT/SIM 조회로 LOW 전환 명령 실행을 확인. 자동 모니터의 엄격한 `[DTR]` 문자열 검사만 실패해 `restored_low=False`를 출력했으나, 원문 D6=LOW 및 명령 처리 순서를 검토하여 복원 확인. 복원 후 SIM READY/AT OK 유지, 포트 정상 종료.

원시 로그: [monitor_d6high_20260910_132345.log](monitor_d6high_20260910_132345.log).

## HW팀 한글 디버그 빌드 v3

`hw-handoff-20260910-v3-ko` 컴파일 및 COM8 업로드 완료. Flash 13,718 bytes, RAM 603 bytes. D6/D7 LOW 및 v2 부팅 제어 순서 유지.

실기에서 빌드 표식, AT 생사 정상 한글 설명, SIM READY, CCID/CIMI 조회 성공, CNUM 미제공, CSQ 99 신호 미확인, CEREG 상태 2 망 탐색 중 설명을 확인했습니다. 망 등록 거절/등록 성공 분기는 이번 장치 상태에서는 실측하지 않았습니다. 일부 원시 로그 및 한글 글자 누락/깨짐은 여전히 관측되어 해결됐다고 판정하지 않습니다. UART/PC 표시 이상과 무선 접속 실패를 분리해 점검해야 합니다.

원시 로그: [monitor_handoff_v3_ko_20260910.log](monitor_handoff_v3_ko_20260910.log).

## 15:49 재확인 — SIM 번호/등록 거절/모듈 부팅

2026-09-10 15:49:35 로컬 시각 COM8 연결. 첫 수신부터 180초 모니터 실행 완료, 프로세스 정상 종료. D6/D7 LOW. 마지막 수신은 UNO uptime 약 115초의 SIM 조회 중 `AT+CSQ` 송신까지이며, 이후 종료까지 추가 수신 없음. 따라서 180초 연속 정상 응답으로 판단하지 않음.

- 현재 ICCID **89882280666147743482**, IMSI **901405114774348**을 각각 4회 동일하게 읽음. 이전 시험 SIM 식별값과 다르므로 결과를 현재 SIM 기준으로 구분.
- CPIN READY 및 식별번호 조회 OK와 함께 CEREG=0,2(탐색 중), 이후 **CSQ=29,99 / CEREG=0,3(등록 거절)**를 관측. 망에 등록되지 않아도 카드/가입자 번호를 읽을 수 있음을 실기 확인. 등록 거절의 구체 원인은 미확인이며 SIM 개통/로밍 허용/망 설정 등 별도 조사 필요.
- UNO uptime **95.381초, 100.390초, 110.663초**에 모듈 RDY 부팅 메시지 및 CPIN READY 재출력. UNO uptime/통계는 이어지고 D6/D7 LOW 유지, 초기 부팅 배너 이후 UNO 재시작 배너 없음. 모듈 측 재부팅 정황을 직접 확인. 브라운아웃 원인은 전압 실측 없이 확정할 수 없음.
- 마지막 정상 통계 uptime=115초, ping_ok=20, timeout=3, error=0, boot_urcs=3. 이후 식별번호 재조회는 성공했지만 CSQ 송신 뒤 수신 중단.
- 일부 로그 문자 누락/깨짐 지속. 마지막 수신 중단이 UART/USB/장치 중 어느 계층에서 발생했는지는 미확인.

원시 로그: [monitor_confirm_20260910_154935.log](monitor_confirm_20260910_154935.log).
