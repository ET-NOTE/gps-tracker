# 139차 Android 최신 기능 호환성 — 2026-11-18

## 결과와 배포

Android **1.0.8(14)**와 웹 **android139-web-20261118-r1**을 배포했다. 연결된 Galaxy Z Flip3(SM-F711N, Android15)에 최종 서명 APK를 `install -r`로 설치했다. 제거/데이터 초기화 없이 기존 user@user4.com 로그인·홈 지도·내정보·개인정보 요청 목록이 열렸다. 실제 기기의 앱 다운로드 카드에1.0.8이 표시된다.

- [APK](https://gps.serial.kr/gps-tracker-1.0.8-14.apk) / [ZIP](https://gps.serial.kr/gps-tracker-1.0.8-14.zip)
- [앱 PR2](https://github.com/yeyebee/gps-tracker-app/pull/2), [누적 웹·서버 PR248](https://github.com/ET-NOTE/gps-tracker/pull/248). 앱 PR2는 기존 앱 PR1 브랜치 위에 쌓인139차 변경이다.
- 앱 구현: 별도 `yeyebee/gps-tracker-app`, 브랜치 `codex/android139-file-compat`, 커밋 `9cffac8331c99fb98b7b94786f3d60ccb451aeb5`.
- 웹 구현: `ET-NOTE/gps-tracker`, `codex/location-business-prep`, 커밋 `6592023f3fe14987a1646710c9fd58f67f379d73`.
- API `review137-20261116-r3`/스키마114/기존 정책·기능OFF 유지. API 배포·DB 마이그레이션·부하 시험 확대 없음. dev-gps 소스/웹/설정을 변경하지 않았다.
- APK SHA256 `cef467a459a55eb07f8ce2bd0d905793de00c10f390711bc44d2bad4b30ec016`.
- ZIP SHA256 `9f48653d0114c910e74d990b0ef9ad0bb30a32e7d1de09fd03c27db9dcf1168b`.
- 서명 인증서 SHA256 `2b2668fd35eefe3ef00041547e79a251c1bfb5c6c5954514eff6f0b4b6de70d1`로 이전 앱과 같다. v1/v2 서명 검증 통과.

## 변경한 동작

1. 기존 CSV/PDF에 JSON, PNG, JPG/JPEG, WebP, GIF, XLSX, GPX 저장·공유를 추가했다. Dart와 Kotlin이 MIME/확장자/내용 헤더·텍스트 인코딩/파일명/8MiB 한도를 검사한다. JSON은 Dart에서 파싱하고 객체·배열만 허용한다. XML 외부 엔터티/DOCTYPE은 허용하지 않는다. ZIP/XLSX 압축을 풀거나 파일 내용을 실행하지 않는다. 헤더 검사는 악성코드 검사나 문서 렌더링 품질 검증을 의미하지 않는다.
2. 실제 네이티브 브리지 능력(version2, MIME 목록, 크기 한도)을 웹에 전달한다. 1.0.7 이하 앱에서는 CSV/PDF를 유지하고 새로운 형식은 앱 업데이트/브라우저 안내를 제공한다. 빈 파일·초과 파일·중복 처리·알 수 없는 결과는 성공으로 처리하지 않는다.
3. 법인 운행기록/렌트카 청구서 XLSX와 이력 GPX/CSV를 공통 저장 경로로 연결했다. 경로 GPX의 차량명은 XML 이스케이프한다. 일반 브라우저 다운로드도 유지한다.
4. 권리 자료 다운로드에서 `saved`, `share_opened`, `cancelled`, `browser_started`를 구분한다. 공유 선택기를 연 것은 전송 완료가 아니다. 관리자 개인 서류 내려받기를 취소하면 새 검토 확인값/선택 권한을 부여하지 않는다. 비밀번호는 다운로드 처리 후 비운다.
5. AppConfig의 오래된1.0.6 버전 표기를1.0.8+14로 맞췄다. 추가 저장소 권한, 외부 자동 공유, 인증정보의 DownloadManager 전달은 없다.

## 기능 검증

| 검증 | 실제 결과 |
|---|---|
| Flutter |35건 통과, analyze 최종 지적0|
| Kotlin |2개 테스트에서9형식·형식 혼동·파일명·UTF-8·크기·금지 형식 검사 통과|
| 실제 브리지 JavaScript |v2 능력·요청/취소 응답·로그아웃 인증정보 해제·다른 출처/하위 프레임의 shim 미설치 통과. 네이티브 출처/주 프레임 검사는 유지|
| 웹 |Linux Node22.22.2에서278건 전부 통과, Vite 루트 base 빌드 성공|
| 실물 Android15 |9형식의 시스템 파일 저장 후 원본 바이트·SHA256 전량 일치, PNG 공유 선택기 열기 후 취소, 저장 선택창 취소·DocumentsUI 취소 확인|
| 최종 설치 |설치된 base.apk SHA256이 배포 APK와 같음, 최초 설치 시각 유지, 기존 로그인 유지|
| 공개 배포 |서버와 외부 Windows PC에서 APK/ZIP 전체 응답 해시 일치. MIME·attachment·nosniff·Range206 확인|
| 웹 전환 |4개 화면 경로와 모든 신규 JS/CSS 응답 해시 확인. 기존 청크27개를 hardlink로 보존. API/개발 API/DB 서비스 상태와 API 바이너리·설정·개발 웹 index 해시 불변|

[원본 증거·화면7장·해시](../evidence/android139-20261118/README.md)에 성공·실패 기록을 함께 남겼다. 합성 파일은 임시 검증 진입점에서 실제 네이티브 저장 처리기를 사용했다. 최종 배포는 `lib/main.dart`로 빌드한 APK이며 검증용 APK를 게시하지 않았다. 실제 앱에서는 운영 요청 목록0건 표시와1.0.8 다운로드 카드를 확인했다. 운영에서 새 개인정보 요청 생성/제공본 발급을 다시 실행한 것은 아니다. FCM·결제·iOS·최소지원 Android6 전체 회귀와 운영 기능 활성화는 이번 완료 범위가 아니다.

## 최초 실패와 정리

- 웹 최초 검사6건 실패: 중복 import와 테스트 stub의 새 import 미반영을 수정했다. 이후274건 통과. 추가 검사 뒤 Windows Node22.12.0의 calendar 테스트 하위 프로세스가0xC0000005로 종료됐고, 단독 실행2건은 통과했다. 원인을 단정하지 않았다. Linux의 동일 소스 전체278건이 최종 기준이다.
- Linux 최초10건 실패는 시험 묶음에 빠진 공용 `gps-tracker-api/battery-policy.json` 때문이다. 형제 디렉터리 구조와 원본 파일을 복원한 뒤278건 통과했다. 별도 빌드 디렉터리만 사용했다.
- 실물 첫 실행에서9파일 저장/공유/하단 취소는 통과했으나 마지막 DocumentsUI 취소 검사가 실패했다. 폴더 안에서 뒤로가기는 상위 폴더로 먼저 이동한다. 검증 도구를 수정해 기존9파일 해시를 재확인하고 두 취소 경로를 다시 통과했다. 앱 동작 수정 사유는 아니었다.
- 초기 ADB 화면 스트림 앞에 다중 디스플레이 경고347바이트가 붙었다. 원래 PNG 바이트만 분리했고 픽셀은 편집하지 않았다. 도구는 이후 기기 파일로 캡처·pull하도록 수정했다.
- 실물 검증을 끝낸 뒤 검증용 APK를 최종 APK로 교체했다. 테스트용 에뮬레이터는 종료했다. 검증 파일9개는 기기의 `Download/android139-evidence/`에 남아 직접 확인할 수 있다. 원본 합성 자료는 양쪽 저장소에 있다.

## 재현·인계·복구

- 앱 체크아웃: `E:/project/2025/esp32c3-mini_gps/flutter_app`. `flutter test`, `flutter analyze`, `node tool/native_bridge_check.mjs`, Android 폴더에서 `gradlew :app:testReleaseUnitTest`.
- 앱 서명/지도 키 설정은 기존 로컬 비밀 파일을 사용한다. Git에 키/암호를 추가하지 않았다. 실제 배포 빌드: `flutter build apk --release --target lib/main.dart`.
- 로컬 배포물: `C:/Users/msb/AppData/Local/GPS-Builds/android-1.0.8-14/`. **android139-smoke-only.apk는 배포 금지**다.
- 실물 재현: 별도 `tool/report_compat_smoke.dart`로 빌드하고 자체 테스트 폴더를 선택한 뒤 `ops/verify_android139_device.py SERIAL OUTPUT`을 실행한다. 이미 저장한 파일의 재검증에는 `--verify-existing`. 시험 뒤 반드시 최종 APK로 복구한다. 출력 폴더를 실제 증거와 구분한다.
- 공개 파일: `/home/mmm/gps-downloads/gps-tracker-1.0.8-14.{apk,zip}`. 준비물/원래 Nginx 설정은 `/home/mmm/gps-artifacts/android-1.0.8-14/`에 있다. 이전 공개 버전을 보존했다.
- 웹: `/home/mmm/gps-tracker-web/dist-root` → `/home/mmm/releases/android139-web-20261118-r1/web`. 이전 웹은 `/home/mmm/releases/review137-20261116-r2/web`이다. 웹만 복구할 때 현재 링크가139 릴리스인지 먼저 확인하고 이전 링크로 원자적으로 교체한다. API/DB를 되돌리지 않는다. 두 배포 스크립트는 당시 상태에 고정돼 재실행을 거부한다.
- Android의 일반 APK 다운그레이드를 복구 절차로 삼지 않는다. 이미 설치된14에 결함이 있으면 versionCode15 이상의 수정판을 같은 키로 배포한다. 앱 데이터 제거로 되돌리지 않는다.
- Linux 검증 작업: `/home/etcom-hub/build/android139-web-20261118/`. dev-gps는 부사수의 별도 변경과 충돌할 수 있으므로 이번 변경을 검토·병합한 뒤 별도 배포해야 한다. 운영 다운로드 파일은 공통 URL로 제공한다.
- 다음 범위는 기존 정책/관리자 회선·MFA/암호화 운영 활성화/실물 TLS·절전 인수 등의 보류 목록을 따른다. 이번139를 근거로 정책·권한 기능을 켜거나 부하 라운드를 추가하지 않는다.
