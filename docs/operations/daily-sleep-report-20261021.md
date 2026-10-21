# 절전 중 정기 보고 기본값 24시간

2026-10-21 KST. 사용자가 10분 주기를 24시간으로 변경하고 관련 알림 ON/OFF를 요청했다. 기존에 조절 가능한 시간은 ‘미수신 후 연결 확인 알림 시점’이며, 하드웨어의 절전 기상 주기와는 별도다.

후속 상태: [서버 원격 주기 설정 및 실물 업로드 기록](remote-sleep-report-20261021.md)을 참고한다. 아래 내용은 이 문서 작성 당시의 이력이다.

## 반영과 남은 실물 작업

- 새 운영 펌웨어: `idf-caltest/operating-4eccbaac59`.
- 펌웨어와 API/웹 소스 커밋: `4eccbaac590b2b4f1d158a25ec781a0c8b095726`.
- 운영 API/웹 릴리스: `dev-20261021-183207-4eccbaa`. health environment는 production이다.
- 운영 API SHA256: `c8bf14afd3596a245649aedc9a065c2eeabe97c146e12bd589a4f0dec1329c3f`.
- 운영 웹: `/home/mmm/releases/prod-20261021-183207-4eccbaa/web`.
- schema72 유지. DB migration, 운영 계정의 알림 설정 일괄 변경, dev-gps 반영, APK 재발행은 수행하지 않았다.
- **단말-520211에는 아직 플래시하지 않았다.** 현재 PC에는 COM1만 있고 GPS USB 포트가 없다. 운영 DB 읽기 전용 확인에서 마지막 수신은 18:38:57 KST, 펌웨어 `operating-1bac6fb06b`, `timer_wake_s=600`, 절전 활성이다. 새 주기는 다음 USB 연결 후 펌웨어 갱신이 필요하다. 서버 설정만으로 기존 펌웨어의 10분 타이머가 바뀌지는 않는다.

## 동작

1. 운영 기본 `TIMER_WAKE_INTERVAL_S=86400`. 64-bit 곱으로 `86,400,000,000us`를 전달한다. 달력의 특정 시각이 아니라 절전 진입 후 24시간 기준이다. 움직임 기상은 그대로 즉시 처리하고, 주행 중 기존 수신 흐름을 유지한다.
2. 모션 GPIO, PWRKEY GPIO10 active HIGH/1500ms, DTR GPIO7 보호, 정지 판정과 KC/배터리 프로필의 절전 금지 규칙은 유지한다. 관찰 모드의 5분 설정도 유지한다.
3. 서버와 웹 상태 판정은 인증 단말기가 알린 `last_stationary.timer_wake_enabled=true`, `timer_wake_s`를 사용한다. 정수 60초~7일만 신뢰하며, 장기 미수신 판정은 `max(24시간, 예정 보고 간격+15분)`이다. 구형 10분 펌웨어·메타데이터 없음·잘못된 값은 기존 24시간 기준을 유지한다. 따라서 새 24시간 보고가 모뎀 접속 준비 중인 동안 미수신 상태가 먼저 뜨지 않는다.
4. **내정보 → 알림 → 전원 켜짐·정기 상태 보고**에서 기존 `wake_alert`를 켜고 끈다. 이 스위치는 전원 켜짐과 타이머 기상의 알림을 함께 제어한다. 별도의 움직임 알림은 `motion_alert`, 일반 절전 전환은 `sleep_alert`로 유지한다. 알림 OFF는 실제 정기 보고를 끄는 설정이 아니다.
5. 타이머 기상 푸시 제목은 ‘정기 상태 보고’로 구분한다. 정상 보고 후 `timer_hb`/`timer_hb_fail` 사유로 복귀하는 절전 이벤트는 추가 푸시를 보내지 않는다. FCM worker가 보고 직후 절전 이벤트를 먼저 보더라도 같은 부팅 카운터의 정기 보고를 보낼 수 있고, 설정 OFF·다른 기상·소유권 변경·유효시간 만료는 기존 정책대로 발송을 막는다.
6. 미수신 알림 기본 `offline_minutes=1440`은 이미 24시간이었고 그대로 유지했다. 기존 사용자가 선택한 다른 임계값을 초기화하지 않았다.

## 검증

- 웹 129개 테스트 통과. 실제 알림 설정 컴포넌트의 ON/OFF 저장과 움직임 설정 분리, 구형/24시간 보고의 절전 상태 경계 검증 포함.
- Rust fmt, clippy 경고 없음. 단위 테스트 19개 통과. 별도 격리 PostgreSQL/가짜 FCM의 재시도·취소·소유권·중복 방지 통합 테스트와 AI 결제 원자성 테스트 각각 통과했다. 타이머 보고 ON/OFF, 보고 후 재절전 중복 억제, 24시간10분 유예/24시간16분 장기 미수신 1회 생성 경계를 추가 검증했다.
- 운영과 분리된 기존 schema72 복제 DB와 loopback 3042 서비스에서 새 계정 기본24시간, 알림 ON/OFF GET/PATCH 영속성, 기존 API 회귀와 SIM 최초 등록 회귀를 검증했다. 외부 FCM·결제·OpenAI 키가 없는 test env만 사용했다. 검증 서비스는 종료했다.
- 실제 ESP-IDF 5.5.4 운영 빌드 성공. 호스트 펌웨어 102개 프로필/시나리오·JSON 계약 테스트 통과. `.bin`의 FW-CONFIG에서 절전 활성, 타이머 활성, 86400초, KC 비활성, 기존 PWRKEY 값을 확인했다. dirty=false.
- 운영 브라우저에서 새 알림 이름과 기본24시간 안내를 확인했다. 기존 계정의 스위치는 변경하지 않았다. 390px에서 문서 너비도390px, 콘솔 error 없음.
- 운영 API DB/health 정상, service active. 배포 전후 기존 세 장치 기록 개수 비감소, 운영 env와 nginx 해시 유지, 전체 migration checksum 동일, 새 JS/CSS 해시 확인. 이전 lazy chunk 보존.
- 실제 24시간 절전 경과나 실물 전류 측정은 수행하지 않았다. 새 펌웨어 플래시 후 현장에서 확인해야 한다.

## 산출물과 복구

- 펌웨어 ZIP: `C:/Users/msb/AppData/Local/GPS-Builds/gps-daily-20261021/firmware/gps-operating-daily-20261021.zip`.
- ZIP SHA256: `9b42dbbcc9d5ad635993721e1ff9b5a676fd7812a642535ad75ddc15e1833a7a`.
- 앱 바이너리 `caltest.bin` SHA256: `3caa19cac685bff1bfac5b7b853aa22e3cbee661ed813aa64fb529b4c7424d94`.
- 같은 폴더의 manifest에 모든 세그먼트 해시·컴파일 설정·소스 해시를 기록했다. `flashed=false`.
- 빌드 러너는 전용 shallow 소스 저장소와 공식 `espressif/idf:v5.5.4`를 사용했다. 기존 partial clone의 누락 과거 객체 때문에 일반 복제가 실패하여, 현재 커밋·트리·블롭만 갖춘 독립 shallow build 저장소를 구성했다. 기존 저장소를 수정하지 않았다.
- 서버 백업: `/home/mmm/backups/daily-heartbeat-dev-20261021-183207-4eccbaa` (직전 API와 웹, 환경·nginx 해시 및 기준 기록 개수).
- 이전 웹: `/home/mmm/releases/web-remediation-20261021-4294630/web`. 이전 API는 schema72 호환이며 롤백 시 기록이나 스키마를 삭제하지 않는다.
- `ops/release_daily_heartbeat.py`는 원래 API/웹 커밋과 해시, 격리 검증 receipt를 확인한 뒤 배포하며 실패하면 이전 API/웹으로 복구한다.
- 로컬 검증 산출물: `C:/Users/msb/AppData/Local/GPS-Builds/gps-daily-20261021/`의 `deploy.log`, `notification-settings.png`; API/웹 빌드는 `../dev-20261021-183207-4eccbaa/`에 보관한다.
