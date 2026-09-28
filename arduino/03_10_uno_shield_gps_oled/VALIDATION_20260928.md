# 2026-09-28 UNO 쉴드 통신 복구 검증

이 문서는 v7 통신 복구 당시의 기록이다. 후속 v9 연속 측위 및 RF 비교 시험은 [GNSS_VALIDATION_20260928.md](GNSS_VALIDATION_20260928.md)를 참고한다.

대상: COM26(CH340), Arduino UNO R3 / ATmega328P, 모니터 115200 baud.

## 최종 결과

`shield-http-20260928-v7` 업로드 및 플래시 read-back 검증 성공. 10:04:20, 10:05:24, 10:06:28, 10:07:32, 10:08:35 KST에 자동 HTTP 200을 연속 관찰했다. 주기는 전송 완료 후 60초 대기이므로 실제 도착 간격은 약 64초다. 관찰 구간에 전송 실패는 없었다.

운영 DB의 `uno-shield-test` last_seen_at 및 `source=lte_gnss` 상태 레코드 갱신을 확인했다. 수신 본문에는 빌드 식별자, UNO 가동 초, CSQ/등록 상태, `diag.pv_mv`가 들어간다. 측정하지 않은 `vbat_mv`는 null이다. GPS는 아직 유효한 fix가 없어 false로 전송되며, 실물의 유효 좌표 전송은 검증되지 않았다.

## 수정 및 실기 확인

- GNSS와 HTTP를 순차 실행하고 LTE 등록 중 GNSS 시작을 보류했다.
- SIMCom manual 13.2.2에 따라 SSL 초기화를 `AT+SHSSL=0`으로 수정했다. 기존 추가 빈 인자는 실기에서 거부됐다.
- 망 등록 거절/attach 해제 상태에서 수동 `n` 명령(CFUN 0/1)을 한 번 실행한 뒤 로밍 등록과 HTTP 전송이 복구됐다. 이 RF 재등록을 자동 반복하지 않는다. 전원/PWRKEY 조작은 하지 않았다.
- 반복 전송 시험 중 프롬프트가 `peek()`와 `available()` 사이에 도착하면 놓치는 경합을 발견했다. 실제 읽은 바이트를 검사하도록 수정하고 지연 프롬프트 회귀 시험을 추가했다.
- GNSS 품질 불량/빈 위성/동일 UTC 반복은 위치로 내보내지 않는다. 예약 필드를 위성 사용 수로 해석하던 부분도 제거했다.
- 이미 끊긴 HTTP 연결의 `SHDISC` 오류는 정리 단계에서 허용한다. 최종 HTTP 200 및 서버 저장으로 성공을 판정한다.

## 빌드/시험

- Arduino CLI 1.2.0, AVR core 1.8.6, U8g2 2.36.12.
- Flash: 26,372 / 32,256 bytes (81%). 전역 RAM: 1,270 / 2,048 bytes (62%).
- HTTP 구간의 AVR SP 기준 남은 SRAM 표본: 483 bytes. 전체 실행의 최저 여유량을 보증하는 값은 아니다.
- etcom-hub에서 실제 .ino를 모뎀 stub과 함께 컴파일하고 `-Wall -Wextra -Werror`, AddressSanitizer, UndefinedBehaviorSanitizer 회귀 시험 통과.
- JSON 위치/상태 페이로드, 용량 경계, HTTP 오류/timeout/reboot, GNSS 복구, 지연 prompt, 주기 전송/재시도, 망 등록 복구, 타이머 wraparound 확인.
- HEX SHA-256: `a42e5782ff39f17132cfc826fc223fba20300fe8024e3831dd7dc7d54aeb3ca8`.
- Windows 산출물: `%LOCALAPPDATA%\GPS-Builds\uno-shield-20260928-v7`.
- 원본/좌표 마스킹 로그: `%LOCALAPPDATA%\GPS-Monitoring\shield-v7-20260928-100339` (Git 미포함).

03_8, idf_caltest/KC 펌웨어, 운영 서버 설정은 이 펌웨어 변경에서 수정하지 않았다. OLED 연결은 별도 문제이며 이전 검사에서 0x3C/0x3D 미발견이었다. 장시간 안정성, 야외 GNSS 측위, 오프라인 이동 궤적 보존은 이번 검증 범위 밖이다.
