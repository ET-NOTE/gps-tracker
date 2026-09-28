# Shield 운영 분리 배포 · 2026-09-28

## 사용자 승인과 적용 결과

사용자는 신규 Shield 운영 배포, GPS의 Shield 전용 화면 점진적 축소를 승인했다. 실제 USIM 연동·충전은 GPS에서 이미 검증 완료했으므로 비가역적 시험을 반복하지 말라고 지정했다. 프론트 도메인에 귀속되는 지도 등의 외부 API 등록은 후속 라운드로 허용했다.

- 운영: **https://shield.serial.kr/**, API `127.0.0.1:3043`, 전용 `shield-api.service`.
- 코드 릴리스: `shield-20260928-145123-7c1307a`, 코드 커밋 `7c1307a`. 추가 운영 스크립트·기록은 후속 Git 커밋으로 관리한다.
- 아카이브 SHA256: `5689c9634897f815f0a753730fbb7c0ad04451811f0590b01116c9426b07a4ac`.
- `etcom-hub`에서 빌드된 파일만 VPS에 배포했다. VPS에서 컴파일하지 않았다.
- PostgreSQL 14 엔진은 기존과 공유하지만 DB `shield_prod`, 로그인 역할 `shield_app`, 계정·세션·장치·데이터는 독립이다. OS 사용자도 `gps-shield`로 별도다.
- `shield.serial.kr` A 레코드가 기존 VPS `210.114.18.16`을 가리킴을 확인했다. 기존 ACME 계정으로 전용 TLS 인증서를 발급했고 만료일은 2026-12-27이다. 자동 갱신과 해당 인증서 갱신 후 nginx 검사·reload hook을 구성했다.
- 가입은 7일/1회 초대코드 방식이다. 소유자용 코드를 발급해 Windows의 개인 파일로 전달하며 Git이나 공개 URL에는 넣지 않았다. GPS 비밀번호/JWT/FCM 토큰을 복사하지 않았다.

## GPS/KC 보존과 화면 축소

- GPS nginx에서 **세 개의 기존 monitor location만** 수정했다. `/arduino-shield` 및 끝 `/` 경로는 `https://shield.serial.kr/data`로 302; `/arduino-shield/data`는 410.
- `/diagnostic`, `/diagnostic/data`, `/dht`, `/ingest`, `/ingest/shield`, 스캔·페어링·FCM의 코드와 라우팅은 보존했다. 기존 운영 API/웹 빌드를 교체하지 않았다.
- GPS API SHA256 `81214c4f4c49ee361a92271f913271ccc9bc633b7d0e41e51807df945cae79d9` 유지. 실행 PID 55990 및 시작 시각 유지. GPS 홈과 KC 진단 페이지의 HTTP 상태 및 응답 본문 SHA256이 배포 전과 같았다.
- `idf-caltest`, `03_8`, 실제 UNO `03_10` v11은 변경·업로드하지 않았다. 실제 장치 `uno-shield-test`는 기존 GPS 수신 경로와 소유자 연결을 유지한다. **배포 후 15:18:53 KST에도 기존 GPS에서 마지막 수신 시각 갱신을 확인했다.** 새 사이트가 현재 그 실제 장치를 자동으로 보여주는 상태는 아니다.
- DB는 권한/HBA 추가 후 설정 reload만 수행했으며 PostgreSQL 서비스를 재시작하지 않았다. nginx는 전체 설정 검사 후 graceful reload했다.
- 신규 서비스의 분리는 논리적/권한적 분리다. VPS·PostgreSQL 엔진·스토리지·클러스터 관리자는 공유한다.

## 실제 운영 검증

1. 운영 HTTPS 기준 **34개 검사 통과**: 신규 가입·호스트 전용 보안 쿠키, 단말 등록/키 인증, GPS 5점·온습도 수신, 중복 제거, 계정별 조회 격리, WSS 갱신, Origin 확인, 로그아웃 시 세션/스트림 폐기.
2. `shield_app`에서 `gps_tracker`, `gps_tracker_dev`, `gps_tracker_dev_next_20260924` 연결이 HBA로 모두 거절됨. GPS 운영·개발 역할은 Shield DB CONNECT 권한 없음. Shield 역할은 관리자 권한 없음.
3. 브라우저에서 운영 로그인, 합성 온도 24.8°C/습도 58%, 좌표와 실제 지도 타일 표시, 로그아웃 확인. JS 오류/경고 없음. 검증용 계정 2개와 장치/데이터는 정확한 생성 식별자로 삭제했다.
4. 앞선 57개 자동 검사 및 모바일/차트/CSV 내용 검증은 [구현 기록](shield-platform-2026-09-28.md) 참조. 인앱 브라우저의 실제 CSV 파일 저장 완료는 아직 확인되지 않았으므로 일반 브라우저 저장 검증은 후속이다.
5. 운영 초기 서비스 메모리 약 **21 MiB**, 재시작 0회, VPS 가용 메모리 약 **1.1 GiB**, 디스크 여유 **4.2 GiB / 91% 사용**. 동시 사용자 부하 검증을 대신하는 수치는 아니다.

## 백업과 복원

- 변경 전 GPS DB 전체 custom dump와 nginx/HBA를 VPS `/var/backups/shield-rollout/<release>`에 저장했다. 묶음은 Windows `%LOCALAPPDATA%/GPS-Builds/<release>/pre-deploy/backup.tar.gz`로 복사하고 SHA256 `95afb352f4cd7100d9de42963b8c6274d290fec5b8fba412639366a8ba825146`을 확인했다. 기존 GPS dump의 TimescaleDB 복원 시험은 이번 작업에서 수행하지 않았다.
- Shield는 매일 02:35 KST(+최대 5분) VPS 백업, 03:20 KST(+최대 5분) `etcom-hub`로 복사한다. 보관은 VPS 7일, 러너 14일. 백업에는 DB/전용 환경변수/서비스/nginx/릴리스 정보가 들어가므로 개인 접근 권한으로 제한했다.
- 복사 키는 강제 명령으로 최신 Shield 백업만 내보내며 shell/forward/PTY가 금지된다. SSH 서버의 실제 허용 호스트키(ECDSA)를 Windows의 기존 신뢰 키와 대조해 고정했다. 호스트키 검사 우회는 없다.
- PostgreSQL 14 격리 컨테이너에 실제 복사본 복원 성공: users 2, devices 1, readings 1, location_records 5, schema versions 1~4. 검증 컨테이너는 삭제했다. 합성 계정 정리·최초 초대 발급 이후 새 백업을 다시 생성하고 offsite 복사를 완료했다.
- 스케줄/서비스 실패는 systemd journal로 확인한다. 새로운 외부 알림 채널은 연결하지 않았다.

## 후속 ToDo와 순서

- [ ] `user@user.com`이 **Shield 전용 계정**으로 가입. 실제 단말용 고유 UID/키/등록 코드를 발급하고 신규 소유권을 확인한다.
- [ ] 실제 SIM7080G의 인증서 검증 HTTPS·키 헤더를 구현/확인한 뒤 펌웨어 전송 주소를 전환한다. 현재 v11에 도메인만 치환하면 인증에 실패한다. 전환 전까지 GPS ingest를 유지한다.
- [ ] 필요한 과거 데이터는 해당 단말·소유자 범위만 복사하여 UTC/건수/중복을 검증한다. GPS 원본 삭제는 포함하지 않는다.
- [ ] 실물 수신 전환 후 GPS 쉴드 전용 monitor 라우터·HTML/SQL·공개 시험 예외를 제거한다. 이어서 필요 없어진 legacy Shield ingest를 종료한다. KC/IDF의 일반 ingest/diagnostic은 그대로 둔다.
- [ ] USIM: 기존 `services/nce.rs`의 OAuth·ICCID 정규화·잔량/주문 조회·topup 전송 구현을 재사용한다. 새 DB에서 ICCID-단말-소유권, 캐시, 요청/장부 상태를 연결한다. GPS 장부를 런타임에 조회하거나 두 서비스에서 같은 요청을 처리하지 않는다.
- [ ] 기존 충전은 1회 500MB, 사용자 요청→관리자 처리→1NCE 주문 기록 흐름이다. 시안의 100MB/1GB 상품·가격은 실제 상품으로 간주하지 않는다. Shield의 상품·결제 화면과 주문 ID 네임스페이스/콜백을 정합한다.
- [ ] **실제 topup/결제 호출로 재검증하지 않는다.** 이미 완료된 검증 결과와 mock/저장된 응답으로 재사용 부분을 확인한다. 외부 호출 이후 타임아웃 같은 결과 불명 상태는 무조건 재시도/환불하지 않고 주문 조회 또는 운영 확인으로 조정하도록 이식 시 보완한다.
- [ ] 프론트 도메인 의존 설정: 기존 Kakao 지도 JS 앱의 허용 웹 도메인, Toss의 성공/실패 URL·웹훅·키 적용 범위를 후속 라운드에서 확인한다. 현재 Shield의 기본 Leaflet/OSM 지도는 운영 도메인에서 표시 확인했다.
- [ ] 초대 운영 이후 계정 복구/이메일 인증/보존 정책/서비스 안내를 확정하고 공개 가입 여부를 검토한다. 디스크 여유가 적으므로 운영 데이터 보존 기준 없이 무기한 규모를 확대하지 않는다.

USIM 잔량·결제 기능은 아직 Shield에서 활성화하지 않았다. GPS에서의 실충전 검증 완료와 Shield의 계정·장부 이식 완료는 구분한다. 재시험 미수행을 기능 구현 완료로 보고하지 않는다.
