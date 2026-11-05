# ESP32 TLS 서버 이름 검증 보완 및 실기기 재시험

2026-11-05 KST. 브랜치 `codex/location-business-prep`, 펌웨어 커밋 `6ce474583c02e3576e5bff945df968249d523607`, ESP-IDF 5.5.4.

## 판정과 적용 범위

단말-520211에서 **정상 인증서 성공, 만료·미신뢰 CA·다른 호스트 인증서 거부를 모두 확인**했다. [1차 시험](https-certificate-rejection-20261105.md)의 호스트명 검증 결함은 이번 ESP32 TLS 경로에서 해결됐다. 실제 운영 서버에 대한 HTTPS·요청/응답 HMAC·기존 SIM 장치의 DB 저장도 확인했다.

대상은 ESP32-C3 `68:ee:8f:21:33:64`, SIM7080G `1951B12SIM7080`, COM62, SIM 끝자리 47520211이다. 시험 종료 후 `idf-caltest/https-pilot-6ce474583c`를 설치했다. 사용자 요청대로 자동 절전 OFF·타이머 기상 OFF·워치독 ON이다. 다른 단말기 및 `operating`·`kc`·`battery` 프로필은 기존 수집 방식이다. 이번 결과를 전체 운영 전환 완료로 표시하지 않는다.

## 전송 구조

`ESP32(Mbed TLS) → SIM7080 원시 TCP → LTE/인터넷 → gps.serial.kr:443(Nginx TLS 종료) → 내부 수집 API → DB`

- ESP32가 전송 전에 TLS 레코드를 암호화하고 서버의 Nginx가 복호화한다. 모뎀의 TCP 소켓에는 TLS 레코드만 흐른다. `CASSLCFG SSL=0`은 모뎀 자체 TLS를 끄는 설정이며, 위치정보를 평문 HTTP로 보낸다는 의미가 아니다.
- Mbed TLS `VERIFY_REQUIRED`, ISRG Root X2, `ssl_set_hostname("gps.serial.kr")`, TLS 1.2 최솟값·최댓값을 적용했다. SNI와 실제 이름 검증을 함께 수행한다. 인증서 검증이 실패하면 HTTP 본문·장치 ID·서명 헤더를 보내지 않는다.
- `CONFIG_MBEDTLS_HAVE_TIME_DATE=y`를 프로필 빌드에서 강제하고, 미설정 시 컴파일 오류로 막는다. 모뎀 CCLK의 달력·시각·시간대(15분 단위)를 검사해 ESP32 UTC 시계에 반영한다. 초기 GPS epoch 또는 비정상 시각이면 NTP 복구를 시도하고 실패 시 전송하지 않는다.
- HMAC v2 요청/응답 검증, NVS 키·카운터, SIM별 소유권과 운행 이력을 유지한다. TLS는 전송 기밀성과 서버 인증, HMAC은 장치 인증·본문 무결성·재전송 제어를 담당한다. 응답 HMAC 확인 전에는 배치를 확정하거나 원격 명령을 적용하지 않는다.
- 실패 시 HTTP·인증서 검증 생략으로 전환하지 않는다. TLS 연결은 요청마다 새로 만들고 TCP를 닫는다. HTTP 응답은 헤더 최대 4KiB·본문 최대 2,047바이트로 제한한다. 잘린 응답, 중복 Content-Length, Content-Length/Transfer-Encoding 충돌은 실패 처리한다.
- 저장 데이터/백업 암호화는 별도 서버 작업이다. 서버 TLS 종료 이후의 내부 처리나 DB 저장을 종단간 암호화라고 표현하지 않는다.

## 실기기 인증서 시험

임시 `gps.serial.kr:18443` 리스너에 공개 시험 CA를 사용한 별도 `tls-cert-test` 펌웨어를 연결했다. 운영 GPS 수집과 NVS 인증 초기화를 실행하지 않는 entry point에서 고정 `GET /tls-probe`만 전송했다. 운영 인증키나 위치정보는 시험 리스너로 보내지 않았다.

| 사례 | 검증 완료 시각(KST) | 단말 결과 | 서버 HTTP 수신 |
|---|---|---|---:|
| 정상 gps.serial.kr | 12:08:20, 12:08:50, 12:09:43 | 검증 flags=0, HTTP 200 | 3회 |
| 다른 이름 wrong-host.invalid | 12:08:40, 12:09:34 | `-9984`, flags `0x04` 이름 불일치 | **0회** |
| 만료 gps.serial.kr | 12:08:44, 12:09:37 | `-9984`, flags `0x01` 만료 | **0회** |
| 미신뢰 CA gps.serial.kr | 12:08:46, 12:09:40 | `-9984`, flags `0x08` 신뢰 실패 | **0회** |

서버 이벤트에는 거부 사례별 2회의 TLS alert와 정상 3회의 `TLSv1.2 / ECDHE-ECDSA-AES256-GCM-SHA384`, `reused=false`를 확인했다. 모든 접속의 SNI는 gps.serial.kr이다. 정상 대조를 중간·마지막에 반복해 단순 통신 장애와 인증서 거부를 구분했다.

`wrong-host.invalid`는 serial.kr 계열이 아닌 시험용 이름이다. 다만 같은 serial.kr 계열이라도 실제 접속 이름 gps.serial.kr을 인증서의 SAN/허용 와일드카드가 포함해야 한다. 상위 도메인이 같다는 이유로 자동 신뢰하지 않는다.

정상·미신뢰·다른 이름 인증서 유효기간은 2026-11-04 02:59:51–2027-11-05 02:59:51 UTC이며, 만료 인증서는 2026-11-04 02:59:51 UTC에 만료됐다. 시험 루트 SHA-256: `fb7573fbe597d9db19edb40009b5a0c486010294844ded4609075c721eb67ab5`.

첫 두 정상 시도는 새 TCP 경로의 1NCE 출구 IP가 기존 시험 허용 IP와 달라 방화벽에서 차단됐다. 서버의 SYN 메타데이터로 18.180.11.40을 확인하고 해당 단일 IP로 임시 규칙을 변경했다. 이 준비 실패를 인증서 검증 실패나 성공 횟수에 포함하지 않는다. 운영 방화벽 정책은 변경하지 않았다.

## 운영 서버 복귀 확인

12:11:06 KST에 `https-pilot-6ce474583c`로 부팅했다. 초기 모뎀 시각 `80/01/06`을 감지해 첫 NTP 동기화로 2026-11-05 UTC 시각을 확보한 뒤, 펌웨어의 운영 Root X2로 gps.serial.kr 인증서를 검증했다.

- 관측된 POST 6회 모두 HTTP 200·요청/응답 HMAC 검증 성공. 서명 카운터 598017–598022.
- DB에는 12:11:26.623267–12:14:07.027968 KST의 6행이 기존 SIM 장치 3163·소유 계정 28에 저장됐다. 모두 `sleep_enabled=false`다.
- 요청 소요 시간은 6.7–29.3초다. 짧은 실내 상태 보고 시험이며, 주행 중 보고 주기·GPS UART 수집 영향과 장시간 지연을 검증한 결과는 아니다. 관측 중 idle heap은 첫 연결 후 271,588바이트로 유지됐지만 최대 사용량 측정은 아니다.
- 실내 GNSS fix가 없어 운영 DB에 합성 좌표를 넣지 않았다. 자동 모니터는 200초 관측 후 정상 종료하고 COM62를 해제했다.

## 회귀 검증과 보존

- 호스트 테스트 153개: 운영/KC/배터리/HTTPS 절전 및 복구, payload 계약, NTP 오류 경계, 모뎀 바이너리 분할 수신·NUL/ERROR/OK 포함 데이터·잘못된 길이·잘린 응답.
- 실제 Mbed TLS + loopback OpenSSL 테스트 13개: 같은 인증서 네 사례, 다른 이름 인증서가 그 실제 이름으로는 성공하는 대조, Content-Length/chunked 성공 및 잘린/충돌/과대 HTTP 응답 거부. `python idf_caltest/tests/run_verified_tls_tests.py`로 재현한다. 네트워크 외부 접근 없이 실행했다.
- 시험/수집 프로필의 칩 빌드 및 manifest 검증. `tls_engine=esp32_mbedtls`, `tls_hostname_verify=1`, 절전 OFF를 실제 바이너리에서 확인했다.
- app0만 플래시했다. 전체 시험 전후 NVS 0x9000–0xdfff를 읽어 **바이트 단위로 동일**함을 확인했다. SIM 재등록·키 재발급은 하지 않았다.
- 임시 TLS 서비스와 18443 리스너, 시험 IP의 UFW 규칙, 서버의 시험 개인키·스크립트를 회수했다. Nginx, gps-tracker-api 및 gps-tracker 서비스는 active다.

증빙은 접근 제한된 `C:/Users/msb/AppData/Local/GPS-Builds/location-business-20261105-hardware`에 보관한다. `cert-mcu-*.log`, `mcu-cert-server-events.jsonl`, `mcu-tls-host-tests.log`, `mcu-public-fixture-certs/`를 사용한다. 비밀이 있는 NVS/전체 플래시 사본은 배포하지 않는다.

| 패키지 | SHA-256 |
|---|---|
| gps-tls-cert-test-6ce4745.zip | 4fa898594b79e8e96dc0de15fc3f0d5efbc6c21f3bf8e65be5c6f80a3ffdd72d |
| gps-https-pilot-6ce4745.zip | 8145fed85f2519ee38c1b36d6c709ca866c932d891530d932df8424655e2af9c |

## 남은 운영 전환 검증

서버 이름 검증 결함의 보완과 거부 재시험은 완료했다. 다음은 별도 F1 인수 항목이다.

- 절전 활성 후보의 기상·재접속·원격 주기 유지와 소비전류, 장시간 주행 중 지연·메모리·실패율.
- 망 음영·SIM 교체·PDP 복구·CA 갱신 및 펌웨어 복구. 현재 정상 통신만으로 장애 주입 시험을 완료 처리하지 않는다.
- 응답 HMAC 변조·재전송 시 배치·명령의 실제 동작. 기존 서명 로직은 유지했지만 이번 시험은 정상 응답만 사용했다.
- CCLK/NTP는 인증된 시각원이 아니다. 시간 위조·시각 되돌림 방어 정책, 루트 갱신·폐기/인증서 폐기 검증 정책을 운영 전환 검토에 포함한다. 이번 만료 시험은 정상 UTC 시계를 기준으로 한다.
- 다른 모뎀 버전·양산 보드 시험, HTTPS 적용 범위 확대와 legacy HTTP 종료 계획.

원시 TCP 명령 형식은 [SIMCom AT Command Manual v1.07](https://dfimg.dfrobot.com/60c1e008bddfc41c3293de80/wiki/e8879bae8fcb219d1eeda40686910686.pdf) §12.2를 참고했다. 인증서 검증 판정의 근거는 문서상의 지원 표기가 아니라 위 실측 결과다.
