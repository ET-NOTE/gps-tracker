# 단말기별 절전 정기 보고 원격 설정

2026-10-21 KST. 사용자 요청: 절전 기상 시간을 서버에서 변경, 최대 24시간, 기본24시간. 연결된 실물은 COM62/MAC `68:ee:8f:21:33:64`, 기존10분 운영 빌드였다.

## 반영 상태

- 운영 API·웹 릴리스 `dev-20261021-190449-d541456` (health 환경 production). 소스 `d541456315ab56d0fd5ea1167833d23d3a9955c6`.
- API SHA256 `35323e272cccc81843fa33442fb27dfa08f0f01b3f5133b15d4f9bbf28abd62b`. 운영 웹 `/home/mmm/releases/prod-20261021-190449-d541456/web`.
- schema72 유지. 운영 env/nginx/migration checksum 유지, 기존 기록 수 비감소 확인. dev-gps 및 Flutter/APK는 변경하지 않았다.
- 운영 펌웨어 `idf-caltest/operating-d541456315`를 실물에 업로드하고 esptool 해시 검증을 통과했다. 실제 파티션 테이블 일치와 활성 app0를 확인한 뒤 `0x10000` 앱 영역만 기록했다. NVS·OTA 선택·부트로더는 보존했다.
- 업로드 후 기존 하드웨어 서명자 `sim-47520211`이 같은 SIM 논리 장치3163/소유자28에 계속 수신되는 것을 확인했다. 서명 요청·서버 응답 검증, HTTP200, LTE REG5 확인. 실제 수신 `fw_version=operating-d541456315`, 절전 활성, 타이머86400초, 원격 설정 지원true.
- **실물 원격 저장·재부팅 유지 검증은 아직 미완료다.** 서버 배포 직전인19:08:49 KST에 COM62가 사라지며 시리얼 읽기가 끊겼고, 마지막 서버 수신은19:08:47.388877 KST이다. 당시 서버는 구버전이어서 새 `device_config`가 없었으며 실물의 `sleep_report_saved=false`였다. 재연결을 요청했다. 펌웨어/호스트의 NVS 저장·재부팅 시뮬레이션 통과와 실제 저장 확인을 혼동하지 않는다.
- 브라우저에서 서버 설정10분 저장 후24시간으로 복구했다. 현재 서버 희망값86400초, 마지막 실물 보고값86400초이나 저장 확인이 없으므로 UI는 적용 대기로 표시한다. 24시간 경과 실측 검증도 아직 수행하지 않았다.

## 사용 방법과 전달 규칙

1. **단말기 → 상세·통계 → 절전 중 정기 보고**. 프리셋10분/30분/1·3·6·12·24시간 또는 직접1~1440분을 입력한다. 최대24시간, 기본24시간. 휴대폰 트래커에는 표시하지 않는다.
2. 소유자 인증된 `POST /gps-tracker/api/v1/devices/:id/sleep-report-interval`에 `{"seconds":86400}`. 정수60~86400초,60의 배수만 허용한다. 타 소유/미연결 장치는404, 휴대폰과 범위 오류는400, JSON 자료형 오류는422.
3. 서버 희망값은 `users.prefs.device_runtime.<device_id>.sleep_report_interval_s`에 소유자·SIM 논리 장치별로 저장한다. 장치와 사용자 행 잠금으로 다른 장치/일반 설정과의 동시 수정 손실을 막는다. 일반 prefs PATCH에서 이 예약 키를 덮어쓰지 못하게 한다. 같은 소유자의 SIM 재연결은 기존값을 유지하고, 다른 소유자가 연결하면 그 계정의 기본24시간으로 시작한다. 인증키는 하드웨어별로 별도 유지한다.
4. 인증된 ingest 응답마다 `{"ok":true,"device_config":{"sleep_report_interval_s":86400}}`를 전달한다. 일회성 명령 큐의10분 TTL과 독립적이므로 오래 잠든 단말기도 다음 통신에 받는다. 기존 부저/reset 명령과 함께 전달된다.
5. 펌웨어는 기존 HMAC·카운터 응답 검증 후 설정을 해석한다. 중복 명령 수신 무시보다 먼저 적용한다. NVS `gps-report.seconds`에 저장·재읽기 검증한 다음 RAM값을 바꾸며, 같은 값의 반복 POST는 플래시를 다시 쓰지 않는다. 잘못된 값·저장 실패는 이전값을 유지한다. gps-auth 키·카운터와 별도 namespace이다.
6. 재부팅/딥슬립 기상 후 `sleep_mgr::begin()`보다 먼저 NVS값을 읽으므로 모션 바운스 조기 재절전에도 저장된 주기를 사용한다. `uint64_t(seconds)*1000000ULL`로 실제 타이머에 전달한다. 움직임 기상과 PWRKEY/DTR은 유지한다.
7. 후속 텔레메트리의 `stationary.timer_wake_s`, `sleep_report_remote`, `sleep_report_saved`로 실제 적용을 확인한다. 희망값과 다르거나 저장 확인이 없으면 대기, 구형/절전 해제 빌드는 펌웨어 갱신 안내. 서버 저장만으로 적용 완료라고 표시하지 않는다.
8. 절전 중에는 즉시 설정을 받을 수 없다. 다음 통신에서 받아 저장하고, 다음 절전부터 새 주기를 사용한다. 짧은 보고 간격은 배터리 소모를 늘린다. 내정보의 전원 켜짐·정기 상태 보고 알림 ON/OFF는 기존 별도 설정을 유지한다.

## 검증

- 빌드 러너 Node22에서 웹132개 테스트 전부 통과. 새 컴포넌트의 잘못된 분 입력, 저장 실패, 입력 중 자동 새로고침, 서버 희망값과 실제 보고값의 차이, 구형·미저장 상태를 검증했다. 로컬 Windows Node의 기존 calendar VM 테스트는 접근 위반 종료가 재현되어, 정상 통과한 지정 빌드 러너 결과를 기준으로 삼았다.
- Rust fmt/clippy 통과. 단위20개, 별도 격리 PostgreSQL의 FCM 내구성·AI 원자성 테스트 각각 통과.
- 외부 FCM/결제/OpenAI 키가 없는 schema72 복제 DB와 loopback3042에서 새 API 기본값·상하한·자료형·소유권·일반 prefs 보존·보호 키·휴대폰 거절·희망/실제 구분·명령 재전송/만료와 설정 병행·동일 SIM 하드웨어 교체·소유자 변경 격리를 검증했다. 기존 daily/dev API/SIM 최초 등록 회귀도 통과. 검증 서비스 종료.
- API 422 응답은 JSON이 아닌 텍스트이므로 검증 도구 파서를 보완했다. API/웹/펌웨어 실행 코드는 배포 커밋 그대로이며, 보완한 검증 스크립트는 후속 커밋에 기록한다.
- ESP-IDF5.5.4 공식 컨테이너에서 펌웨어106개 프로필·시나리오·JSON 계약 검증과 운영 빌드 성공. 실제 NVS 모듈의 기본값/경계/잘못된 JSON/저장 실패/재시작/반복 쓰기 방지, 동적600초 타이머 인자 검증 포함.
- 운영 브라우저에서10분 저장 후24시간 복구. 콘솔 error 없음. 390px 뷰포트에서 문서 너비390px, 설정 폼299px로 가로 넘침 없음. 임시 브라우저 뷰포트 복구.

## 산출물과 복구

- 로컬 산출물: `C:/Users/msb/AppData/Local/GPS-Builds/gps-remote-report-20261021/`.
- 운영 펌웨어 ZIP `gps-operating-remote-report.zip`, SHA256 `f1311b97a7c8239d2bc7d49f405aac9ad44ad2435bbfbe9f57404e9a7c874ed2`.
- 앱 `caltest.bin` SHA256 `f4c8b037ca9b7acb7c0c77025b3bfd6370edc9f4664590aec4ba0b2937efe012`.
- manifest는 원래 빌드 산출물의 `flashed=false` 메타데이터를 보존한다. 실제 기록 여부와 확인 범위는 별도 `flash-verification.json` 및 `flash.log`, `serial-new.log`에 기록했다.
- 실물 전체4MiB 사전 백업 `device-before-flash.bin`은 인증 정보를 포함할 수 있어 로컬에서만 보관하며 Git/공개 배포물에 넣지 않는다.
- 서버 백업 `/home/mmm/backups/remote-report-dev-20261021-190449-d541456`. 이전 API SHA256 `c8bf14afd3596a245649aedc9a065c2eeabe97c146e12bd589a4f0dec1329c3f`, 이전 웹 `/home/mmm/releases/prod-20261021-183207-4eccbaa/web`.
- `ops/release_remote_report.py`가 이전 운영 해시·migration checksum·복제 검증 receipt를 확인하고 원자적으로 교체하며, 실패 시 이전 API/웹으로 복구한다.
- 재연결 시 남은 검증: 서버10분 또는1시간 → 실물 CONFIG saved 로그 → 후속 reported 일치 → 재부팅 후 NVS 읽기 → 서버24시간 복구 → 최종 reported 일치. 실제24시간 경과 검증은 별도 운용 관찰이 필요하다.
