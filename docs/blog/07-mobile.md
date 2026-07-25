# 7. 모바일 — Flutter WebView + FCM

> 짧게. 개발자 리소스가 부족해서 native UI 는 최소. 웹 SPA 를 그대로 WebView 에서 돌리고 native 는 FCM (push) 만.

## Why Flutter (not native)?

옵션 검토:

| 방식 | 장점 | 단점 |
|---|---|---|
| **Native (Kotlin + Swift)** | 최고 UX | 두 코드베이스, 인력 부담 |
| **React Native** | JS 공유 | React 네이티브 모듈 학습 필요 |
| **Flutter** | 단일 코드, hot reload | Dart 학습, 하지만 stack 이 단순 |
| **WebView shell + native FCM** | 웹 SPA 재사용, native 최소 | 100% native UX 아님 |

이 프로젝트 특성:
- 개발자 1명 (내가)
- 웹 UI 는 이미 mobile-first 로 잘 만들어놨음 (Kakao maps 도 mobile touch 최적)
- **필요한 native 기능은 FCM 딱 하나** (geofence 진입/이탈 알림)

→ **WebView shell + native FCM** 선택. Flutter 는 shell 컨테이너.

## 구조

```
Flutter 앱 (최소 shell)
├── main.dart               # 앱 부팅 + FCM 초기화
├── webview_page.dart       # WebView 로 https://gps.serial.kr 로드
├── fcm.dart                # FCM device token 발급 + 서버 등록
└── push_handler.dart       # 알림 도착 → deep link 로 WebView 특정 route 열기
```

전체 코드 300줄 미만. 대부분 웹 SPA 에 위임.

## Flow

### 1. 앱 부팅

```dart
void main() async {
  await Firebase.initializeApp();
  await FirebaseMessaging.instance.requestPermission();
  runApp(MyApp());
}
```

### 2. FCM token 등록

앱 첫 로그인 후:

```dart
final token = await FirebaseMessaging.instance.getToken();
await api.registerFcmToken(token, platform: 'android');   // 서버에 저장
```

서버 `fcm_tokens` 테이블에 `{user_id, token, platform, active}` 저장. 알림 발송 시 이 토큰들로 push.

### 3. Push 도착

Geofence 진입/이탈 이벤트 시 서버 (Rust worker `fcm`) 가 발송:

```rust
// gps-tracker-api/src/services/fcm.rs
fcm_client.send(Message {
  token: user_fcm_token,
  notification: Some(Notification {
    title: "펜스 진입",
    body: "집 근처에 도착했어요",
  }),
  data: Some(hashmap!{ "deep_link" => "/devices?filter=3005" }),
  ...
})
```

앱은 알림 tap 시 `deep_link` 를 WebView 로 열기:

```dart
FirebaseMessaging.onMessageOpenedApp.listen((message) {
  final link = message.data['deep_link'];
  webViewController.loadUrl('https://gps.serial.kr$link');
});
```

## fcm.dart short-circuit 사고

초기 구현:

```dart
final cache = await SharedPreferences.getInstance();
if (cache.getString('fcm_token_registered') != null) return;   // 이미 등록됨 - skip
await api.registerFcmToken(token, ...);
cache.setString('fcm_token_registered', 'yes');
```

**증상**: 사용자가 로그아웃 후 다른 계정으로 로그인 → FCM 토큰이 이전 계정에 걸린 상태 → 이전 계정에게 알림 감

**Root cause**: `SharedPreferences` cache 가 로그아웃/로그인 넘어도 유지. "이미 등록됨" 판정이 잘못.

**Fix**: JWT hash 를 cache key 에 포함:

```dart
final jwt = await getAccessToken();
final jwtHash = sha256(jwt).substring(0, 16);
if (cache.getString('fcm_token_registered_$jwtHash') != null) return;
await api.registerFcmToken(token, ...);
cache.setString('fcm_token_registered_$jwtHash', 'yes');
```

계정 바뀌면 hash 달라지고 → 재등록.

**교훈**: 인증 관련 캐시 key 는 사용자 identity 를 포함해야. 그 외 (device id, session id 등) 도 마찬가지.

## 알려진 제약

- **Full native 대비 UX 세밀도 낮음**: WebView scroll bounce, gesture, keyboard 관리 등에서 native 만한 느낌 X
- **Offline 시 최소 캐시만**: WebView 자체 캐시 + 서버 API cache-control. PWA 정식 도입 검토 중
- **iOS 앱 심사**: 아직 미제출. Android 만 배포

## 왜 이 repo 에 없는가

Flutter 앱 소스는 **별도 관리** (로컬 개발). 이 repo (`ET-NOTE/gps-tracker`) 에는 서버/웹/펌웨어만.

과거 VPS `/home/mmm/gps-tracker-web/flutter_app/` (2.5 GB) 에 개발본이 있었으나 로컬 개발용이라 VPS 정리 시 삭제 (backup tar 로 안전 보관).

이유:
- Flutter 앱은 iOS/Android build artifact 무거움 (수백 MB gitignore 후에도 큼)
- 웹/서버와 배포 주기 다름 (앱 스토어 심사)
- 웹 API 만 안정되면 앱 소스 별도 반복 가능

## 배운 것

1. **최소 native shell + 웹 재사용은 좋은 절충** — 개발 리소스 부족 시 특히
2. **FCM device token 은 계정 매핑 필수** — cache key 에 user identity
3. **Flutter WebView 는 안정적** — 카카오 지도, WebSocket 다 잘 돔

## 다음

- [8. 실전 사고](08-troubleshooting.md)
- [gps-tracker-api/src/services/fcm.rs](../../gps-tracker-api/src/services/fcm.rs) — 서버 FCM 발송 코드
