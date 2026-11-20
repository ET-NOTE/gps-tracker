# 139차 검증 증거 — 2026-11-18

설명과 배포·복구 경계는 [139차 인계](../../operations/location-business-android139-20261118.md)를 따른다. 화면은 생성 이미지가 아니라 연결된 SM-F711N(Android15)에서 캡처했다. 01~05는 합성 자료를 사용하는 네이티브 검증 진입점, 06~07은 최종1.0.8 APK의 실제 운영 웹이다. 개인정보의 새 발급/운영 정책 활성화 증거로 사용하지 않는다.

| 파일 | 확인 내용 |
|---|---|
|01-json-export-sheet.png|JSON 저장/공유/취소 선택창|
|02-json-document-picker.png|시스템 DocumentsUI에서 테스트 폴더와 JSON 파일명|
|03-json-saved.png|실제 JSON 저장 완료 반환|
|04-share-opened-result.png|공유 선택기 열림 반환. 실제 외부 전송 없음|
|05-export-cancelled.png|취소 결과를 성공 저장과 구분|
|06-production-app-download.png|최종 앱·운영 웹의1.0.8 APK/ZIP 안내|
|07-production-privacy-requests.png|기존 로그인으로 개인정보 요청 목록/필터/페이지 화면 표시,0건|
|device-files.json|9개 합성 파일의 저장 바이트/해시 대조 및 공유·취소|
|installed-apk.json|기기에 설치된 APK와 배포물 해시 동일|
|apk-manifest.json, public-downloads.json|소스 커밋·APK/ZIP 해시·외부 HTTPS 응답|
|web-manifest.json, web-deployment.json|배포 웹 전 파일 해시·보호 상태 불변·이전 링크|
|apk-deployment.json|이전 다운로드 보존·Range206·API 릴리스 불변|
|logs/|자동 검사·실물·빌드·서명 원본. 최초 실패도 보존|

최종 자동 검증은 `logs/flutter-tests-1.log`35건, `flutter-analyze-final.log`지적0, `kotlin-tests-1.log`2개 테스트, `bridge-check.txt`, `web-tests-linux-final.log`278건이다. `web-tests-final.log`라는 로컬 실행 로그에는 Windows 프로세스 종료 실패가 남아 있다. 이름만 보고 성공으로 오해하지 말고 Linux 최종 결과와139차 문서의 경위를 따른다.

`device-tests-1.log`에는9파일을 실제 저장한 기록과 마지막 폴더 뒤로가기 검사 실패가 있다. `device-tests-final.log`는 기존 저장 파일을 다시 읽어 전량 대조하고 공유/취소를 재확인한 결과다. 처음3개의 ADB 캡처 중 일부는 PNG 앞의 ADB 경고만 제거했으며 이미지 픽셀은 수정하지 않았다. 전체 보존 파일은 `SHA256SUMS.json`으로 대조한다.
