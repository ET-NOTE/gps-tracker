# GPS 개선 5차 — Android 파일 다운로드·저장·공유

2026-10-20 KST. 최초 검토 17 보완. gps.serial.kr 운영 웹과 Android 앱 1.0.6(12)에 적용한다. API·DB·펌웨어·dev-gps는 변경하지 않는다.

## 변경

- Android 메인/보조 WebView에 다운로드 콜백을 켜고 공개된 버전별 APK/ZIP만 다운로드 관리자로 연결한다. 새 창 URL과 일반 이동에서도 처리하며, 뒤늦게 파일로 인식된 빈 보조 창은 닫는다. 파일을 여는 창을 일괄 ‘결제’라고 부르지 않고 URL 용도·호스트로 표시한다.
- HTTPS·앱 origin·정확한 파일명 경로만 허용한다. 다운로드 요청에 웹 로그인 토큰/쿠키를 보내지 않으며 query/userinfo가 포함된 URL이나 API 파일을 일반 공개 다운로드로 위임하지 않는다. 중복 파일명 충돌을 막기 위해 휴대폰 저장 파일에는 시각을 붙인다.
- Android 10+는 공용 다운로드 폴더, Android 6–9는 앱 외부 다운로드 폴더와 완료 알림을 사용한다. CSV/PDF는 기존 origin·main-frame 검증 브리지를 통해 이름·MIME·bytes만 전달한다. 8MiB 제한, 확장자/형식/PDF signature, 안전한 파일명 검증을 Dart·Kotlin에서 수행한다. 별도 전체 저장소 권한을 추가하지 않는다.
- 보고서 클릭 후 ‘파일로 저장’/‘공유’/‘취소’를 선택한다. 저장은 시스템 위치 선택 화면에서 사용자가 지정한 문서에만 기록한다. 공유는 제한된 앱 cache 경로의 FileProvider와 임시 읽기 권한을 사용한다. 수신 앱/수신자는 사용자가 선택하며 자동 전송하지 않는다. 공유 cache는 24시간이 지난 항목을 다음 공유 시 정리한다.
- 웹은 네이티브 파일 기능을 확인하고 기존 앱에는 업데이트/브라우저 안내를 표시한다. 일반 브라우저 다운로드는 유지한다. 긴 한글/이모지 이름도 확장자를 유지하면서 파일 시스템 길이 안으로 제한한다. 저장 완료·공유 화면 열림·사용자 취소·다운로드 시작을 구분하며, 공유 완료를 단정하지 않는다.
- ‘내 정보 → 계정 → 앱 다운로드’는 새 1.0.6 ZIP/APK를 가리킨다. 이전 다운로드 URL은 보존한다.

## 검증

- 웹 자동 테스트 115개 통과, Flutter 테스트 19개 통과, flutter analyze 오류/경고 없음. Vite root 빌드와 서명 release APK 빌드 성공. PDF 엔진의 기존 청크 크기 경고는 남아 있다.
- 브라우저 실제 CSV(305B)·한글 PDF(30,069B) 다운로드와 네이티브 전달 계약, 완료/취소 문구를 확인했다. PDF는 1페이지이며 가상 운전자 텍스트를 추출할 수 있었다.
- Samsung SM-S911N / Android 16에서 모의 데이터 전용 시험 화면으로 검증했다. 사용자가 저장·공유 선택 UI를 확인했고 실제 외부 전송은 하지 않았다. 저장된 CSV 35B·PDF 1,558B는 원본과 바이트 단위로 일치했다.
- 다운로드 관리자 자체 상태=8(완료), reason=0. 기존 공개 ZIP 31,233,213B / APK 68,801,597B의 휴대폰 다운로드 SHA-256이 서버 원본과 일치했다. ZIP `61e0600247808a806b29f92dc0c9ec2b347bef6034b9ec40a0a772c6866abc76`, APK `7595a8aca10f7bed3da395b421734de590e93bf749f9482a7d7cb470c20dd42c`.
- 기기 테스트는 모의 데이터의 네이티브 파일 처리와 별도 웹 전달 계약 검증을 조합했다. 운영 사용자 보고서를 외부에 전송하거나 iOS·결제 흐름을 새로 전수 검사한 결과는 아니다. 임시 검증 APK는 배포하지 않고 기본 lib/main.dart로 다시 만든 운영 APK를 전달한다.

## 릴리스

앱 소스(별도 Flutter 저장소): `496316b24f29271d1f8720ec2f729539fa3870b4`. 운영 APK `gps-tracker-1.0.6-12.apk` 85,030,322B, SHA-256 `9d2d176c74ecd5b0934ba9acdb3c9dbdab9fab0036abfc446c42e258306725af`. ZIP SHA-256 `a11790c8eba24ca317a17d59574c06ec72048fa5d57da9e6083546359aefe830`. 설치 전 1.0.4와 새 APK의 인증서 지문이 일치하여 삭제 없이 업데이트한다.

최종 패키징·재설치 통합 명령은 자동 승인 검토에서 상세 사유 없이 한 번 차단됐다. 파일 준비를 분리한 뒤 사용자가 ‘운영 APK 덮어 설치 승인’으로 명시적으로 승인했다. 최종 설치·서버 검증 결과는 후속 기록한다.

배포: ops/release_android_downloads.py가 APK/ZIP 해시·ZIP 내부 APK를 검증하고 새 버전 전용 Nginx 경로를 추가한다. 기존 버전/웹/API를 유지하며 nginx -t와 HTTP 본문 해시·Content-Disposition·Range(206)를 확인하고 실패 시 설정을 복구한다. 웹은 기존 웹 전용 원자적 전환을 사용한다.

근거: [Android 문서 저장](https://developer.android.com/training/data-storage/shared/documents-files), [파일 공유](https://developer.android.com/training/secure-file-sharing/share-file), [다운로드 관리자](https://developer.android.com/reference/android/app/DownloadManager.Request).


Android 운영 APK 1.0.6(12)는 사용자 승인 후 연결된 휴대폰에 `adb install -r`로 설치·실행했고 dumpsys에서 versionCode=12/versionName=1.0.6을 확인했다. 앱 삭제나 로컬 데이터 초기화는 하지 않았다. APK/ZIP은 서버에 공개했고 전체 응답 SHA-256·Content-Disposition·Content-Length·Range 206을 확인했다. 이전 다운로드와 API release는 유지됐다.

최초 Nginx 전환에서는 이전 SPA 응답이 검증에 잡혀 설정이 자동 복구됐다. Nginx reload 직후 새 attachment 경로가 준비될 때까지 제한 시간 안에서 확인하도록 보완했고, 같은 해시의 준비 파일만 재사용하여 재배포에 성공했다. 운영 웹의 다운로드 박스 전환은 별도 웹 릴리스로 마무리한다.


## 최종 운영 확인

웹 `web-remediation-20261020-8bc2501`, 소스 `8bc25017feffe5ed7e21fee9ffaac6f7bf7ad6e9`로 전환했다. 이전 웹 `web-remediation-20261020-7e0d21c`를 보존했다. API release `dev-20261020-145138-db3163c`와 진단 페이지 해시는 그대로다. 운영 계정 화면의 앱 다운로드 박스가 Android 1.0.6 및 새 ZIP/APK URL을 표시하는 것을 확인했다. 테스트 예약·단말기 소유권·실사용 데이터는 수정하지 않았다.

증거는 `C:/Users/msb/AppData/Local/GPS-Builds/gps-remediation-20261020/`의 `round5-web-tests.log`, `round5-flutter-tests.log`, `round5-analyze.log`, `round5-device-downloads.log`, `round5-android-deployment.json`, `round5-web-deployment.json`, `round5-app-download-card.png`에 보관했다. 휴대폰 파일 원본 비교와 APK/ZIP manifest는 `C:/Users/msb/AppData/Local/GPS-Builds/android-1.0.6-12/`에 있다.
