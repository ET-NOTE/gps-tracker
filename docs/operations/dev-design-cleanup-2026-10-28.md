# dev 디자인 정합 — 2026-10-28

사용자 요청에 따라 10월 27일 운영 디자인 개선을 dev 웹과 개발 소스 checkout에 반영했다.

## 반영 상태

| 항목 | 이전 | 이후 |
| --- | --- | --- |
| dev 웹 소스 | `2126bd4` | `7e42f9060ca2b0dba64cf5ee35643cc674742c24` |
| dev 웹 릴리스 | `dev-aligned-20261025-2126bd4` | `dev-design-cleanup-20261028-7e42f90` |
| 서버 소스 checkout | `19736ee` | `bce96c634bca240aaa239f854216d84a5e000155` |
| 서버 작업 브랜치 | `codex/dev-aligned-20261025` | `codex/dev-aligned-20261028` |

서버 소스는 `/home/gps-dev/workspace/gps-tracker`이고 `/home/gps-dev/gps-tracker-web-dev/source`가 이 checkout의 웹 디렉터리를 가리킨다. 적용 전 추가 커밋이나 미커밋 변경은 없었으며, 새 브랜치에서 fast-forward로 갱신했다. 적용 후 작업 트리는 깨끗하다. 웹 소스는 배포 커밋과 차이가 없고, checkout에 추가된 커밋은 검증 문서다.

변경 내용은 [운영 디자인 개선 기록](design-cleanup-2026-10-27.md)에 정리되어 있다. 본 문서와 일회성 배포 스크립트의 후속 로컬 커밋은 실행 앱의 정합에 영향을 주지 않는다.

## 검증과 보존

- 운영에서 테스트 138개와 빌드를 통과한 동일 아카이브를 사용했다. 웹 파일 44개의 공개 dev HTTPS 응답 해시가 manifest와 모두 일치한다.
- 아카이브 SHA256: `7cc46ea1250f3ec3fb53ec185468c43eb04b32687284d49ee5fc0ea36baa050b`.
- `/`, `/devices`, `/corporate`, `/rentcar`, `/profile`의 SPA 응답과 `/version.json`을 확인했다.
- dev `/health`: `environment=development`, `ok=true`, `db=true`. dev 인증 API의 익명 요청은 401이다.
- 브라우저의 법인 경로 접근은 정상 로그인 화면으로 연결되고 콘솔 오류가 없다. dev 로그인 세션이 없어 로그인 후 차량 화면의 시각적 검증은 이번에 다시 수행하지 않았다. 앞선 운영·fixture 화면 검증과 동일 웹 파일 해시를 근거로 정합을 확인했다.
- API·DB 마이그레이션·환경 설정·nginx·APK·펌웨어 변경 및 서비스 재시작은 수행하지 않았다. dev 계정·차량·이력·이용권 데이터 쓰기도 수행하지 않았다.
- 전후 비교에서 운영 웹 경로·index/version·API 바이너리·환경 파일·nginx, 운영/dev API PID와 시작 시각이 동일하다. dev API 바이너리·환경 파일·nginx도 동일하다.

## 백업과 복구

- 이전 dev 릴리스: `/home/gps-dev/releases/dev-aligned-20261025-2126bd4/web`.
- 신규 dev 릴리스: `/home/gps-dev/releases/dev-design-cleanup-20261028-7e42f90/web`.
- 백업/검증 결과: `/home/gps-dev/backups/design-cleanup-20261028`.
- 배포 스크립트: `ops/align_dev_web_20261028.py`.
- 신규 웹에서도 이전 해시 자산을 보존해 이미 열려 있는 세션의 lazy import를 지원한다.
- 복구 시 dev의 `/home/gps-dev/gps-tracker-web-dev/dist` 링크만 이전 릴리스로 원자적 교체한다. 소스는 깨끗한 상태인지 확인한 뒤 기존 `codex/dev-aligned-20261025` 브랜치로 전환할 수 있다. API·DB 복구는 필요하지 않다.
