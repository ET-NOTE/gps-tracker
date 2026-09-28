# v12 · 실물 Shield 계정 및 HTTPS 전환

사용자는 Shield 테스트 계정 생성, 현재 실물 쉴드의 귀속 및 전환을 승인했다. 실제 충전·결제 호출은 금지한 기존 조건을 유지했다.

## 적용 범위

- UNO R3, COM26, SIM7080G `1951B12SIM7080`; 스케치 `03_10_uno_shield_gps_oled`만 변경.
- 새 Shield 계정/고유 UID/키를 발급하고 해당 장치를 등록했다. GPS 계정 비밀번호·JWT는 복사하지 않았다. SIM 식별자는 로컬 AT 조회 후 새 장치에 연결하고, 페이로드/공개 Git에는 넣지 않았다.
- 이전 GPS 장치/과거 데이터는 보존하며 새 실측 보고부터 Shield 전용 DB에 저장한다. KC/IDF 및 `03_8`은 변경하지 않았다.
- 일반 빌드 `shield-tls-20260928-v12`: flash 27,662 / 32,256 bytes, 정적 SRAM 1,486 / 2,048 bytes. HEX SHA256 `5d417855708928b14fdc4d8bfb92aedec34c5d968d23591573484521d97aa512`. 업로드 readback 검증 성공.
- 롤백용 v11 HEX SHA256 `803e07cbf549e3adbe459df1ace9d32eef5b62b456a4aafaffe1b5a9060dc9c9`을 개인 빌드 경로에 보존했다. 롤백 시 GPS의 legacy Shield ingest가 아직 열려 있는지 먼저 확인한다.

## 인증서 설치와 실제 모뎀 검증

1. 임시 `tools/tls_bridge`를 UNO에 올렸다. USB 115200, 모뎀 9600, D8/D9 SoftwareSerial. PC 전송은 바이트당 2ms 이상 간격을 둔다. PWRKEY D7은 LOW, DTR D6은 HIGH로 유지한다.
2. [공식 ISRG Root X1 PEM](https://letsencrypt.org/certs/isrgrootx1.pem)을 사용했다. 1,939 bytes, SHA256 `22b557a27055b33606b6559f37703928d3e4ad79f110b407d04986e1843543d1`. 기존 VPS의 신뢰 루트 사본과 일치했다. 인증서 갱신 시 [공식 체인 안내](https://letsencrypt.org/certificates/)와 교차 검증한다.
3. `CFSWFILE=3,"shield-ca.pem",0,1939,10000`, 파일 크기 확인, `CSSLCFG="CONVERT",2,"shield-ca.pem"` 순서로 고객 파일 영역에 설치했다. `provision_tls.py provision --ca <pem> --sha256 <digest> --output <private-directory>`가 수행한다.
4. 초기 모뎀 RTC가 1980년이었다. `CNTPCID=0`, `CNTP="time.cloudflare.com",0`, `CNTP`의 성공 코드 1 후 2026년 UTC로 교정됐다. 펌웨어도 부팅/모뎀 재시작마다 첫 전송 전 동기화한다.
5. `SSLVERSION=1,3`(TLS 1.2), `IGNORERTCTIME=1,0`(날짜 검사), `SNI=1,"shield.serial.kr"`, `SHSSL=1,"shield-ca.pem"` 설정으로 실제 HTTPS GET 200을 확인했다.
6. **거절 동작 시험**: 무관한 DigiCert 루트로 연결 거절, RTC를 2020년으로 두었을 때 아직 유효하지 않은 서버 인증서 거절. 두 경우 HTTP 상태는 연결 안 됨이었다. 이후 올바른 CA와 NTP 시각을 복구하고 연결 성공을 재확인했다. 독립적인 SAN/호스트명 불일치 시험은 수행하지 않았으므로 별도 검증 결과로 주장하지 않는다.
7. 임시 bridge를 실제 v12 애플리케이션으로 교체했다. 개인 키는 TLS 연결 성공 후 헤더에만 보내고 본문/일반 로그에 넣지 않는다.

근거: [SIMCom AT manual V1.07](https://download.mikroe.com/documents/datasheets/SIM70x0_AT_Command.pdf)의 TLS·CFS·NTP 명령, [SIMCom HTTP(S) Application Note V1.02](https://files.waveshare.com/wiki/SIM7070G%20Cat-MNB-IoT-GPRS-HAT/SIM7070_SIM7080_SIM7090_Series_HTTP%28S%29_Application_Note_V1.02.pdf)의 CA 설치/변환 및 SHSSL. 빈 인증서 이름이나 날짜 검사 우회는 사용하지 않았다.

## 회귀 및 실제 데이터

- 실제 스케치를 호스트용 스텁으로 컴파일한 일반/진단/legacy 세 가지 빌드에서 ASan/UBSan, `-Wall -Wextra -Werror` 통과.
- 기존 품질·배치·재시도·GNSS/LTE 충돌 시험에 NTP 실패, 잘못된 RTC, TLS 설정/연결 실패 시 키/본문 전송 차단, 비밀 헤더 오류/시간초과/echo 숨김, 재부팅 시 시각 캐시 무효화를 추가했다.
- 실제 서버에서 15:39:22 KST 첫 상태 수신, 15:40:51 KST부터 6개씩 GPS 좌표 배치 수신. 새 계정 로그인 후 위치·수신 건수가 화면 새로고침 없이 갱신됐다. PV 그래프/지도 표시 확인. DHT 센서는 연결되지 않았으므로 온습도는 미수신 표시가 맞다.
- GPS의 기존 시험 UID 마지막 수신은 15:26:41 KST로 유지됐다. GPS API 프로세스/실행 파일 및 홈·KC 진단 페이지 SHA256은 전환 전과 동일했다.
- raw serial, SIM/IMEI, 단말 키, 비밀번호, 실제 위치는 개인 운영 경로에만 보관한다. 이 기록에는 재현에 필요한 코드/검증 결과만 남긴다.

정적 SRAM 여유는 스택 최고 사용량 측정을 대신하지 않는다. 이번 실물 검증은 단기 연속 수신이며 장기 망 장애·전원 차단 중 전체 이동 경로 보존을 보장하는 시험은 아니다. NTP 불가 상태에서는 키/측정값 전송을 보류한다.
