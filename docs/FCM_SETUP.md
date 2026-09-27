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
3. 백엔드는 이벤트를 수신자별 `fcm_outbox`에 기록하고, 발송 워커가 FCM HTTP v1을 호출한다 (OAuth2 자기 서명 JWT).
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
scp gps-tracker-*-firebase-adminsdk-*.json deploy@<VPS_HOST>:/home/deploy/secrets/
chmod 600 /home/deploy/secrets/gps-tracker-*.json
```

`.env`:
```ini
FCM_SERVICE_ACCOUNT_PATH=/home/deploy/secrets/gps-tracker-e21be-firebase-adminsdk-fbsvc-<해시>.json
```

API 재시작 후 journal 확인:
```bash
sudo journalctl -u gps-tracker-api -n 30 | grep -i fcm
# 발송이 있었을 때 fcm: sent / retry scheduled / delivery dead-lettered 확인
```

`dry-run mode (no FCM client)`는 path 미설정일 때만 선택한다. 경로를 명시했는데 파일 읽기/파싱에 실패하면 API 시작을 실패시켜 알림을 조용히 소모하지 않는다. 실제 발송 여부는 outbox와 `fcm: sent` 로그로 확인한다. dev에는 운영 FCM 자격 증명을 넣지 않는다.

### 서버측 동작 요약 (src/services/fcm.rs)

- `events.notified_at IS NULL`인 이벤트를 최대 50개 평가한다. 사용자 설정 확인, 활성 토큰별 큐 삽입, notified_at 갱신을 하나의 DB 트랜잭션으로 처리한다. notified_at은 **평가/큐 기록 완료**이며 휴대폰 수신 완료가 아니다.
- 수신자별 `fcm_outbox` 상태는 `pending|sent|dead|cancelled`다. 90초 lease로 선점하며 FCM 수락 후 sent로 기록한다. 프로세스가 중단되면 만료된 lease를 다시 처리한다. 재시도 직전에도 현재 소유권·알림 설정·장치 상태·발생 시각을 확인한다.
- 429/408/401/5xx 및 네트워크 오류는 Retry-After를 존중하며 지수 백오프와 jitter로 재시도한다. 401은 OAuth 캐시를 무효화한다. 최대 10회 시도, 유효기간은 종류별 15분/1시간/24시간, 완료 기록 보관 14일이다.
- 구조화된 FCM `UNREGISTERED`만 토큰을 비활성화한다. 기타 영구 오류는 dead 상태로 남긴다. 로그아웃/계정 변경으로 binding이 달라진 대기 메시지는 취소한다.
- 상담 알림도 같은 발송 큐를 사용한다. 다만 상담 메시지 저장과 enqueue는 아직 별도 트랜잭션이므로 그 사이 장애에서 푸시가 누락될 가능성은 남아 있다.
- FCM 수락 직후 응답 또는 DB 완료 기록이 유실되면 중복 가능성이 있다. exactly-once 전달을 보장하지 않는다. sent도 OS의 실제 표시/열람을 의미하지 않는다.
- 의도적인 dev dry-run은 이벤트를 평가 완료로 표시하고 외부 FCM을 호출하지 않는다.

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

Android 1.0.2+8의 `FcmService`가 초기화·토큰 회전·알림 스트림을 소유한다. `PushRegistration`은 요청을 직렬화하고 서버 성공 후에만 등록을 확정한다. 신뢰 origin의 localStorage와 sessionStorage를 모두 읽으며, 인증 변경 이벤트와 초기 동기화/폴링을 결합한다.

설치 ID·등록 세대·해제 키·대기 중인 해제 요청은 SharedPreferences에 보관한다. JWT는 이 복구 상태에 저장하지 않는다. HTTP timeout은 12초, 실패 재시도는 4초부터 최대 300초, 성공한 등록의 재확인은 12시간이다. 로그아웃은 JWT가 만료돼도 설치 해제 capability로 복구한다. 토큰 회전 시 저장된 계정을 처리하기 전에 WebView의 인증 상태가 확인되기를 기다린다.

오프라인 해제는 다음 네트워크/앱 실행 기회까지 지연될 수 있다. 이미 FCM/OS에 전달된 시스템 알림은 소급 취소를 보장하지 않는다. 앱은 여전히 notification+data 메시지를 사용한다. 별도 dev applicationId/Firebase flavor는 이번 운영 앱 개선 범위에 포함하지 않았다.

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

원격 탭뿐 아니라 로컬 알림 탭/launch details도 같은 목적지 처리로 연결한다. WebView가 준비되기 전 받은 목적지는 보관한다. 장치 이벤트는 `/?device=<id>`, 관리자 답변은 `/profile?tab=chat`, 사용자 상담 메시지는 `/admin?tab=chat&thread=<id>`로 이동한다. 숫자 ID만 경로에 넣는다. 아이콘은 `ic_stat_notification`이며, 알림 권한 거부 상태는 앱 설정 안내로 표시한다.

### 2026-09-28: 사용자 알림 정책

- `gps_alerts_v1`(장치 확인 필요): 연결 확인, 배터리/전원 확인, 움직임으로 깨어남, 구역 이탈. 높은 중요도.
- `gps_updates_v1`(장치 상태 안내): 새 정보 수신 지연, 연결 복구, 위치 확인, 절전/일반 깨움, 구역 진입/설정. 낮은 중요도이며 기본 소리·진동 없음.
- `gps_messages_v1`(상담 메시지): 일반 중요도. 문의/답변 전용.
- 기존 앱의 `baljachwi_default` 채널은 호환 목적으로 유지한다. 새 채널의 소리/중요도 분리는 **1.0.2+8 설치 후** 적용된다. 서버가 아직 앱에서 생성하지 않은 채널을 지정하면 FCM은 manifest 기본 채널을 사용한다. [Firebase 채널 규칙](https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages#AndroidNotification)
- 채널 중요도는 Android 8+ 표시 방식이며, FCM의 HIGH/NORMAL 전송 우선순위와 별개다. 일반 상태 안내는 NORMAL 전송으로 보낸다. 기존 OS에서 사용자가 선택한 채널 설정을 덮어쓰지 않는다.
- 제목에 장치 이름을 넣고, 본문에는 관찰한 사실·필요한 행동·발생 시각(KST)을 표시한다. `cycle_first_fix`는 실제 이동을 보장하지 않으므로 ‘위치가 확인되었습니다’로 안내한다. 통신 수신 지연을 전파 세기 약화로 단정하지 않으며, 배터리 전압을 임의의 잔량 %로 표시하지 않는다.
- `wake_cause=motion`인 wake 이벤트는 `motion_alert`로 제어하고 별도 일반 wake 알림을 중복 생성하지 않는다. 기타 wake는 `wake_alert`로 제어한다. 내부 `stuck`, `lost`, 알려지지 않은 종류는 진단 기록으로 남기고 푸시에서 제외한다.
- 연결/작동 상태 알림은 발생 후 15분, 배터리·전원·GPS 이상과 구역 출입은 1시간, 상담은 24시간까지 유효하다. FCM TTL도 남은 시간으로 제한한다. 복구 heartbeat, 설정 해제, 소유자 변경, 더 최신의 같은 상태/연결 상태/같은 구역 전환이 확인되면 대기 알림을 취소한다.
- data에는 `occurred_at`, `expires_at`, `notification_channel`, `notification_tag`가 추가된다. 상태별 tag로 알림함의 이전 상태를 교체하고 앱 foreground에서도 안정된 ID와 발생 시각을 사용한다. 만료된 foreground 알림은 표시하지 않는다.
- 서버가 이미 FCM에 넘긴 메시지는 이후 복구 상태를 소급 확인할 수 없다. TTL/상태 tag는 이 창을 줄이는 장치이며, 전달 취소나 exactly-once를 보장하지 않는다. [Firebase 메시지 유효기간](https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-lifespan)

---

## 6. 서버 → FCM 페이로드 스키마

[gps-tracker-api/src/services/fcm.rs:312-322](../gps-tracker-api/src/services/fcm.rs) 가 보내는 메시지:

```json
{
  "message": {
    "token": "<fcm_token>",
    "notification": {
      "title": "1호차 · 배터리 확인 필요",
      "body":  "배터리 잔량이 부족할 수 있습니다. 배터리와 전원 연결을 확인해 주세요. · 09.28 09:00"
    },
    "data": {
      "kind":      "low_batt",
      "device_id": "2995",
      "event_id":  "12345"
    },
    "android": {
      "priority": "HIGH",
      "ttl": "3599s",
      "notification": { "channel_id": "gps_alerts_v1", "icon": "ic_stat_notification" }
    }
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
| `motion` / 움직임에 의한 `wake` | `motion_alert` | TRUE |
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
| `lost`           | 진단 기록만 유지, 푸시 제외 | — |

프론트엔드는 `PATCH /api/v1/notifications/settings` 로 변경.

배터리 발생 기준은 실제 소유자의 `low_batt_threshold_mv`를 적용하며 기본 3500mV다. 사용자가 조정한 값도 ingest와 발송 재확인에 모두 적용한다. 유효하지 않은 0mV 측정은 알림을 만들지 않는다. UI는 전압 설정을 별도 접기 영역으로 제공하고 전압이 잔량 %가 아님을 안내한다. 저장 중 겹치는 조작을 막으며 실패 시 실제 저장된 값으로 되돌린다.

---

## 8. 트러블슈팅

| 증상 | 원인 / 해결 |
|---|---|
| journal 에 `dry-run mode` | `FCM_SERVICE_ACCOUNT_PATH` 미설정. dev에서는 의도된 동작. 명시한 파일이 잘못되면 API 시작 실패 |
| outbox `cancelled`, last_error `unregistered` | FCM이 토큰을 무효로 판정. `fcm_tokens.active=FALSE`. 앱에서 새 토큰 등록 |
| outbox `pending`, attempts 증가 | 일시 오류로 재시도 중. available_at/lease_until과 비밀값을 제거한 오류 코드 확인 |
| outbox `dead` | 영구 오류, 최대 시도 또는 24시간 만료. 원인 해결 없이 일괄 재전송하지 말 것 |
| Android 알림 안 옴 (Foreground 만 떠름) | `flutter_local_notifications` 채널 importance HIGH 인지 확인 |
| iOS 알림 안 옴 | (1) APNs 키 Firebase 에 업로드했는지 (2) Push Notifications + Background Modes capability 체크 (3) provisioning profile 재발급 (4) 실기기 + production build 로 테스트 (시뮬레이터는 푸시 못 받음) |
| Android 13+ 권한 거부 | 앱의 알림 차단 안내에서 OS 앱 설정으로 이동. 복귀 시 권한 상태 재확인 |
| 푸시 본문에 `null` 표시 | 서버 `body_for_event` 가 `data.<필드>` 못 찾음. 이벤트 발행 시 `data` JSON 확인 |
| FCM 응답 `INVALID_ARGUMENT` | 페이로드 버그 (예: data 필드에 nested object). 서버 로그의 정확한 메시지 확인. **이전엔 invalid 토큰으로 오인하던 버그가 있었으므로 다시 발생하면 토큰을 비활성화하지 말 것** |

---

## 9. 키 회전 / 보안 체크리스트

- [ ] `gps-tracker-*-firebase-adminsdk-*.json` 은 `.gitignore` 에 있나?
- [ ] 서버상 위 파일의 권한이 600 (deploy 계정만 read)?
- [ ] `google-services.json`, `GoogleService-Info.plist` 둘 다 git 제외?
- [ ] APNs `.p8` 키는 1Password 등 안전한 곳에만 보관?
- [ ] release keystore 비밀번호가 `key.properties` 외에 노출된 곳 없나? (memory / shell history / 채팅)
- [ ] 키가 유출되면 즉시: Firebase 서비스 계정 키 → revoke + 새로 발급 / APNs 키 → revoke (Apple Dev Portal) + 새 키 + Firebase 갱신
