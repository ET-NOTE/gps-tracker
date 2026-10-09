# 네이티브 지도 전환 — 사용자 설정

현재 Flutter 앱은 WebView에서 웹 지도를 표시한다. 코드에 카카오 네이티브 지도 키나 네이티브 지도 SDK 초기화는 없다. 결제 앱을 열기 위한 kakaotalk/kakaopay URL scheme은 지도 설정과 별개다.

## 카카오 Developers에서 필요한 작업

1. 기존 GPS 서비스의 카카오 앱에서 **네이티브 앱 키**를 확인한다. 키 값은 로컬 비공개 설정 파일로 전달한다. JavaScript 키나 REST API 키로 대체할 수 없다.
2. 해당 앱의 카카오맵 사용 설정이 ON인지 확인한다.
3. Android 앱 정보에 패키지명과 서명 인증서의 키 해시를 등록한다.
4. iOS까지 적용할 때는 번들 ID를 등록한다.

| 항목 | 확인한 값 |
|---|---|
| Android 패키지명 | `com.etcompany.gpstracker` |
| 현재 직접 배포 APK의 카카오 키 해시 (Base64 SHA-1) | `2zLjGqIesHW+GMtysRCxH1kQzTs=` |
| iOS 번들 ID | `com.etcompany.tracker` |
| 네이티브 앱 키 | 사용자 확인 필요 |

키 해시는 2026-10-08 생성된 `flutter_app/build/app/outputs/flutter-apk/app-release.apk`의 서명 인증서에서 추출했다. 인증서 SHA-1은 `DB:32:E3:1A:A2:1E:B0:75:BE:18:CB:72:B1:10:B1:1F:59:10:CD:3B`이다. Google Play App Signing이 별도 인증서로 서명한다면 **Play 앱 서명 인증서**의 키 해시도 추가해야 한다. 디버그 빌드를 사용할 때는 디버그 인증서도 별도로 등록한다. 인증서 해시는 공개 등록 정보이며 개인 서명 키가 아니다.

이 설정 이후 네이티브 지도 표시·마커/경로 이식·회전 추적 구현 및 실기기 검증이 필요하다. 이 문서 작성 시점에는 지도 전환을 배포하지 않았다.

공식 문서: [지도 SDK별 키와 사용 설정](https://developers.kakao.com/docs/ko/kakaomap/common), [Android 인증 절차](https://apis.map.kakao.com/android_v2/docs/getting-started/quickstart/).
