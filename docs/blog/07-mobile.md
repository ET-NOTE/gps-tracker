# 7. 모바일 — Flutter WebView + FCM (draft)

> Draft.

## 요약

- **왜 Flutter?** Android/iOS 동시 지원 + FCM (push) native 필요 + 전면 native 는 부담
- **구조**: 최소 WebView shell + FCM native module
- **flow**:
  1. 앱 부팅 → 서버 API 로 FCM device token 등록
  2. WebView 로 https://gps.serial.kr 로드 (SPA 실행)
  3. Push 알림 도착 → FCM native → deep link 로 WebView 특정 route 열기
- **UI 는 100% 웹**: iOS/Android 별 native UI 없음. WebView 안 React SPA 그대로.

## 왜 이렇게 최소?

- 개발자 리소스 부족 (한 명)
- 웹 UI 를 mobile-first 로 이미 잘 만들어놨음
- FCM 만 native 필요 (알림)

## 알려진 제약

- Full native 대비 UX 세밀도 낮음 (WebView scroll · gesture 등)
- Offline 시 최소 캐시만
- iOS 앱 심사 (아직 미제출)

## 위치

Flutter 앱은 별도 관리 (이 repo 에는 소스 없음 — flutter_app 폴더는 VPS 정리 시 삭제). 로컬 dev 환경에서만.

## 관련

- [gps-tracker-api/src/services/fcm.rs](../../gps-tracker-api/src/services/fcm.rs) — FCM push 발송

## 다음

- [8. 실전 사고](08-troubleshooting.md)
