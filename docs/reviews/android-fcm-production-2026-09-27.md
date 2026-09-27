# Android FCM 개선 및 운영 반영 — 2026-09-27

## 반영 결과

사용자가 이번 작업에 대해 prod 및 앱 직접 개선과 dev 선행 변경의 운영 흡수를 허가했다. 이에 기존 dev 개선을 포함한 서버/웹과 FCM 변경을 운영에 반영했다. 이후 dev도 같은 빌드로 맞췄다. 보호된 main은 직접 변경하지 않고 별도 브랜치로 관리한다.

| 항목 | 결과 |
| --- | --- |
| 서버/웹 소스 | `b340ba2a2f4bc63843971891000c3669ee372022` |
| 공통 빌드 ID | `dev-20260927-150045-b340ba2` |
| 운영 | `gps.serial.kr`, APP_ENV=production, API 3040, schema 65 |
| 개발 | `dev-gps.serial.kr`, APP_ENV=development, API 3041, schema 65 |
| 서버 작업 브랜치 | `codex/gps-app-fcm` |
| Android 소스 | `yeyebee/gps-tracker-app`, `codex/android-fcm-hardening`, `a6e20b7` |
| Android 산출물 | release 서명 APK/AAB, versionName 1.0.1 / versionCode 7 |

빌드 ID의 `dev-`는 dev에서 검증한 **동일 산출물**을 승격했다는 뜻이다. 운영 서비스는 production 설정/운영 DB를 사용한다. 운영 `/version.json`의 target은 production, build_target은 dev다. 배포 스크립트 수정 및 이 문서 같은 후속 커밋은 런타임 코드 변경이 아니다.

서버/웹은 etcom-hub의 제한된 빌드 컨테이너에서 빌드했다. Android는 Windows의 기존 Flutter 3.22.3 / Android SDK와 기존 릴리스 키를 사용했다. VPS에서 컴파일하지 않았다.

## 개선 범위

- 기존 dev의 API 소유권/업로드/이력 조회 보강, 서버 좌표 기반 속도 통일, 실시간/이력 시커와 웹 UI 개선을 함께 승격했다.
- 이벤트별·수신자별 durable outbox, lease 복구, 일시적 FCM 오류 재시도, 부분 성공 보존, UNREGISTERED 구분을 추가했다. 잘못 설정된 서비스 계정은 시작 실패로 처리한다.
- 앱의 토큰 등록은 성공 후 확정하며 순서와 세대를 관리한다. 오프라인 해제 요청을 보관하고, JWT 만료 후에도 해당 설치만 해제할 수 있다. local/sessionStorage와 인증 변경 이벤트를 지원한다.
- 알림 탭/앱 시작 목적지, 상담 링크, 채널/아이콘, 권한 거부 안내를 정리했다. 위치 등 네이티브 브리지는 신뢰 HTTPS origin과 main frame으로 제한했다. popup windowId 연결과 release 서명 누락 실패도 반영했다.
- 앱 저장소의 기존 미커밋 변경 4개는 `e2ce546`으로 먼저 보존했다. 그 위에서 개선했다.

API 계약은 [API_CONTRACT.md](../API_CONTRACT.md), 큐와 앱 동작은 [FCM_SETUP.md](../FCM_SETUP.md)를 따른다. 이전 [리뷰](android-flutter-fcm-review-2026-09-27.md)는 수정 전 상태를 기록한 문서다.

## KC 및 데이터 확인

- 운영 DB 스냅샷을 임시 DB에 복원한 뒤 기존 19개 압축 청크를 포함한 상태에서 60→65 마이그레이션과 회귀 검사를 통과했다.
- 원본 위치 이력 83,829행의 전체 행 해시와 사용자 수가 복원본에서 일치했다. 운영 배포 후에도 83,829행과 압축 청크 19개를 확인했다.
- 운영 환경 파일 해시, device UID/소유자/ICCID/reset/beep/post_interval 대기 상태 해시가 배포 전과 일치했다.
- `/diagnostic`, `/diagnostic/device` HTML은 배포 전 운영본과 바이트 단위로 일치한다. 공개 진단 API도 유지했다.
- 복원본에서 익명 no-fix ingest → 미등록 장치 scan → UID pairing, 익명 DHT 및 진단 조회를 검증했다. 실제 KC 장치에 명령이나 테스트 푸시를 보내지 않았다.
- 운영 HTTP/HTTPS `/ingest`는 잘못된 payload를 정상적으로 HTTP 400과 `invalid payload:` 오류로 거부한다. 이 검사는 device 조회/기록 전에 끝난다.
- `idf_caltest`, `arduino`, 두 KC 진단 HTML 파일은 main 대비 변경이 없다. nginx의 HTTP DHT/ingest 및 공개 진단 경로는 유지했다.

## 검증

| 검사 | 결과 |
| --- | --- |
| Flutter analyze / test | 진단 0건 / 5개 통과 |
| Android release APK / AAB | 최종 앱 소스로 모두 빌드 성공 |
| APK 서명 / ZIP 정렬 | 서명 검증 성공, 운영 assetlinks 인증서 SHA-256 일치, 16KiB ZIP alignment 검사 통과 |
| Rust fmt / clippy | fmt 및 `clippy --all-targets -- -D warnings` 통과 |
| Rust 테스트 | 일반 6개 통과; 별도 DB/모의 FCM 통합 테스트 1개를 명시적으로 실행하여 통과 |
| 발송 큐 통합 테스트 | 부분 성공/503 재시도, 만료 lease 복구, 계정 변경 취소, 큐 기록 실패 시 이벤트 보존 |
| 웹 단위 테스트 | 27개 통과 |
| API 회귀 | 기존 19개 그룹 + 앱 FCM/KC 5개 그룹, 총 24개 그룹을 복원본 및 dev preflight에서 통과 |
| 공개 dev 검사 | 기존 19개 그룹 재통과; 실제 WebSocket/REST 속도 일치 포함 |
| 공개 prod 검사 | health, 홈/장치/상담 SPA 경로, 정적 파일 36개 해시, 버전 manifest 확인 |
| 배포 후 API 로그 | 확인 시점 ERROR/panic 0건, FCM outbox 적체 0건 |

배포 후 실제 푸시 발송은 0건이다. 이는 오류가 없다는 상태 확인이며, 실제 휴대폰 표시/탭 성공을 검증한 결과가 아니다. ZIP 정렬 확인도 모든 네이티브 ELF의 16KiB 호환성 인증을 뜻하지 않는다.

## 배포 중 복구 및 운영 변경

처음 staging 단계에서 운영 업로드 디렉터리가 없어 사전 검사가 중단됐다. API 사용자인 mmm 소유로 `/home/mmm/uploads`를 준비했다.

스키마는 구 API가 계속 동작하는 동안 `GPS_MIGRATE_ONLY=1` 프로세스로 먼저 적용했다. 첫 전환 검사에서 정상적인 semantic payload 오류 HTTP 400을 422로 잘못 예상해 자동 롤백이 실행됐다. 새 스키마에 대응하는 구 API와 이전 웹/nginx로 복구됐으며 DB 쓰기는 보존했다. 검사의 기대값과 오류 본문 검증을 수정하고 다시 전환했다.

이후 API/KC 경로는 정상이었으나 새 release 상위 디렉터리가 0750으로 생성되어 정적 웹이 일시적으로 404를 반환했다. 상위 경로를 0755로 수정해 복구했고, 홈·장치 경로와 version manifest 검사를 승격 스크립트에 추가했다. 최종 공개 정적 파일 36개의 해시도 확인했다.

운영 nginx 변경은 `/api/v1/` 업로드 한도 40m 추가다. 기존 firmware ingest 한도 64k, HTTP DHT 한도 8k를 유지한다. API 환경 파일 및 systemd 서비스 설정은 바꾸지 않았다. 웹은 이전 hashed chunk를 보존해 열려 있던 브라우저의 lazy import가 가능하도록 했다.

## 백업과 복구

원격 비공개 백업: `/home/mmm/backups/gps-app-fcm-20260927`. Windows 사본: `%LOCALAPPDATA%\GPS-PrivateBackups\gps-app-fcm-20260927`. 환경 파일, 원래 API, 이전 웹/nginx, DB dump, 복원 manifest, 배포 증거를 보관한다. 비밀값과 실제 데이터는 Git에 넣지 않았다.

TimescaleDB 2.19.3에서 all-NULL 압축 컬럼이 포함된 일반 dump 복원 실패를 재현했다. 관련 상류 이슈는 [timescale/timescaledb #8893](https://github.com/timescale/timescaledb/issues/8893)다. 운영 DB를 업그레이드하거나 압축 해제하지 않았다. `pg_export_snapshot`으로 일관된 스냅샷을 고정하고, 압축 청크 데이터를 제외한 **prod-logical.dump와 COPY SELECT로 추출한 location_records.csv.gz를 함께** 보관해 복원을 검증했다. 두 파일과 logical-manifest.json이 한 복원 패키지다. 일반 prod.dump만으로 복구 가능하다고 간주하면 안 된다.

구 main API는 migration 61~65를 모르면 시작할 수 있으므로, main `c089845`에 migrator의 `.set_ignore_missing(true)` 한 줄만 추가한 `api.rollback-compatible`을 별도 빌드했다. 새 스키마 복원본에서 구 API 시작 및 KC HTML 일치를 확인했으며 실제 자동 롤백에서도 사용했다. API/web 복구 시 데이터베이스를 되감지 않는다. 파괴적인 down migration은 없다.

임시 운영 복원 DB `gps_tracker_dev_prodreview_20260927`과 그 업로드 디렉터리는 검증 후 제거했다. 상시 실행 환경을 추가하지 않았다. 기존 dev와 운영은 계속 동일 VPS의 별도 API/DB를 사용한다.

## 앱 산출물과 남은 확인

최종 산출물 디렉터리는 Windows `%LOCALAPPDATA%\GPS-Builds\android-1.0.1-7-a6e20b7`이다.

- APK SHA-256: `45be5dd94c3eacbbd510b077fe90666390c86bddd89ac061817572cd5576accb`
- AAB SHA-256: `829a8b0881c9d7fbbadc1a1697ad400d8b242dfb58867cf94cf64b09a9077bce`
- 서명 인증서 SHA-256: `2b2668fd35eefe3ef00041547e79a251c1bfb5c6c5954514eff6f0b4b6de70d1`

서버/웹 개선은 운영에 적용됐다. 네이티브 앱 개선은 새 APK 설치 또는 해당 AAB의 스토어 배포가 필요하다. 이번 작업에서 Play Console 게시나 실물 휴대폰 설치는 하지 않았다.

자동 승인 검토가 읽기 전용 Android 에뮬레이터 실행을 거부했으며, 도구의 사유는 '정책상 차단'뿐이었다. 우회 실행하지 않았다. 실제 Android의 권한 허용/거절, foreground/background/종료 상태 수신과 탭, 오프라인 로그아웃·재접속, 결제 popup 화면 검증은 남아 있다.

앱의 별도 dev flavor/Firebase 프로젝트, Flutter 셸 전체 테마 통합은 완료 범위가 아니다. 상담 저장과 push enqueue 사이의 원자성, 서버 수락 후 응답 유실에 따른 중복, 오프라인 로그아웃 이후 이미 OS에 전달된 알림 취소 불가도 남는 한계다.
