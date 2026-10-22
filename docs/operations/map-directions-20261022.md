# 지도 방향·마커 간격 개선

2026-10-22 KST. 사용자 요청: 기존 미완료 검증과 보안 제약은 열린 항목으로 보류하고, 모바일 이력 방향 마커 과밀 및 회전 지도 방향 어긋남을 수정한다.

## 보류와 완료 범위

- [열린 항목](../reviews/gps-open-items.md)의 GPS-OPEN-01~06은 열림·보류다. 실물 절전 검증, 인증 펌웨어 순차 전환, HTTP 전송 기밀성, SIM 물리 점유 증명, Fleet 날짜/이벤트 문구를 이번에 재개하지 않았다.
- 이번 변경은 웹 지도와 Android 1.0.7(13). API·DB·GPS 펌웨어·dev-gps는 변경하지 않았다.
- 웹 소스 `2f5c4c3fa07fd126a1630859190ace60bcdcfcd4`, 운영 릴리스 `web-directions-20261022-2f5c4c3`.
- Flutter 별도 저장소 소스 `eb782dd3016f73024950c9dbdad93b3e0072ecaf`.

## 확인한 원인과 수정

1. 이력 화살표는 고정20px였고 선택된 점마다 표시되어 축소 시 겹쳤다. 이력/Seeker의 화살표와 점을 지도 투영 좌표로 비교하여 화면상 최소48px 간격으로 표시한다. 줌·이동·컨테이너 변경 뒤 재계산하고, 정지 대표점은 우선하되 같은 지점의 중복 마커는 숨긴다. 경로·원본 좌표·시간 선택·기록은 그대로 유지한다.
2. `addHistoryPoint`는 표시하지 않은 점에서 이전 좌표를 갱신하지 않았다. 따라서 다음 화살표가 인접 원본점 대신 오래전 선택점과의 긴 선분 방향을 가리킬 수 있었다. 모든 유효 원본점에서 이전 좌표를 갱신하고 gap에서 초기화한다. 실제 보이는 선분 방향은 SDK 화면 투영을 사용한다. 방향 미확정/정지/동일 좌표에는 북쪽 화살표 대신 점을 사용한다. 이미지 각도 버킷도5도에서1도로 바꿨다.
3. Web→native bridge는 마지막 표시 fix의 실제 선행 좌표와 그 시각(`previousFix`)만 전달한다. 샘플링된 이력점이나 배치 anchor의 기본값으로 방향을 만들지 않는다. 추가 필드에 비밀키·계정·토큰은 없다.
4. Flutter의 방향 저역통과 보정은 새 방향의45%만 갱신해 회전 직후 이전 방향이 남을 수 있었다. SDK 자체 애니메이션과 겹치는 값 보정을 제거하고, 카메라·화살표가 동일한 최종 방위와650ms 애니메이션을 사용하게 했다. 북쪽 경계, 중복·역순·캐시·fix 소실·시각 이상은 이전의 검증된 방향을 유지한다. 미확정 방향은 null로 두어 이동 화살표를 만들지 않는다.
5. 좌표 기반 대체 방향은 같은 배치의 원본 선행점을 우선하며,1~60초·8m 이상·물리적으로 가능한 이동만 받아들인다. 기존 고정500m 상한 때문에 정상적인 긴 배치 구간의 방향이 멈추는 경우도 시간당 이동 거리 제한으로 바꿨다.
6. 임의의15도 오프셋은 추가하지 않았다. 카메라의 SDK 회전 부호는 실제 투영 검증에서 올바르므로 유지했다.

## 검증

- 웹 전체138개 테스트, Vite 운영 빌드 통과. 실제 KakaoMap 컴포넌트로 생략된 원본점의 방향, gap/동일점, 줌 재샘플링, 원본점 보존, 필터/Seeker 가시성 유지, 선행 fix의 bridge 전달을 검증했다. 1500점 밀집 경로의 간격·확대·우선순위 검증도 포함했다.
- Flutter 전체22개 테스트 통과, analyze 문제 없음. 75→90도 전환 즉시 최종90도, 첫 배치의 원본 선행점, 역순·미래·fix 소실 후 복구, 실제0도 course 및 기존 파일 저장/공유 회귀를 확인했다.
- 연결된 Samsung 휴대폰에서 **실제 Kakao SDK + 모의 좌표**로75·90·180·270·0·45·359·1·90도 아홉 방향을 확인했다. 지도 중심에서 각 방향50m 앞 좌표를 SDK `toScreenPoint`로 투영했을 때 화면 위쪽과의 최대 오차0.3064도, 동쪽90도는0도였다. 화면 화살표도 위쪽으로 표시되는 것을 확인했다. 이 결과는 실제 도로 주행/GNSS 정확도를 측정한 결과는 아니다.
- SDK 확인용 APK는 실제 계정 데이터나 서버 API를 사용하지 않았다. 외부 진입점의 Dart 파일과 임시 `verificationProbe`를 썼고, 운영 빌드 전 Kotlin 소스를 정확히 복구했다. 최종 APK의 dex/libapp.so에서 두 검증용 문자열이 없는 것을 확인했다. 검증 APK는 서버에 올리지 않았다.
- 휴대폰 기존 설치1.0.4(10), 검증 APK 및 최종1.0.7(13)의 서명이 동일했다. 삭제 없이 `adb install -r`로 설치하고 최종 운영 `lib/main.dart` 앱을 실행했다. dumpsys의 versionCode13/versionName1.0.7 확인, 앱 런타임 오류 로그 없음. 인증·로컬 설정을 지우지 않았다.
- 운영 브라우저의 단말-520211/10월20일 원본 일간 경로를390px에서 확인했다. 축소 시 표시된 화살표9개 사이 최소48.05px, 한 단계 확대 후11개 사이 최소48px. 문서 너비390px, 시간 선택 마커 정상, 콘솔 error 없음. 테스트용 보기/추적 상태와 뷰포트를 복구하고 임시 탭을 닫았다.

## 배포와 다운로드

- 운영 웹 `/home/mmm/releases/web-directions-20261022-2f5c4c3/web`. 이전 웹 `/home/mmm/releases/prod-20261021-190449-d541456/web` 보존. 신규44개 파일 해시, root·devices·JS/CSS, 진단 페이지 불변과 API release 불변 확인.
- API는 `dev-20261021-190449-d541456` production을 유지한다. 스키마72, 서비스 재시작이나 DB 변경 없음.
- APK: [Android 1.0.7 APK](https://gps.serial.kr/gps-tracker-1.0.7-13.apk). SHA256 `eacc1cf59cb56ff8dcbfee3cbb48fd69d5b39fca6fedf4782d0dbb93a61ae978`.
- ZIP: [Android 1.0.7 ZIP](https://gps.serial.kr/gps-tracker-1.0.7-13.zip). SHA256 `8fbf5583a516b5fd75a4279c3fd3a74f7c7cec2e5fec6232a571d83e162e2b5c`.
- 서버 다운로드는 기존 버전을 보존하는 immutable 별도 경로다. 전체 응답 SHA·길이·Content-Disposition·Range206 검증 통과. 내정보→계정의 앱 다운로드 박스도1.0.7로 전환했다.
- APK/ZIP/manifest: `C:/Users/msb/AppData/Local/GPS-Builds/android-1.0.7-13/`.
- 회귀·SDK 실물·배포 로그와 사진: `C:/Users/msb/AppData/Local/GPS-Builds/map-directions-20261022/`. `native-direction-results.json`, `native-direction-phone.png`, `production-mobile-map.png`, `production-mobile-spacing.json`, `web-tests-build.log`, `android-deployment.log`, `web-deployment.log`.
- API/기록의 롤백 없이 이전 웹 symlink로 복구 가능. APK 공개 URL은 덮어쓰지 않는다.

SDK 근거: [카메라 단위·회전](https://apis.map.kakao.com/android_v2/docs/api-guide/camera/), [라벨 회전·TransformMethod](https://apis.map.kakao.com/android_v2/docs/api-guide/label/label/), [화면 좌표 변환](https://apis.map.kakao.com/android_v2/docs/api-guide/kakaomap/).
