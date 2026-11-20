# Android / Flutter / FCM 검토 — 2026-09-27

## 결론과 검토 범위

Android 앱은 Flutter WebView 셸이다. 지도·장치·시커 등 주요 화면은 `https://gps.serial.kr/`의 웹 UI이고, Flutter가 WebView, FCM, 알림 권한, 위치, 화면 켜짐 유지, 외부 결제 앱 연결을 담당한다. FCM은 실제 서버 발송까지 구현되어 있지만 로그인/로그아웃 경계, 재시도, 알림 탭 동작과 발송 상태 관리에 수정이 필요하다.

- 앱 저장소: `E:\project\2025\esp32c3-mini_gps\flutter_app`, `yeyebee/gps-tracker-app`, `main`, HEAD `70b40ba`.
- 서버/웹 검토 기준: `codex/gps-dev-hardening`, `c0f3e60`. `services/fcm.rs`는 이 시점의 로컬 main과 동일하다. 배포 APK의 소스 일치 여부는 확인하지 않았다.
- 앱은 부모 저장소에서 ignored인 **별도 Git 저장소**다. 검토 시작 전부터 `lib/fcm.dart`, `lib/main.dart`, `pubspec.yaml`, `pubspec.lock`에 미커밋 변경이 있었고 그대로 보존했다. 특히 `GetPhoneLocation` 브리지와 JWT hash 캐시는 그 변경에 포함된다.
- 로컬 SDK: Flutter 3.22.3 / Dart 3.4.4. 앱 버전: `1.0.0+6`, Android applicationId: `com.etcompany.gpstracker`, minSdk 23 / targetSdk 35.
- 실제 해석된 주요 패키지: flutter_inappwebview 6.0.0, firebase_core 3.15.2, firebase_messaging 15.2.10, flutter_local_notifications 17.2.4, geolocator 12.0.0.
- 이번 작업은 코드 검토, 로컬 분석/테스트, 서버 설정·로그의 읽기 전용 확인이다. 앱/서버 구현 수정, 푸시 전송, APK 설치, 배포는 하지 않았다.

## 우선순위별 발견 사항

### P1 — 로그아웃해도 이전 계정의 푸시 등록이 남음

근거: 앱 `lib/main.dart:164`의 폴링은 JWT가 없어지면 그냥 반환한다. 웹 `gps-tracker-web/src/api.js:43`의 `clearTokens()`도 브라우저 인증만 제거한다. 서버에는 `gps-tracker-api/src/routes/auth.rs:382`의 `/auth/fcm-token/revoke`가 있지만 앱/웹에서 호출하지 않는다.

FCM 토큰은 기기 설치 단위이므로 로그아웃만으로 서버의 `fcm_tokens.active`가 바뀌지 않는다. 이전 계정의 장치 이벤트와 상담 알림이 로그아웃한 휴대폰에 계속 표시될 수 있다. 이후 다른 계정으로의 재등록이 실패하면 이 상태가 더 길어진다. 서버의 토큰 upsert가 계정을 변경하는 것만으로 로그아웃 구간이 해결되지는 않는다.

수정 방향: 웹 인증 상태 변경과 앱 등록 상태를 명시적으로 연결하고, 인증 삭제 전에 해당 설치의 등록을 해제한다. 오프라인 로그아웃·세션 만료·계정 전환도 함께 설계해야 한다. 필요하면 서버에서 설치/세션 단위 소유권과 유효기간을 관리한다. 재로그인 등록과 해제 요청이 서로 덮어쓰지 않도록 순서를 보장한다.

### P1 — 서버의 일시적 전송 실패가 영구 누락으로 처리됨

근거: `gps-tracker-api/src/services/fcm.rs:279`는 최대 50개 이벤트에 `notified_at=now()`를 먼저 기록한다. 이후 `:390`에서 FCM에 전송하고 `:401`의 오류 처리는 경고 로그뿐이다. 토큰 조회 실패도 `:372`에서 빈 목록으로 바뀐다.

429/500/503, 네트워크 timeout, DB 조회 실패 또는 발송 중 프로세스 종료가 발생하면 해당 이벤트가 다시 선택되지 않는다. 코드 주석의 '크래시 직전 1건 누락'과 달리 한 배치 전체가 미리 마킹되어 최대 50개 이벤트가 영향을 받을 수 있다. OAuth 토큰 획득 실패 시 claim하지 않는 방어는 이미 있지만, 실제 메시지 전송 실패까지 보호하지 못한다.

수정 방향: 이벤트와 수신 토큰별 발송 상태, 제한 시간 있는 작업 선점, 재시도 횟수/시각, 최종 결과를 둔다. FCM 수락 후 완료 처리하고, 429/5xx에는 Retry-After와 지수 백오프를 적용한다. 부분 성공한 토큰에 재발송하지 않도록 관리하며 네트워크 응답 유실에 따른 중복 가능성도 다룬다. 단순히 `notified_at`만 되돌리면 이미 받은 기기에 중복 전송될 수 있다. [Firebase 전송 오류 처리 문서](https://firebase.google.com/docs/cloud-messaging/error-codes)

추가로 `:202`의 서비스 계정 파일 로드 실패는 `None`으로 바뀌어 dry-run으로 진행하고, 같은 이벤트를 발송 없이 처리 완료한다. 운영에서 잘못된 인증 파일을 명시한 경우는 시작 실패/워커 정지와 상태 경보로 처리해야 한다. 의도적인 dev dry-run은 별도로 유지한다.

### P1 — 위치 JS 브리지에 호출 출처 검증 없음

근거: 앱 `lib/main.dart:331`의 `GetPhoneLocation`은 OS 위치 권한만 확인한다. 같은 WebView의 `:418`은 모든 HTTP/HTTPS 탐색을 허용한다. 반면 일반 웹 geolocation은 `:271`에서 gps.serial.kr origin만 허용한다. 이 제한은 별도의 네이티브 JS 브리지에 적용되지 않는다.

현재 미커밋 코드로 앱을 빌드하면 메인 WebView가 외부 페이지로 이동한 상태에서도 그 페이지가 브리지를 호출할 수 있다. OS 위치 권한이 이미 허용됐다면 기기 위치를 얻을 수 있는 경로다. 설치된 flutter_inappwebview_android 1.0.13의 `InAppWebView.prepare()`는 `addJavascriptInterface`를 설치하며 `JavaScriptBridgeInterface._callHandler()`에도 origin 검증이 없다. 실제 배포 APK에 이 미커밋 변경이 들어갔는지는 미확인이다.

수정 방향: 신뢰하는 서비스 화면과 외부 페이지의 WebView를 분리하고, 위치 등 민감한 브리지는 신뢰 origin 및 main frame만 호출하도록 한다. 최상위 URL만 검사하는 것으로 iframe까지 보호된다고 간주해서는 안 된다. 현재 6.0.0에 없는 신형 handler 보안 옵션을 그대로 추가할 수는 없으므로, 기존 버전의 origin 제한 가능한 메시지 API 사용 또는 SDK/플러그인 호환성 검토가 필요하다. [InAppWebView JS 통신 보안 문서](https://inappwebview.dev/docs/webview/javascript/communication/)

### P2 — '로그인 기억하기'를 끄면 FCM 계정 등록 누락

근거: 앱 `lib/main.dart:180`은 `localStorage.access_token`만 읽는다. 웹 `gps-tracker-web/src/api.js:29`는 remember=false일 때 `sessionStorage`에 JWT를 저장한다.

새 설치에서 기억하기를 끄고 로그인하면 앱이 인증 토큰을 찾지 못해 FCM 등록 요청을 하지 않는다. 기존 등록이 있으면 우연히 알림이 도달할 수 있지만 현재 로그인 계정과의 일치를 보장하지 않는다.

수정 방향: 신뢰 origin에서 local/session 저장소를 모두 지원하고, 장기적으로 2초 폴링 대신 인증 이벤트와 초기 동기화를 결합한다.

### P2 — 등록 성공 전에 JWT를 처리 완료로 기록하고 재시도하지 않음

근거: 앱 `lib/main.dart:170`은 FCM 토큰 조회/POST 전에 `_lastSeenJwt`를 바꾼다. `:175`는 등록 함수의 false 반환을 무시한다. `lib/fcm.dart:121`의 POST에는 timeout, 예외 처리, 재시도가 없고 `:181`의 토큰 갱신 리스너 내부 비동기 오류도 회복되지 않는다.

초기 토큰 조회 실패, 일시적인 망 장애 또는 HTTP 오류 후 같은 JWT 상태에서는 다시 시도하지 않는다. JWT가 회전하거나 앱이 재시작될 때까지 등록 누락이 지속될 수 있다. Timer의 async 작업을 직렬화하지 않아 빠른 계정 전환 시 과거 계정의 늦은 POST가 새 등록을 덮어쓸 여지도 있다. 서버는 token unique upsert의 마지막 요청을 소유자로 반영한다.

수정 방향: 서버 등록 성공 후에만 동기화 완료로 기록한다. timeout, 백오프, 네트워크 복구/앱 resume 시 재시도, 인증 세대 확인 및 요청 직렬화를 추가한다. 저장소 캐시를 현재 서버 상태의 영구 보증으로 사용하지 않는다.

### P2 — 알림을 눌렀을 때 목적 화면 이동이 불완전

- 포그라운드: `lib/fcm.dart:35`의 로컬 알림 초기화에 `onDidReceiveNotificationResponse`가 없다. 알림 payload를 넣어도 탭했을 때 이를 읽고 이동하는 코드가 없다. 로컬 알림으로 앱이 시작되는 경우의 launch details도 읽지 않는다.
- 종료 상태: `lib/main.dart:129`의 비동기 `_bootInitialUri()`는 필드만 갱신한다. 첫 WebView 생성보다 결과가 늦으면 기본 URL로 열린 뒤 목적지로 이동하지 않는다. 주석과 달리 `onWebViewCreated`에서 보류된 URI를 반영하지 않는다.
- 실행 중이지만 컨트롤러가 없는 시점: `:145`는 null controller이면 목적지를 보관하지 않고 잃는다.
- 상담 알림: 서버 `routes/chat.rs:231`, `:384`는 `kind`와 `thread_id`를 보내지만 앱 `:150`은 `device_id`만 처리해서 홈으로 보낸다. 로컬 알림 payload도 device_id만 보존한다.
- 장치 링크 `?device=N` 자체는 웹의 `src/lib/deviceLoader.js:240`에서 처리한다. 웹에서 쿼리를 전혀 지원하지 않는 문제는 아니다.

수정 방향: 알림 payload 형식을 통일하고 원격/로컬 탭, cold start, 로그인 완료, WebView 준비 상태를 하나의 보류 목적지 처리로 연결한다. [로컬 알림 플러그인의 탭/앱 시작 처리 문서](https://pub.dev/packages/flutter_local_notifications/versions/17.2.3)

### P2 — 알림 채널과 OS 권한 상태가 화면에 제대로 연결되지 않음

근거: 앱 `lib/fcm.dart:31`은 `baljachwi_default` HIGH 채널을 만들지만 Android manifest에는 FCM의 `default_notification_channel_id`가 없고 서버 payload `services/fcm.rs:385`에도 `android.notification.channel_id`가 없다. 포그라운드 로컬 알림과 백그라운드 시스템 알림이 다른 채널 설정을 사용할 수 있다. `android.priority=HIGH`는 전달 우선순위로, 표시 채널의 중요도와 동일하지 않다.

`lib/fcm.dart:76`은 권한 요청 결과를 사용하지 않는다. 권한을 거절해도 앱에서 알림이 차단됐음을 설명하거나 설정 화면으로 안내하는 흐름이 없다. `_firebaseReady`도 전체 초기화 완료 전에 true로 바뀐다.

수정 방향: manifest/server/local notification의 채널 ID를 맞추고 알림 전용 아이콘을 점검한다. OS 권한과 서버 이벤트별 수신 설정을 구분해 보여주고, 앱 복귀 시 권한 상태를 갱신한다. [Firebase Android 채널/권한 문서](https://firebase.google.com/docs/cloud-messaging/android/get-started)

### P2 — 결제/인증 팝업의 windowId 전달 누락

근거: 앱 `lib/main.dart:463`은 onCreateWindow에서 `isPopup=true`인 화면을 생성하지만 `createReq.windowId`를 전달하지 않는다. `lib/in_app_webview.dart:98`은 popup이면 initialUrlRequest를 null로 만들면서 InAppWebView의 windowId도 설정하지 않는다. 해당 화면의 중첩 popup 처리도 동일하다.

부모가 만든 popup과 새 WebView가 연결되지 않아 빈 화면이 뜨거나 window.opener 기반 인증 흐름이 깨질 수 있다. 요청 URL이 없는 popup도 즉시 거부한다. 캐시된 플러그인의 `FlutterWebView.java:101`에서 실제 연결이 windowId를 통해 이루어짐을 확인했다.

수정 방향: popup 생성 정보와 windowId를 전달하고 닫기/결과 반환을 유지한다. 단순 URL 재탐색으로 대체하면 opener 연결이 필요한 결제 흐름을 보장할 수 없다.

### P2 — 앱의 dev 환경 분기와 회귀 테스트가 없음

앱 시작 주소 `lib/main.dart:14`, API 주소 `lib/fcm.dart:20`, 링크/위치 허용 도메인 및 Android App Links가 운영 도메인에 고정되어 있다. 현재 브라우저에서 dev-gps를 검증한 결과가 Android 앱이나 FCM 검증을 의미하지 않는다.

수정 방향: dev 앱을 별도 applicationId로 설치 가능하게 하고 웹/API/origin/링크 구성을 한 환경 설정에서 가져온다. dev에서 실발송이 필요하면 전용 Firebase 설정과 테스트 설치 토큰만 허용하는 방식을 먼저 설계한다. 운영 FCM 자격 증명을 dev에 연결하는 방식은 기존 격리 원칙과 맞지 않는다. 물리적 VPS 분리는 이 작업의 전제 조건이 아니다.

`test/widget_test.dart:16`은 실제 앱에 없는 `MyApp`을 호출하는 기본 카운터 예제다. 등록 실패/재시도, 로그아웃, 토큰 회전, cold start 및 알림 탭에 대한 자동화 테스트도 없다.

### P3 — 상태 관리·릴리스 설정 후속 정리

- 모듈 전역 FCM 플러그인/구독/ready 상태와 화면 Timer가 나뉘어 있어 초기화 실패 복구와 dispose가 어렵다. 구독 수명과 등록 상태를 한 서비스에서 관리하면 테스트와 복구 경로가 명확해진다.
- Flutter 셸 색상은 고정된 어두운 배경/분홍 seed로 웹의 최근 라이트·다크/primary 토큰과 분리되어 있다. 셸의 로딩·오류·상태바·외부 화면 테마를 함께 정리할 필요가 있다.
- `android/app/build.gradle:77`은 release 서명 설정이 없으면 debug 서명을 사용한다. 운영 release 작업에서는 서명 누락을 실패로 처리해야 잘못 서명된 산출물을 구분할 수 있다. 실제 현재 키 값은 열람하지 않았다.

## 이미 갖춰진 부분

- Firebase 초기화, Android 13+ 알림 권한 요청, foreground 수신 및 로컬 표시, background/terminated 원격 알림 탭 API, FCM 토큰 갱신 리스너가 존재한다.
- 서버는 FCM HTTP v1 + OAuth2 서비스 계정 인증을 사용하고 HTTP timeout과 OAuth 토큰 캐시가 있다.
- 토큰 등록 API는 인증된 user_id에 귀속시키며 token unique upsert로 계정 전환을 지원한다. 별도의 revoke API도 존재한다.
- 이벤트 발생 시점 user_id와 사용자 알림 설정을 기준으로 대상자를 선택한다. UNREGISTERED 토큰 비활성화 처리가 있다.
- OAuth 획득에 실패하면 이벤트를 claim하지 않고 백오프한다. 다만 실제 전송 오류의 재시도는 별도 보완이 필요하다.
- 서버가 notification+data를 보내므로 custom background handler가 없다는 사실만으로 '백그라운드 알림이 모두 안 된다'고 판단하지 않았다. data-only의 별도 백그라운드 처리는 현재 구현되어 있지 않다.

## 실제 확인 결과와 한계

| 확인 | 결과 |
| --- | --- |
| `flutter analyze --no-pub` | 실패: 테스트 파일의 존재하지 않는 `MyApp` 1 error, 관련 unused import 1 warning. lib 파일에 별도 진단은 보고되지 않음 |
| `flutter test --no-pub` | 실패: 동일한 `MyApp` 오류로 테스트 로드/컴파일 단계에서 종료 |
| 분석/테스트 후 앱 Git 상태 | 기존 변경 4개 유지, 추가 추적 파일 변경 없음 |
| prod API 서비스 | active/running, FCM 경로 설정 및 해당 파일 존재 확인 |
| prod 최근 72시간 로그 | `fcm: sent` 24건, `fcm: send error` 및 OAuth 획득/계정 파일 로드 오류 문자열 0건 |
| dev API 서비스 | active/running, APP_ENV=development, FCM 경로 미설정, 최근 로그에 dry-run 확인 |

서버 로그 집계는 보존된 최근 72시간과 해당 문자열에 한정된다. 24건은 FCM HTTP 요청의 수락 로그이며 24대의 기기/24개 고유 이벤트나 휴대폰 실제 표시·열람을 의미하지 않는다. raw 로그, 토큰, 서비스 계정 내용은 출력하지 않았다. 실물 Android에서 설치·권한 허용/거절·강제 종료·오프라인 복귀·로그아웃/다중 계정·탭 이동은 아직 검증하지 않았다.

## 권장 진행 순서

1. 앱 별도 저장소의 기존 변경을 보존한 작업 브랜치에서 dev 환경 설정과 최소 동작 테스트를 만든다.
2. 위치 브리지 origin 경계와 FCM 로그인/로그아웃·등록 재시도·계정 전환의 상태 관리를 수정한다.
3. 알림 payload/탭 이동/채널/권한 UX와 popup windowId 연결을 정리한다.
4. dev API에서 수신자별 발송 상태·재시도를 구현하고 fake FCM endpoint로 실패·부분 성공·재시작을 검증한다.
5. 전용 테스트 앱/토큰으로 실물 Android 수신 및 탭을 검증한다. 서버의 운영 배포는 사용자 명시적 허가 후 진행한다.

KC 진단/스캔 경로를 변경할 필요는 없다. 서버 빌드는 기존 etcom-hub 경로를 유지하고, Android 실제 빌드 전에 runner의 Flutter/Android SDK 및 서명 환경을 별도로 확인한다.
