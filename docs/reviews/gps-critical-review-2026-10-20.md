# gps.serial.kr 전체 결함 검토

2026년 10월 20일 KST 기준. 개인정보와 기록 보존 경계부터 수정할 필요가 있다. 화면 개선이 진행된 법인차·렌트카 영역에도 기존 Fleet, 기본 홈, 네이티브 앱과의 연결에서 동작과 표현이 갈린다.

> 후속 진행: [인증·SIM 분리·기록 보존](../operations/sim-first-hardware-rollout-20261020.md), [웹 3차 알림·상태 표시](../operations/gps-web-round3-20261020.md)에 수정 내역과 검증 범위를 기록했다. 아래 내용은 최초 검토 당시의 상태다.

확인 항목은 **P1 6건, P2 11건, P3 1건**이다. P1은 개인정보·소유권·데이터 손실 때문에 먼저 처리할 항목이며, 현재 사고가 발생했다는 뜻은 아니다. UI 재현과 운영 소스 확인을 구분했다. 서비스 및 운영 데이터 변경은 하지 않았다.

## 검토 기준과 운영 상태

- 운영 웹은 prod-web-20261019-495e7bb, API는 dev-20261014-180945-120a144다. API의 release 이름에 dev가 있지만 health의 environment는 production이다. 로컬 검토 소스와 운영 API 커밋 사이 API 변경은 없었다.
- 운영 health는 DB 포함 정상이고 API 서비스는 active였다. 읽기 전용 확인 당시 통계 재집계 대기열은 0건이었다. 최근 24시간 로그의 daily_stats 오류·housekeeping 오류·panic·ERROR 검색에는 일치 항목이 없었다. 이 결과는 오류가 전혀 없다는 보장은 아니다.
- 웹 기존 테스트 97개가 통과했다. 자동 브라우저 검토는 운영과 같은 웹 빌드 및 저장소의 business-preview를 사용했다. 개인·법인·렌트카 계정과 390px·1440px 화면, 정상·SDK 실패·잘못된 주소·키보드 조작을 확인했다.
- 브라우저 API는 가상 응답으로 대체했고 변경 요청은 로컬에서 가로챘다. 운영 SQL은 BEGIN READ ONLY로 실행했다. 실제 소유권 탈취·장치 위조 송신·명령 소비·포인트 차감·데이터 삭제·푸시 발송은 실행하지 않았다.
- Android 항목은 현재 1.0.5 소스와 설치된 WebView 플러그인 소스로 확인했다. 이번 라운드에서는 실기기 재설치·백그라운드 복귀·실제 파일 다운로드를 다시 수행하지 않았다.

## 먼저 처리할 개인정보와 기록 보존 문제

### 1 P1 장치 식별자만 알면 다른 장치의 수신 데이터를 위조할 수 있다

**운영 소스와 nginx 설정 확인.** [ingest.rs:155](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-api/src/routes/ingest.rs:155)는 장치 비밀키나 서명 검증 없이 JSON을 받고 UID 또는 ICCID로 기존 장치를 찾는다. 신규 행의 api_key_hash도 빈 값이다([ingest.rs:252](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-api/src/routes/ingest.rs:252)). 실제 nginx의 HTTP와 HTTPS /ingest 경로에도 별도의 장치 인증·IP 제한이 없었다.

따라서 식별자를 아는 요청이 해당 장치의 좌표·최근 수신 상태·이벤트를 변경할 수 있고, 응답 생성 때 실제 장치에 보낼 beep/reset 명령까지 소비할 수 있다. 9월 24일 검토에서도 지적된 미해결 항목이다.

개별 장치 인증, 요청 재전송 방지와 전송 보호를 넣어야 한다. 배포된 펌웨어와 KC 시험에 대한 전환 경로는 분리해야 한다. 기존 펌웨어를 일괄 차단하는 방식은 피한다.

### 2 P1 일반 사용자에게 남의 미등록 장치를 발견하고 선점할 경로가 있다

**운영 소스 확인.** [devices.rs:323](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-api/src/routes/devices.rs:323)의 scan_unpaired는 일반 AuthUser만 요구하고, 최근 10분간 송신한 모든 미소유 장치의 UID를 반환한다. [devices.rs:357](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-api/src/routes/devices.rs:357)의 pair는 그 UID 또는 ICCID로 연결한다. 물리적 보유 증명이 없다.

동시 등록 시 소유권 덮어쓰기는 원자적 UPDATE로 막았지만, 다른 사람이 먼저 등록하는 문제는 남았다. KC 시험용 검색을 시험 계정·지정 장치로 제한하고 일반 제품에는 기기에서 확인하는 일회용 등록 증명을 사용해야 한다. 이 항목도 9월 검토의 미해결 사항이다.

### 3 P1 장치를 다른 계정에 넘기면 이전 차량 정보가 따라간다

**운영 소스 확인.** [devices.rs:663](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-api/src/routes/devices.rs:663)의 연결 해제는 예전 license_plate 등은 지우지만, 이후 추가한 car_plate·car_model·car_image_url·정비일·보험 만료일·검사 만료일은 지우지 않는다. [devices.rs:262](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-api/src/routes/devices.rs:262)의 장치 목록은 이 필드들을 새 소유자에게 그대로 반환한다.

A 계정이 차량 정보·사진을 저장 → 데이터 보관 후 해제 → B 계정이 같은 장치를 등록하면 A의 정보가 B에게 보이는 구조다. 확인 시점 운영 DB에는 해당 새 차량 정보가 저장된 장치가 0개여서 실제 유출 사례를 관측한 것은 아니다.

소유자 귀속 차량 정보의 초기화 범위를 한곳에서 관리해야 한다. 사진 파일의 접근·삭제 정책도 함께 맞춰야 한다.

### 4 P1 폐기하거나 만료시킨 렌트카 링크가 계약 정보를 계속 반환한다

**운영 소스 확인.** [rentcar.rs:1597](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-api/src/routes/rentcar.rs:1597)의 load_handoff_by_token은 토큰으로 행을 조회한 뒤 revoked/expired 상태 문자열만 바꾼다. 이후 [rentcar.rs:1672](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-api/src/routes/rentcar.rs:1672)에서 임차인 이름, 차량 정보, 계약 기간, 요금·보증금 등을 그대로 반환한다.

웹은 “취소된 링크/만료된 링크” 화면으로 숨기지만 API 응답에는 정보가 남는다. 링크를 알고 있던 사람의 접근을 취소할 수 없는 상태다. 운영의 해당 토큰 테이블은 확인 시 0건이었다.

폐기·만료 상태에서는 상세 정보를 조회·반환하지 말고 최소한의 상태 안내만 제공해야 한다. 장치 소유권 변경 뒤 기존 handoff 링크가 현재 장치 메타를 읽는 경로도 함께 차단해야 한다.

### 5 P1 데이터 보관 후 해제를 선택해도 오래된 기록이 다음 정리 때 삭제될 수 있다

**운영 소스와 읽기 전용 조건 검증.** [UnpairModal.jsx:48](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-web/src/components/UnpairModal.jsx:48)는 위치·운행·이벤트를 보관하고 같은 계정으로 다시 연결하면 자동 복구한다고 안내한다.

반면 [housekeeping.rs:38](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-api/src/services/housekeeping.rs:38)은 현재 소유자가 다른 행 중 **기록 자체가 30일보다 오래된 것**을 삭제한다. 해제 후 30일이 지났는지 확인하지 않는다. 예를 들어 오늘 해제한 장치의 40일 전 기록은 다음 정리 때 바로 삭제 대상이다. daily_stats도 같은 구조다.

보관 선택과 정리 정책을 일치시켜야 한다. 유예 기간을 두려면 연결 해제 시각을 저장하고 그 시각을 기준으로 계산해야 한다. 사용자에게 보관을 약속한 데이터를 기록 나이만으로 지우면 안 된다.

### 6 P1 소유권을 잃은 실시간 연결에 새 위치가 잠시 전달될 수 있다

**운영 소스 확인.** [ws.rs:127](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-api/src/routes/ws.rs:127)는 구독 소유권을 30초마다 재확인한다. 그 사이 [ws.rs:166](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-api/src/routes/ws.rs:166)은 장치 ID가 기존 구독 집합에 있으면 이벤트를 전송한다. A가 연결 해제하고 B가 등록한 직후 A의 기존 소켓에 B의 새 좌표가 전달될 수 있다. 재확인 DB 오류 시에는 구독을 유지하므로 노출 시간이 더 길어질 수 있다.

또한 [ws.rs:59](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-api/src/routes/ws.rs:59)는 최초 JWT 검증 후 만료 시각을 연결 루프에 넘기지 않는다. 열린 연결은 토큰 만료만으로 끝나지 않는다.

소유권 변경 시 구독을 즉시 무효화하거나, 이벤트에 소유권 세대를 포함해 전송 시 검증해야 한다. JWT 만료·계정 세션 종료 처리도 실시간 연결에 적용해야 한다.

## 알림과 서버 처리 문제

### 7 P2 단말기 알림을 눌러도 이전에 선택한 다른 단말기가 열린다

**브라우저 재현.** 앱은 [app_config.dart:24](E:/project/2025/esp32c3-mini_gps/flutter_app/lib/app_config.dart:24)에서 알림의 device_id를 /?device=ID로 전달한다. 홈 [Dashboard.jsx:547](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-web/src/pages/Dashboard.jsx:547)은 그 쿼리를 읽지 않고 저장된 filter_device_id를 복원한다.

저장된 선택 A=101, 알림 URL device=102 조건에서 화면은 **테스트 차량 A**를 표시했다. 페이지 예외 없이 발생했다. [재현 결과](C:/Users/msb/AppData/Local/GPS-Builds/gps-critical-review-20261020/deep-dialog-results.json)

명시적인 알림 대상이 저장된 선택보다 우선해야 한다. 로그인·갱신 뒤에도 대상을 유지하고, 이미 해제된 장치라면 찾을 수 없다는 안내를 보여야 한다.

### 8 P2 일반 계정의 법인 렌트카 관리자 직접 주소가 빈 화면이 된다

**390px 브라우저 재현.** 개인 계정에서 /corporate, /rentcar, /delivery, /admin에 진입하면 본문이 없고 하단 메뉴만 보였다.

[Dashboard.jsx:1020](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-web/src/pages/Dashboard.jsx:1020) 이후 본문은 계정 유형에 맞을 때만 렌더한다. 그러나 [Dashboard.jsx:1199](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-web/src/pages/Dashboard.jsx:1199)의 모바일 패널 분기는 해당 경로를 일괄 제외한다. admin의 권한 안내도 panel 안에만 정의되어 실제 모바일 경로에서는 표시되지 않았다.

권한 없음, 계정 유형 전환, 홈 복귀 중 가능한 행동을 제시해야 한다. 계정 유형을 바꾼 직후 이전 특화 화면이 열린 경우도 같은 규칙으로 처리해야 한다. API 권한 우회를 재현한 사항은 아니다.

### 9 P2 모바일 Fleet 화면의 고정 3열이 본문을 밀어낸다

**브라우저 재현.** [FleetDashboard.jsx:234](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-web/src/pages/FleetDashboard.jsx:234)의 최소 열 너비가 280px+300px이다. 390px 화면에서 문서 너비가 **580px**이 되어 본문이 넘쳤다. 가운데 지도 폭도 사실상 사라진다.

이 화면은 숨겨진 실험 코드만이 아니라 명령 팔레트와 차량 선택에서 진입할 수 있다. 모바일은 목록·지도·상세 전환으로 구성하거나 현재 홈으로 통합해야 한다. 별도 Beta 헤더와 기본 내비게이션 부재도 함께 정리할 필요가 있다.

### 10 P2 Fleet은 오래전 wake만으로 단말기를 운행 중으로 표시한다

**브라우저 재현과 소스 확인.** [SummaryChips.jsx:12](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-web/src/components/fleet/SummaryChips.jsx:12)는 마지막 이벤트가 wake면 수신 시각을 검사하기 전에 active를 반환한다.

10월 1일 이후 수신이 없는 같은 가상 단말기를 Fleet은 **운행**, 새 법인·렌트카 화면은 **오프라인**으로 표시했다. wake는 부팅·타이머 깨움일 수도 있으므로 최신 데이터에서도 실제 주행 증명이 아니다.

통신·절전·이동 상태의 공통 판정 함수를 사용하고, 단순 wake 이벤트를 운행 여부로 번역하지 않아야 한다.

### 11 P2 공유 링크 포인트 차감과 링크 생성 연장이 한 거래로 묶이지 않는다

**운영 소스 확인.** [share.rs:93](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-api/src/routes/share.rs:93)은 credits::charge로 별도 트랜잭션의 차감을 확정한 뒤 링크를 INSERT한다. 후속 실패 시 환불이 없다. [share.rs:160](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-api/src/routes/share.rs:160)의 연장은 현재 만료일을 먼저 읽고 나중에 절대 시각으로 UPDATE하므로, 동시 연장 두 건이 모두 과금되면서 기간은 한 번만 늘어날 수 있다.

차감·링크 변경을 동일 트랜잭션에 넣고 해당 토큰을 잠가야 한다. 이미 있는 charge_tx 도구를 재사용하고 중복 요청도 식별해야 한다.

### 12 P2 reset과 beep가 함께 대기하면 beep가 전달되지 않고 사라진다

**운영 소스 확인.** [ingest.rs:879](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-api/src/routes/ingest.rs:879)는 beep_pending을 먼저 false로 바꾸고, [ingest.rs:893](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-api/src/routes/ingest.rs:893)에서 reset도 소비한다. 응답은 [ingest.rs:925](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-api/src/routes/ingest.rs:925)에서 reset 하나만 실으므로 두 값이 모두 true면 beep가 유실된다.

응답 전 대기 플래그를 지우기 때문에 응답 전송 실패 때도 장치가 받지 못한 명령이 처리된 것으로 사라진다. 주기 변경은 SELECT와 UPDATE가 분리되어 중복 소비·덮어쓰기 위험도 있다.

명령 ID와 전달·확인 상태를 두고 장치 ACK 뒤 완료해야 한다. reset 우선이면 beep는 대기 상태로 보존해야 한다.

### 13 P2 통계 재집계 한 건의 실패가 다른 작업까지 막을 수 있다

**운영 소스 확인, 현재 장애는 관측하지 않음.** [stats.rs:42](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-api/src/services/stats.rs:42)는 오래된 날짜 순으로 100건을 읽고, [stats.rs:47](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-api/src/services/stats.rs:47)의 한 작업 실패에 전체 실행을 반환한다. 같은 실패 항목이 계속 앞에 남으면 다른 대기 작업과 오늘·어제 집계까지 매 5분마다 막힐 수 있다.

개별 실패를 격리하고 시도 횟수·다음 실행 시각·마지막 오류를 남겨야 한다. 현재 확인 시 대기열은 0건이므로 “통계가 지금 멈춰 있다”는 결론은 아니다.

### 14 P2 새 차량 번호와 예전 차량 번호가 화면과 보고서에서 갈린다

**운영 소스 확인.** [VehicleCarePanel.jsx:10](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-web/src/components/VehicleCarePanel.jsx:10)의 차량 번호 입력은 car_plate에 저장하고 [business.js:8](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-web/src/lib/business.js:8)의 차량명도 그 값을 우선한다. 하지만 [corporate.rs:1232](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-api/src/routes/corporate.rs:1232)의 법인 보고서 데이터와 렌트카 계약·handoff 조회는 license_plate를 사용한다.

새 입력란에서 번호를 바꿔도 계약·서버 보고서에는 옛 값이나 빈 값이 남을 수 있다. 두 값이 모두 있으면 화면별 우선순위도 다르다. 확인 시 운영 DB에는 새 car_plate 값이 없었으므로 현재 사용자 오류 사례를 집계한 것은 아니다.

차량 번호 저장 원본을 통합하고, 이행 기간 동안 API의 읽기·쓰기·검색·CSV/XLSX/PDF·알림을 같은 규칙으로 맞춰야 한다.

## 화면과 앱 사용성 문제

### 15 P2 홈 지도 SDK 실패 시 원인 안내와 재시도 동작이 없다

**SDK 요청 실패를 주입해 재현.** [KakaoMap.jsx:587](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-web/src/components/KakaoMap.jsx:587)은 SDK 실패를 콘솔에만 기록한다. 홈에서는 빈 지도 영역과 조작 버튼이 남고 사용자용 오류·재시도 UI가 없다. 새 BusinessMap에는 오류 안내와 재시도가 구현되어 있어 화면 간 대응도 다르다.

스크립트 차단·일시적인 네트워크 장애·키 설정 오류를 사용자에게 구분 가능한 문구로 보여주고, 재시도를 제공해야 한다. 실제 운영 Kakao 장애가 발생했다는 뜻은 아니다.

### 16 P2 표준 모달에서 키보드 포커스가 배경 화면으로 빠진다

**차량 예약 모달에서 재현.** [Modal.jsx:38](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-web/src/components/ui/Modal.jsx:38)은 Esc와 스크롤 잠금만 제공하고, 포커스 이동·가두기·복원이 없다. role=dialog, aria-modal만 지정되어 있다.

새 예약을 연 뒤 Tab을 누르자 모달 바깥의 지도·더보기·배경 버튼으로 이동했고, 다시 한참 순회한 뒤 닫기와 입력란에 도달했다. 키보드·보조기술 사용자에게 배경과 현재 입력 작업의 경계가 무너진다.

열 때 적절한 입력에 초점을 주고 내부 순환·배경 inert·닫은 뒤 호출 버튼 복원을 공통 모달에 구현해야 한다.

### 17 P2 Android 앱의 파일 다운로드 처리가 빠져 있다

**앱과 설치된 플러그인 소스 확인, 실기기 재현 필요.** [ProfilePanel.jsx:191](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-web/src/components/ProfilePanel.jsx:191)의 ZIP/APK 링크는 새 창으로 열린다. [main.dart:588](E:/project/2025/esp32c3-mini_gps/flutter_app/lib/main.dart:588)는 모든 새 창을 제목 **결제**의 WebView로 열고, 메인·팝업 WebView 모두 다운로드 콜백이 없다.

설치된 flutter_inappwebview_android 1.0.13은 useOnDownloadStart가 켜져야 DownloadListener를 등록하며 그 리스너도 다운로드 요청을 Dart에 통지하는 구조다. 앱에는 저장 처리나 외부 다운로드 위임이 없다. [downloadReport.js:5](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-web/src/lib/downloadReport.js:5)의 CSV/PDF도 blob URL과 download 속성에만 의존한다.

일반 브라우저에서 다운로드된다는 사실만으로 앱 내 동작을 보장할 수 없다. ZIP/APK는 외부 브라우저 또는 네이티브 다운로드로, blob CSV/PDF는 네이티브 저장·공유로 연결한 뒤 실제 Android에서 확인해야 한다. 파일 열기 화면 제목도 용도에 맞춰야 한다.

### 18 P3 알 수 없는 주소를 정상 홈처럼 처리한다

**브라우저 재현.** /nonexistent-review-route에 들어가도 홈 조작 UI가 나타나고 URL은 그대로 남았다. [Dashboard.jsx:77](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-web/src/pages/Dashboard.jsx:77)의 startsWith 판정과 [App.jsx:197](C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps/gps-tracker-web/src/App.jsx:197) 부근의 catch-all 보호 경로가 명시적 404를 제공하지 않는다.

잘못된 내부 링크가 정상 이동처럼 보여 탐지하기 어렵다. 유효 경로를 명시하고 잘못된 주소에는 안내와 홈 이동을 제공해야 한다. 예전 경로는 필요한 것만 명시적으로 리다이렉트한다. 보호 영역의 catch-all 정의는 App.jsx 197행에 있다.

## 디자인에서 함께 정리할 부분

- **기능 상태 표현부터 통일한다.** Fleet의 운행과 다른 화면의 오프라인은 색·문구 취향 문제가 아니라 의사결정 오류다. 통신 상태, 절전 상태, 실제 이동 상태를 구분한다.
- **현재 화면의 복구 행동을 보이게 한다.** 빈 권한 화면, 실패한 홈 지도, 잘못된 주소가 같은 공백처럼 보이면 사용자는 로그아웃·재설치를 시도하게 된다. 사유와 바로 할 수 있는 행동을 본문에 둔다.
- **Fleet의 진입점과 역할을 정리한다.** 기본 홈·법인차·렌트카와 별도 레이아웃·상태 체계를 유지하면 수정이 계속 갈라진다. 통합하거나 실제로 구분되는 역할을 부여한다.
- **네이티브 기능의 발견성을 높인다.** 진행 방향 추적이 도구 아래에 있어 존재를 알기 어렵다는 이전 사용자 반응이 있었다. 회전 가능 지도와 기본 지도의 차이, 현재 추적 상태를 진입점에서 설명하는 편이 낫다.
- **배달 운영은 준비 상태를 진입 전에 명확히 한다.** 계정 유형 선택에는 준비 중 설명이 있지만, 완성된 운영 유형과 같은 비중으로 제공한다. 준비 기능을 테스트 목적으로 노출하는지 제품 정책을 정할 필요가 있다.

## 수정 순서와 통과 기준

| 순서 | 묶음 | 완료 기준 |
| --- | --- | --- |
| 1 | 소유권과 개인정보 1·2·3·4·6 | 임의 장치 위조·선점 차단, 이전 계정 정보 노출 차단, 폐기 링크 상세 반환 차단, 권한 상실 즉시 실시간 전송 중단 |
| 2 | 기록 보존과 처리 보장 5·11·12·13 | 보관 약속 검증, 차감·처리 원자성, 명령 ACK와 재전송, 실패 작업 격리 |
| 3 | 알림과 도메인 데이터 7·10·14 | 알림 대상 정확한 선택, 상태 판정 공통화, 번호 입력부터 보고서까지 일치 |
| 4 | 라우팅과 화면 8·9·15·16·18 | 잘못된 진입 안내, 모바일 넘침 없음, 지도 실패 복구, 모달 키보드 조작 |
| 5 | 앱 다운로드와 사용성 17 | Android 앱 안에서 ZIP/APK 및 CSV/PDF 저장·공유 성공, 용도에 맞는 화면 제목 |

현재 통과한 97개 테스트 외에, 소유권 이전·정보 보존·동시 처리·네트워크 단절·실제 WebView 다운로드를 묶은 회귀 검증이 필요하다. 9월에 지적됐던 계정 전환 캐시/토큰 경쟁과 배치 점 전개 문제는 현재 세션 격리·공통 점 조회·재집계 큐 코드가 반영되어 있어 과거 결함을 그대로 재기재하지 않았다. 실기기·부하·장애 주입을 모두 완료한 전수 검증은 아니다.

## 재현 자료

- [브라우저 라우팅과 화면 결과](C:/Users/msb/AppData/Local/GPS-Builds/gps-critical-review-20261020/browser-results.json)
- [알림 대상과 모달 포커스 결과](C:/Users/msb/AppData/Local/GPS-Builds/gps-critical-review-20261020/deep-dialog-results.json)
- [모바일 Fleet 넘침 화면](C:/Users/msb/AppData/Local/GPS-Builds/gps-critical-review-20261020/_fleet-390-personal.png)
- [권한 없는 법인 경로의 빈 화면](C:/Users/msb/AppData/Local/GPS-Builds/gps-critical-review-20261020/_corporate-390-personal.png)
- [알림 URL과 실제 선택이 다른 화면](C:/Users/msb/AppData/Local/GPS-Builds/gps-critical-review-20261020/device-deep-link.png)
- [기존 웹 테스트 결과](C:/Users/msb/AppData/Local/GPS-Builds/gps-critical-review-20261020/web-tests.log)

운영 변경 없이 검토를 마쳤다. 수정·배포는 이 문서에 포함하지 않았다.

