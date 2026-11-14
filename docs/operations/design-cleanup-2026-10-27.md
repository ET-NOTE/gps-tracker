# GPS 화면 정리 — 2026-10-27

## 운영 반영

- 웹 릴리스: `web-design-cleanup-20261027-7e42f90`
- 웹 소스: `7e42f9060ca2b0dba64cf5ee35643cc674742c24`
- 배포 경로: `/home/mmm/releases/web-design-cleanup-20261027-7e42f90/web`
- 웹 아카이브 SHA256: `7cc46ea1250f3ec3fb53ec185468c43eb04b32687284d49ee5fc0ea36baa050b`
- API·DB·펌웨어·APK·dev 배포는 변경하지 않았다. 기존 보류 항목도 그대로 유지한다.
- 운영 health의 `environment=production`, `ok=true`, `db=true` 확인. API의 기존 릴리스 이름 `dev-20261021-190449-d541456`은 변경되지 않았다.

## 변경

- 법인 차량 관리의 전체 차량·사용 가능·사용 정지 카드를 모바일에서도 3열로 유지한다.
- 차량명과 상태를 별도 행에 배치해 버튼과 경쟁하지 않도록 한다. 긴 이름은 한 줄 말줄임을 사용하고 접근성 이름과 title에는 전체 이름을 유지한다. 중복 이름과 사진 없는 차량의 장식 아이콘을 제거한다.
- 법인·렌트카 공통 화면의 반복 설명, 제목·본문·부연 글자 역할, 버튼 배치를 정리한다. 배달 목록의 긴 이름과 배지도 줄바꿈을 방지한다.
- 차량 정보 창을 공통 Modal과 입력 컴포넌트로 통일한다. 기본 정보·운영 정보·연료·연비·차량 서류로 구성하고 내부 용어를 제거한다. 저장·취소는 하단에 유지한다. API 저장값과 유효성 검사는 유지한다.
- 서류 미리보기도 공통 모달로 맞춰 중첩 모달의 포커스와 Escape 처리를 통일한다.
- 내 정보·알림·실험 기능의 기술 용어와 불필요한 설명을 정리한다. 비용, 영구 삭제, 기록 유지, 정기 보고 적용 조건 등 결정에 필요한 안내는 보존한다.

## 검증

- Node 22 빌드 환경에서 웹 자동 테스트 138개 통과, 실패 0개. Vite 운영 빌드 성공. 기존 PDF 번들 크기 경고는 남아 있다.
- 로컬 fixture에서 320·390·768px 및 PC 화면, 밝은/어두운 테마를 확인했다. 가로 넘침, 긴 이름, 3열 카드, 입력창과 고정 하단 버튼을 점검했다.
- 차량 정보 저장은 로컬 fixture에서 두 API 요청의 값과 목록 반영을 확인했다. Tab 순환, Escape 닫기, 호출 버튼으로 포커스 복귀를 확인했다.
- 법인·렌트카 주요 탭, 운전자·임차인·설정·구독·신규 계약 창, 배달, 홈·단말기·내 정보 화면을 탐색했다. 운영 계정의 정보 변경이나 구매·삭제는 수행하지 않았다.
- 운영 사이트에서 실제 차량 목록과 차량 정보 창을 다시 확인했다. 최종 내 정보 문구와 브라우저 오류 로그도 확인했다(오류 없음).
- 배포 스크립트가 각 JS/CSS 해시, 주요 SPA 경로, 웹 버전, 기존 API 릴리스 및 진단 페이지 보존을 검증했다. 기존 열린 세션의 lazy import를 위해 이전 해시 자산을 보존했다.
- 이번 모바일 확인은 브라우저 뷰포트 검증이다. 연결된 Android 실기기에서 APK 재설치·회전·키보드 검증을 수행한 것은 아니다.

## 증빙과 복구

로컬 증빙: `C:/Users/msb/AppData/Local/GPS-Builds/design-cleanup-20261027/`

- `build.log`: 최종 테스트·빌드 결과
- `manifest.json`, `web.tar.gz`: 최종 배포물
- `production-mobile-vehicles.jpg`, `production-mobile-vehicle-form.jpg`, `production-desktop-vehicles.jpg`: 운영 화면
- `mobile-320-vehicles.jpg`, `tablet-vehicles.jpg`, `mobile-vehicles-dark.jpg`, `mobile-vehicle-form-dark.jpg`: 반응형 증빙
- `mock-writes.jsonl`: 로컬 fixture 저장 검증

최종 문구 정리 직전 릴리스는 `web-design-cleanup-20261027-7120054`이며, 이번 디자인 작업 이전 운영 웹은 `web-report-design-20261023-2126bd4`이다. 복구가 필요하면 원하는 기존 릴리스의 `web` 디렉터리를 확인한 후 `/home/mmm/gps-tracker-web/dist-root` 심볼릭 링크를 원자적으로 교체하고 웹 버전·주요 화면·API health를 재확인한다. 서버의 각 릴리스 폴더에는 `previous-web.txt`와 `deployment.json`이 남아 있다.
