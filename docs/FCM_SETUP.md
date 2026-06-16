# FCM_SETUP — Firebase Cloud Messaging 종단간 셋업

이 문서는 사용자 디바이스가 푸시 알림을 받기까지 필요한 모든 단계를 정리합니다.
**서버 (Rust API) + Flutter 앱 + Firebase 콘솔** 3축이 동시에 맞아야 동작합니다.

## 전체 흐름

```
┌────────────┐   1. token      ┌────────────────┐   3. /v1/projects/.../send
│ Flutter    │ ──────────────► │ Rust API       │ ──────────────────────────►  FCM
│ (앱)       │   POST /api/v1  │ (gps-tracker-  │      OAuth2 + RS256 JWT
│            │   /auth/        │  api)          │
│            │   fcm-token     │                │ ◄───────────────────────── 
│            │                 │  service-      │   4. push to device
│            │                 │  account.json  │
└─────┬──────┘                 └────────────────┘
      ▲                                                      
      │ 5. 푸시 메시지 (FCM → device → 시스템 트레이)
      └────────────────────────────────────────────────────────────────────  
```

1. Flutter 앱이 디바이스 토큰을 받음 (`FirebaseMessaging.getToken()`)
2. 토큰을 백엔드에 등록 (`POST /api/v1/auth/fcm-token`)
3. 백엔드는 events 워커가 이벤트 감지 → FCM HTTP v1 호출 (OAuth2 자기 서명 JWT)
4. FCM 이 해당 토큰의 디바이스로 푸시 deliver
5. 앱이 foreground / background / terminated 어디서든 핸들링

코드 위치:
- 서버: [gps-tracker-api/src/services/fcm.rs](../gps-tracker-api/src/services/fcm.rs)
- 앱: [gps-tracker-app/lib/fcm.dart](https://github.com/yeyebee/gps-tracker-app/blob/main/lib/fcm.dart)

---

## 1. Firebase 프로젝트 생성

1. [console.firebase.google.com](https://console.firebase.google.com) 접속
2. **프로젝트 추가** → 이름 입력 (예: `gps-tracker`) → 위치 선택
3. Google Analytics 는 켜도 끄도 무방 (FCM 자체와 무관)

생성되면 `gps-tracker-<해시>` 형태의 프로젝트 ID 가 부여됩니다.

---

## 2. 서버용: 서비스 계정 JSON

서버가 FCM HTTP v1 을 호출하려면 OAuth2 서비스 계정이 필요합니다.

1. Firebase Console → **프로젝트 설정** (⚙️) → **서비스 계정** 탭
2. **새 비공개 키 생성** 버튼 클릭
3. JSON 파일 다운로드 — 예: `gps-tracker-e21be-firebase-adminsdk-fbsvc-<해시>.json`

⚠️ **이 파일은 절대 git 에 commit 하면 안 됩니다.** Firebase 의 전체 권한(메시지 발송 + DB 쓰기 등)을 가진 키입니다. 노출되면 즉시 콘솔에서 revoke.

서버 배치:
```bash
scp gps-tracker-*-firebase-adminsdk-*.json mmm@210.114.18.16:/home/mmm/secrets/
chmod 600 /home/mmm/secrets/gps-tracker-*.json
```

`.env`:
```ini
FCM_SERVICE_ACCOUNT_PATH=/home/mmm/secrets/gps-tracker-e21be-firebase-adminsdk-fbsvc-<해시>.json
```

API 재시작 후 journal 확인:
```bash
sudo journalctl -u gps-tracker-api -n 30 | grep -i fcm
# INFO gps_tracker_api::services::fcm: fcm: live mode project=gps-tracker-e21be
```

`live mode` 가 떠야 활성. `dry-run mode (no FCM client)` 면 path 미설정 또는 JSON 파싱 실패.

### 서버측 동작 요약 (src/services/fcm.rs)

- `make_client(Some(path))` 가 JSON 로드, `dry-run` 시 None 반환
- `spawn(pool, client)` 가 5초마다 `events.notified_at IS NULL` 폴링 (BATCH 50)
- 각 이벤트마다:
  1. `notification_settings` 에서 사용자가 해당 종류 알림 켜뒀는지 체크
  2. `fcm_tokens` 에서 `user_id` 의 활성 토큰들 가져옴
  3. OAuth2 access_token (캐시, 1시간) 으로 FCM v1 호출
  4. UNREGISTERED → `fcm_tokens.active = FALSE` 처리
  5. `events.notified_at = now()` 마킹 (중복 발송 방지)

---

## 3. Android (앱)

### 3-1. Firebase Console 에서 앱 등록

1. 프로젝트 개요 → **앱 추가** → 🤖 Android
2. **Android 패키지 이름**: `com.etcompany.gpstracker` (앱의 `android/app/build.gradle` 의 `applicationId` 와 일치 필수)
3. 닉네임: 자유
4. **SHA-1 인증서 지문**: release keystore 의 SHA-1 등록 — App Links 검증 (`assetlinks.json`) + 일부 카카오/네이버 인증에 필요

```bash
keytool -list -v -keystore ~/keystores/gps-tracker-release.jks -alias gps-tracker
```

### 3-2. google-services.json

콘솔이 `google-services.json` 다운로드 링크를 줍니다. 이걸:

```
gps-tracker-app/android/app/google-services.json
```

에 배치. `.gitignore` 에 등록되어 있어 commit 되지 않습니다. **팀원과는 별도 채널 (1Password 등) 로 공유.**

### 3-3. build.gradle 의존성 확인

[android/app/build.gradle](https://github.com/yeyebee/gps-tracker-app/blob/main/android/app/build.gradle):
```gradle
plugins {
    id "com.google.gms.google-services"   // ← 이게 google-services.json 처리
}
```

루트 [android/build.gradle](https://github.com/yeyebee/gps-tracker-app/blob/main/android/build.gradle) classpath 에 `com.google.gms:google-services:4.4.x` 가 있어야 합니다 (Flutter 가 보통 자동).

### 3-4. AndroidManifest 권한

이미 등록됨:
```xml
<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>  <!-- Android 13+ runtime -->
<uses-permission android:name="android.permission.INTERNET"/>
```

`POST_NOTIFICATIONS` 는 Android 13+ 에서 런타임 권한 요청 필요. `lib/fcm.dart` 의 `requestPermission()` 가 처리.

---

## 4. iOS (앱)

iOS 는 단순히 FCM 만으로 안 되고 **APNs (Apple Push Notification service)** 가 중간에 들어갑니다.

### 4-1. Apple Developer Program

- 유료 $99/year 멤버십 필요
- App ID 발급 (Bundle ID: 예 `com.etcompany.gpstracker`)
- App ID 의 Capabilities 에 **Push Notifications** 체크

### 4-2. APNs 키 발급

옵션 A (권장 — 키 방식, 키 1개로 모든 앱 지원):
1. [developer.apple.com](https://developer.apple.com) → Certificates, IDs & Profiles → **Keys** → +
2. **APNs** 체크 → 키 이름 입력 → Continue
3. `.p8` 파일 다운로드 (1회만 가능, 분실 시 재발급)
4. **Key ID** 와 **Team ID** 메모

옵션 B (인증서 방식 — 레거시): 비추천. Apple 도 키 방식 권장.

### 4-3. Firebase 에 APNs 키 업로드

Firebase Console → 프로젝트 설정 → **Cloud Messaging** → Apple 앱 카드 →
- **APNs 인증 키** 섹션에서 `.p8` 업로드
- Key ID, Team ID 입력

이렇게 해야 Firebase 서버가 자신의 ID 로 APNs 에 인증해서 사용자 디바이스로 푸시 전달.

### 4-4. GoogleService-Info.plist

Firebase Console 에서 iOS 앱 등록 시 받는 plist 를:
```
gps-tracker-app/ios/Runner/GoogleService-Info.plist
```
에 배치. Xcode 에서 Runner 타깃에 **Add Files to Runner** 로 추가 (드래그앤드롭, Copy items 체크).

⚠️ `.gitignore` 에 등록되어 있음. 별도 공유 채널로 팀원 배포.

### 4-5. Xcode Capabilities

`ios/Runner.xcworkspace` 를 Xcode 로 열고:
- Runner 타깃 → **Signing & Capabilities** → + Capability →
  - **Push Notifications**
  - **Background Modes** → Remote notifications 체크

### 4-6. Provisioning Profile

App Store Connect / Xcode 자동 서명을 쓰면 자동 처리. 수동이라면 Push 가 활성화된 provisioning profile 재발급 필요.

---

## 5. Flutter 앱 측 (lib/fcm.dart 동작)

```dart
await initFirebase();                                  // 1. Firebase.initializeApp
await FirebaseMessaging.instance.requestPermission();  // 2. Android 13+ / iOS 권한
final token = await FirebaseMessaging.instance.getToken();  // 3. FCM 토큰

// 4. WebView 가 로그인 완료 (localStorage.access_token 세팅) 후
//    JS bridge 로 access_token 폴링 → POST /api/v1/auth/fcm-token
await registerFcmTokenWithBackend(fcmToken: token, jwt: jwt);

// 5. 토큰 회전 감지
FirebaseMessaging.instance.onTokenRefresh.listen((newToken) async {
  await registerFcmTokenWithBackend(fcmToken: newToken, jwt: jwt);
});
```

### foreground 메시지

iOS 와 Android 모두 foreground 에선 OS 가 자동으로 알림 트레이에 띄우지 **않습니다**. 직접 `flutter_local_notifications` 로 표시:

```dart
FirebaseMessaging.onMessage.listen((msg) {
  _showLocalNotif(msg);    // 채널 ID 'baljachwi_default' importance HIGH
});
```

### background / terminated 탭 처리

- **terminated** 에서 알림 탭 → 콜드 스타트: `FirebaseMessaging.instance.getInitialMessage()` 가 페이로드 반환
- **background** 에서 알림 탭: `FirebaseMessaging.onMessageOpenedApp` 스트림 emit

둘 다 `data.device_id` 를 보고 `https://gps.serial.kr/?device=<id>` 로 WebView 라우팅 (`lib/main.dart` 의 `_navigateForDeepLink`).

---

## 6. 서버 → FCM 페이로드 스키마

[gps-tracker-api/src/services/fcm.rs:312-322](../gps-tracker-api/src/services/fcm.rs) 가 보내는 메시지:

```json
{
  "message": {
    "token": "<fcm_token>",
    "notification": {
      "title": "🔋 배터리 부족",
      "body":  "1호차 배터리 3420mV"
    },
    "data": {
      "kind":      "low_batt",
      "device_id": "2995",
      "event_id":  "12345"
    },
    "android": { "priority": "HIGH" }
  }
}
```

> FCM HTTP v1 의 `data` 필드는 **모든 값이 string** 이어야 합니다. 서버측 `stringify_data` 가 number/bool 을 자동 변환합니다.

이벤트 종류별 title/body 매핑은 [fcm.rs:360 `title_for_kind`](../gps-tracker-api/src/services/fcm.rs) / [`body_for_event`](../gps-tracker-api/src/services/fcm.rs) 참고.

---

## 7. 알림 종류 + 사용자 설정

DB 의 `notification_settings` 테이블이 사용자별 토글을 보관. 서버 워커가 발송 전 체크해서 OFF 면 `notified_at` 만 마킹 (skip).

| `events.kind` | 설정 컬럼 | 기본값 |
|---|---|---|
| `low_batt`       | `low_batt_alert`       | TRUE |
| `motion`         | `motion_alert`         | TRUE |
| `offline`        | `offline_alert`        | TRUE |
| `signal_loss`    | `signal_loss_alert`    | FALSE |
| `online`         | `online_alert`         | TRUE |
| `sleep_enter`    | `sleep_alert`          | FALSE |
| `wake`           | `wake_alert`           | FALSE |
| `geofence_in`    | `geofence_alert`       | TRUE |
| `geofence_out`   | `geofence_alert`       | TRUE |
| `geofence_armed` | `geofence_alert`       | TRUE |
| `brownout`       | `device_health_alert`  | TRUE |
| `gps_anomaly`    | `device_health_alert`  | TRUE |
| `lost`           | `lost_alert`           | TRUE |

프론트엔드는 `PATCH /api/v1/notifications/settings` 로 변경.

---

## 8. 트러블슈팅

| 증상 | 원인 / 해결 |
|---|---|
| journal 에 `dry-run mode` | `FCM_SERVICE_ACCOUNT_PATH` 미설정 또는 JSON 읽기 실패. 경로 / 권한 확인 |
| journal 에 `fcm: token unregistered, will deactivate` | 앱이 재설치되어 토큰이 무효화됨. 자동으로 `fcm_tokens.active=FALSE`. 앱 재로그인 시 새 토큰 등록 |
| Android 알림 안 옴 (Foreground 만 떠름) | `flutter_local_notifications` 채널 importance HIGH 인지 확인 |
| iOS 알림 안 옴 | (1) APNs 키 Firebase 에 업로드했는지 (2) Push Notifications + Background Modes capability 체크 (3) provisioning profile 재발급 (4) 실기기 + production build 로 테스트 (시뮬레이터는 푸시 못 받음) |
| Android 13+ 권한 거부 | `requestPermission()` 거부됐을 때 fallback UI 필요. 설정 → 앱 → 알림 토글로 안내 |
| 푸시 본문에 `null` 표시 | 서버 `body_for_event` 가 `data.<필드>` 못 찾음. 이벤트 발행 시 `data` JSON 확인 |
| FCM 응답 `INVALID_ARGUMENT` | 페이로드 버그 (예: data 필드에 nested object). 서버 로그의 정확한 메시지 확인. **이전엔 invalid 토큰으로 오인하던 버그가 있었으므로 다시 발생하면 토큰을 비활성화하지 말 것** |

---

## 9. 키 회전 / 보안 체크리스트

- [ ] `gps-tracker-*-firebase-adminsdk-*.json` 은 `.gitignore` 에 있나?
- [ ] 서버상 위 파일의 권한이 600 (mmm 만 read)?
- [ ] `google-services.json`, `GoogleService-Info.plist` 둘 다 git 제외?
- [ ] APNs `.p8` 키는 1Password 등 안전한 곳에만 보관?
- [ ] release keystore 비밀번호가 `key.properties` 외에 노출된 곳 없나? (memory / shell history / 채팅)
- [ ] 키가 유출되면 즉시: Firebase 서비스 계정 키 → revoke + 새로 발급 / APNs 키 → revoke (Apple Dev Portal) + 새 키 + Firebase 갱신
