# dev 운영본 정합 — 2026-10-25

## 범위와 결과

사용자는 dev 배포본이 뒤처진 점을 확인하고 운영본 기준으로 정합하도록 승인했다.
대상은 `dev-gps.serial.kr`이며 운영 API·웹·DB·환경 파일은 변경하지 않았다.
dev의 사용자, 장치, 이력, 이용권, 비밀키는 보존했다. 운영 계정에 지급한 이용권은 dev로 복사하지 않았다.

| 대상 | 전환 전 | 전환 후 |
| --- | --- | --- |
| API 소스 | `120a144` | 운영과 같은 `d541456315ab56d0fd5ea1167833d23d3a9955c6` |
| 웹 소스 | `9b0e2db4b4ce5251b81a4dcb66ae38573481f1a9` | 운영과 같은 `2126bd46e853a154d4a4dbde5684e23523fe60ca` |
| DB 마이그레이션 | 68 | 72 |
| 서버 소스 checkout | `6bc27c2` | `19736eeaa2ba376baf5e4fbfd947816f0e285e44` |
| 서버 작업 브랜치 | `codex/dev-aligned-20261015` | `codex/dev-aligned-20261025` |

웹 릴리스는 `dev-aligned-20261025-2126bd4`이다. API는 이미 운영 검증된 바이너리를 재사용했다.
API `/health`의 릴리스 문자열 `dev-20261021-190449-d541456`은 빌드 이름이며 환경은 `development`이다.
API SHA-256은 `35323e272cccc81843fa33442fb27dfa08f0f01b3f5133b15d4f9bbf28abd62b`이다.

서버 소스는 `/home/gps-dev/workspace/gps-tracker`에 있고 작업 트리는 깨끗하다.
`/home/gps-dev/gps-tracker-web-dev/source`도 이 checkout의 웹 소스를 가리킨다.
애플리케이션은 운영본과 같으며 이 문서와 일회성 정합 스크립트의 후속 로컬 커밋은 배포에 필요하지 않다.

## dev 고유 변경 검토

웹 배포 `9b0e2db`의 소스 커밋은 서버 checkout, 로컬 Git 객체, 확인 가능한 원격 브랜치에서 찾지 못했다.
따라서 서버에서 배포한 사실과 서버에서 소스를 작성한 사실을 동일하게 취급하지 않았다.
공개된 JS/CSS 번들을 비교해 다음 흡수 후보를 확인했다.

- 관리자 사용자·장치 목록의 검색, 아바타, 카드 형태의 행, 좁은 화면 배치.
- 관리자 채팅 목록/대화 분할 화면, 읽지 않은 메시지 배지, 모바일 목록 복귀.
- 이름·이메일 검색과 메시지/날짜 필터의 표시 방식, 관리자 탭 디자인.

기존 운영 소스에도 관련 API와 메시지/날짜 검색 기능이 있다. 확인한 차이는 주로 화면 구성이다.
원본 소스가 없어 완전한 소스 변경 검토나 원래 작성자 확인을 마쳤다고 표현할 수 없다.
이번에는 사용자 승인에 따라 운영 UI로 정합했으며 이 고유 UI를 운영에 이식하지 않았다.
기존 웹 번들과 서버 소스 전체는 백업했다. 재검토 시 원본 `9b0e2db` 소스를 확보하는 것이 우선이다.

## 데이터와 환경 보존

- 사용자 6명, 장치 10개, 위치 기록 47,823건 유지.
- 전환 직전 repeatable-read snapshot의 모든 기존 public 테이블·열을 행 해시로 비교했다.
- 마이그레이션 70에 따른 차량번호 별칭 정규화 1건은 예상 결과로 별도 검증했다. 두 필드가 다르면 기존 `car_plate`를 우선하여 맞춘다. 정규화 전 값은 백업에 있다.
- Timescale 위치 이력은 일반 dump와 함께 `COPY (SELECT * FROM public.location_records)` CSV로 저장했다. `COPY public.location_records`는 하위 청크를 포함하지 않으므로 사용하지 않는다.
- dev DB `gps_tracker_dev_next_20260924`, 역할 `gps_tracker_dev_app`, JWT, CORS, SMS 개발 모드 유지.
- 결제·푸시·AI·1NCE 등 외부 서비스의 운영 자격 증명은 복사하지 않았다.

신규 서버에 필요한 설정만 dev에 추가했다.

```text
GPS_LEGACY_INGEST_ENABLED=1
GPS_KC_INGEST_ENABLED=0
GPS_KC_PAIRING_ENABLED=0
PRIVATE_UPLOAD_DIR=/home/gps-dev/gps-private-uploads
```

기존 등록된 구 펌웨어의 통신을 유지하며 임의 장치 자동 등록과 전수 스캔 진입은 차단한다.
서명 인증을 시작한 장치가 레거시 통신으로 돌아가는 것은 API에서 거부한다.
기존 차량 사진 1개는 비공개 저장소로 복사하고 소유자 API로만 제공한다.
dev nginx의 `/uploads/car-images/` 직접 접근은 404이며 dev systemd에 비공개 업로드 경로 쓰기 권한만 추가했다.
공유 nginx 설정 적용을 위해 reload했으나 운영 virtual host 파일과 운영 API 프로세스는 유지했다.

## 검증

복제 DB `gps_tracker_dev_sync_20261025`에서 원본 행 일치, 마이그레이션 68→72와 checksum을 확인했다.
외부 서비스 키 없는 localhost:3042 검증 프로세스에서 다음 8종이 통과했다.

- `test_dev_api.py`: 소유권, 배치 위치, 날짜, 업로드, 부분 삭제.
- `test_business_api.py`: 법인·렌트카 API.
- `test_battery_runtime_api.py`: 배터리 운용시간 계산.
- `test_security_boundaries.py`: 서명·재전송·타 계정 차단, 사진 보호, 실패 작업 재시도, 이력 보존.
- `test_sim_hardware.py`, `test_sim_first_registration.py`: SIM 이동과 최초 등록.
- `test_daily_heartbeat.py`, `test_remote_report.py`: 일간 상태 보고와 원격 주기 설정.

검증에서만 `GPS_STATS_POLL_SECONDS=5`로 실제 통계 워커를 시험했다. 서비스 dev 설정에는 이 시험값을 넣지 않았다.
검증용 프로세스는 종료했고 복제 DB의 Timescale 작업은 중지 상태로 보관했다.
실물 단말기 명령, 결제, 문자, 푸시는 수행하지 않았다.

배포 후 공개 HTTPS 주소에서 기존 6개 dev 계정으로 API 조회/권한 60건과 기존 사진의 소유자 접근·익명 차단을 확인했다.
웹 산출물 44개 해시를 대조했다. 브라우저 로그인 화면 및 `/corporate`의 로그인 복귀 경로가 정상이며 콘솔 오류가 없었다.
로그인 이후 전체 UI 실기기 시험을 새로 수행한 것은 아니다.
dev 서비스는 정상 실행 중이며 자동 재시작 횟수 0이다.
운영 API·환경 파일·웹 index/version·nginx 설정의 해시, API PID와 시작 시각이 전환 전후 동일하다.

## 백업과 복구

서버 백업: `/home/gps-dev/backups/prod-align-20261025` (접근 제한).
PC 백업: `C:/Users/msb/AppData/Local/GPS-PrivateBackups/prod-align-20261025`.

- `private-backup.tar.gz`: 전환 전 백업, SHA-256 `4d30a22ce5522e8ec08b0a3abd4f4b497560717fb71c19909be2b2f458c1055e`.
- `final-backup.tar.gz`: 전환 직전 snapshot과 배포/검증 결과 포함, SHA-256 `f20dc52019cb2443518c89bb5c12cfeca0329e0752749687b5b7b220b9ebf7ed`.
- `dev-before.dump`/`dev-cutover.dump`는 각각 같은 접두사의 `-locations.csv.gz`와 함께 복원해야 한다.
- 기존 웹 `/home/gps-dev/gps-tracker-web-dev/releases/dev-web-20261020-9b0e2db/web`과 `codex/dev-before-align-20261025` 소스 브랜치도 남겼다.

런타임 롤백은 dev만 중지한 뒤 백업의 API·env·dev nginx와 원래 웹 symlink를 복원하고 추가한 systemd `private-uploads.conf`를 제거한다.
nginx 문법 검사 후 reload, systemd daemon-reload, dev API 시작 순서로 적용한다. 운영 경로를 복원 대상으로 사용하지 않는다.
마이그레이션 69~72는 추가 변경이므로 런타임 롤백에서 DB를 삭제하거나 과거 DB로 덮지 않는다.
이번 수동 백업은 정기 백업 체계 구축을 의미하지 않는다.
