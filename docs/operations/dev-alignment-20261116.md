# dev-gps 프론트엔드·백엔드 정합 — 2026-11-16

부사수의 UI 개발을 위해 `dev-gps.serial.kr`에 현재 팀 검토용 웹·API와 필수 DB 스키마를 반영했다. 운영 데이터를 복제하지 않고 기존 개발 DB에 마이그레이션을 적용했다. 운영 GPS·Shield·Nginx·PDF 서비스는 재시작하거나 변경하지 않았다.

## 반영 결과

| 항목 | 이전 | 현재 |
|---|---|---|
| 공개 주소 | `https://dev-gps.serial.kr` | 동일 |
| 웹 | 2026-10-28 디자인 | `dev-aligned-20261116-r1`, 운영 137차와 같은 루트 경로 빌드 |
| API | `dev-20261021-190449-d541456` | `review137-20261116-r3`, `environment=development` |
| DB | 스키마72 | 스키마114, 추가42개 마이그레이션 |
| 개발 checkout | `bce96c6` | 제품 소스 `a4c6cb0`, 문서 후속 갱신 별도 |
| 개발 작업 브랜치 | `codex/dev-aligned-20261028` | `codex/dev-aligned-20261116` |

API SHA256: `62f67f352bcdc677273a88caa7c44b4c409d760c97b9da9128f734da790f648d`. 운영 검증 바이너리를 재사용하므로 health의 릴리스 이름에 `review137`이 포함된다. 개발 여부는 `environment=development`, 포트3041, 개발 DB와 개발 자격증명으로 구분한다.

- API: `/home/gps-dev/projects/gps-tracker-api/bin/gps-tracker-api-dev`
- 웹: `/home/gps-dev/gps-tracker-web-dev/dist` → `/home/gps-dev/releases/dev-aligned-20261116-r1/web`
- 소스: `/home/gps-dev/workspace/gps-tracker`
- 웹 소스 바로가기: `/home/gps-dev/gps-tracker-web-dev/source`
- 환경 파일: `/home/gps-dev/projects/gps-tracker-api/.env.dev` — 기존 파일 유지, 문서·Git에 비밀값을 넣지 않는다.
- DB/역할: `gps_tracker_dev_next_20260924` / `gps_tracker_dev_app`

개발 사용자6명·장치10개·위치47,823건을 유지했다. 전환 직전/직후 사용자·장치·위치의 **기존 열** 해시가 동일하다. 73차의 차량 자산/연결 생성, 예약·문서의 차량 참조 전환 등 이미 구현된 마이그레이션도 함께 실행했다. 따라서 모든 테이블에 데이터 변경이 없었다는 뜻은 아니다. 새 열을 포함한 전체 행 해시는 이전과 직접 비교하지 않는다.

## 범위와 제한

최신 API가 구동하려면 내장 마이그레이션과 DB 스키마가 일치해야 하므로114까지 연결했다. 저장 암호화 전환, 자동 보관·파기, 신규 취급대장, 정보주체 제공·통보, 관리자 MFA/IP 제어, TLS 강제를 새로 켜지 않았다. DB 정책3개는 `enabled=false`다.

기존 개발 격리를 유지했다. 문자 개발 모드, 개발 JWT/업로드 경로, 개발 CORS, 운영 DB 접근 차단 설정을 보존했다. 운영 결제·FCM·AI·1NCE 자격증명을 복사하지 않았다. 개발 전용 PDF 처리기도 새로 설치하지 않았다. 따라서 외부 결제/통보나 PDF 원본 렌더링 등 별도 서비스가 필요한 기능의 통합 인수까지 완료한 것은 아니다. UI와 기본 API 개발용 배포다. APK·펌웨어·방화벽·백신/WAF·운영 기능 플래그 변경 및 추가 부하 검증은 없다.

## 검증과 증거

- 기존 개발 DB의 물리적 복사본을 만들고, 그 복사본을 다시 복제해 스키마72→114 전환을 검증했다. 압축17청크를 유지한 전환은9.110초였으며 사용자·장치·위치의 기존 열 해시가 같았다.
- 임시 API는 별도 DB/파일 경로, 외부 자격증명 없음, localhost 이외 통신 차단으로 실행했다. 개발 테스트 계정2개 × 주요 조회9개 =18건200, 익명 조회401을 확인했다.
- 실제 개발 배포 완료: **16:55:36 KST**. SQL 전환9.160초, API 정지부터 소스/웹 전환까지19.087초. 개발 API만 재시작했다.
- 공개 개발 HTTPS에서도18건200/익명401, 웹41개 파일 해시와 JS MIME을 확인했다. 운영 파일 해시·서비스 PID/시작 시각, 개발 환경 파일·Nginx가 전후 동일했다.
- 실제 브라우저에서 계정·개인정보 요청·법인 운영·모바일 계정 화면 확인. 페이지 예외0, 관측한 서버5xx0, 운영 API 호출0. 기존 테스트 계정에 만료5분 개발 세션을 메모리에서만 주입했으며 로그인 폼/비밀번호 검증을 다시 실행한 것은 아니다. 계정과 비밀번호는 변경하지 않았다.
- 개발 API 자동 재시작0, 확인 구간의 journal 오류 우선순위 로그0. 별도 키가 없는 OPINET 경고/기본값 사용은 개발 환경의 기존 제한이다.

[원본 JSON·화면 캡처·해시 목록](../evidence/dev138-20261116/README.md)에 결과를 남겼다. 최초 준비는 새 릴리스 디렉터리에 umask가 적용되어 소스 묶음을 읽지 못했고, 디렉터리 권한을 수정한 뒤 통과했다. 이때 API/DB 변경은 없었다. 이후 실행한 스크립트는 `ops/align_dev_20261116.py`다.

## 부사수 작업 방법

2026-11-18부터 SSH TCP22의 출발지 IP 제한을 해제해 다른 사무실에서도 기존 등록 키로 `gps-dev@dev-gps.serial.kr`에 접속할 수 있다. 키 추가·교체나 비밀번호 로그인 활성화는 하지 않았다. [접속 정책/실제 외부 로그인 검증](ssh-access-20261118.md).

기존 `gps-dev` SSH 계정과 기존 개발 로그인 계정을 사용한다. 운영 SSH/DB 자격증명을 받을 필요가 없다. 서버 checkout은 새 개발 로컬 브랜치로 fast-forward했고 기존 브랜치를 남겼다. 개인 PC에서는 원격 `codex/location-business-prep`의 최신 커밋을 받은 뒤 별도 `codex/` 작업 브랜치를 만든다. 서버 개발 브랜치 자체를 원격에 게시한 것은 아니다. 화면 파일은 `gps-tracker-web/src` 아래에 있다.

### 개인 PC에서 UI 실행

```bash
cd gps-tracker-web
npm ci
# macOS/Linux
VITE_BASE=/ npm run dev
```

Windows PowerShell에서는 `$env:VITE_BASE='/'`를 설정하고 `npm run dev`를 실행한다. `http://localhost:8003`에서 확인한다. Vite 프록시가 `/gps-tracker/api`·WebSocket을 개발 서버로 연결하므로 로컬 DB나 Rust 실행은 필요하지 않다. `VITE_BASE=/`를 생략하면 기본값이 legacy `/gps-tracker/app/`이므로 루트 경로 빌드와 혼동하지 않는다.

### 개발 서버에서 웹 반영

`gps-dev` 사용자의 Node는 nvm의 **v20.20.2**다. 기본 system PATH의 `node`가 없을 수 있으므로 nvm을 먼저 로드한다. 아래는 부사수가 변경을 커밋하고 소스를 검토한 뒤 사용하는 웹 전용 절차다. 이번 배포는 검증된 기존 산출물을 재사용했으며 이 향후 빌드 절차로 새 제품 코드를 빌드한 것은 아니다.

```bash
set -euo pipefail
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 20.20.2
cd /home/gps-dev/workspace/gps-tracker/gps-tracker-web
npm ci
npm test
release="ui-$(date +%Y%m%d-%H%M%S)"
target="/home/gps-dev/gps-tracker-web-dev/releases/$release/web"
mkdir -p "$target"
VITE_BASE=/ VITE_OUT="$target" npm run build
cp -n /home/gps-dev/gps-tracker-web-dev/dist/assets/* "$target/assets/"
ln -s /home/gps-dev/uploads "$target/uploads"
printf '{"release":"%s","target":"dev","source_commit":"%s"}\n' \
  "$release" "$(git rev-parse HEAD)" > "$target/version.json"
ln -s "$target" /home/gps-dev/gps-tracker-web-dev/dist.next
mv -Tf /home/gps-dev/gps-tracker-web-dev/dist.next /home/gps-dev/gps-tracker-web-dev/dist
```

이후 공개 개발 주소에서 화면과 콘솔/API 오류를 확인한다. 웹만 바꾸면 API 재시작은 필요 없다. 이전 웹 링크 경로를 기록해 두면 웹만 원복할 수 있다. `/home/mmm`·운영 배포 경로는 대상이 아니다. API 변경이 필요할 때만 별도 빌드/검증 후 허용된 `sudo /bin/systemctl restart gps-tracker-api-dev`를 사용한다.

## 백업·복구

- 이전 API/env/기준 상태: `/home/gps-dev/backups/dev-aligned-20261116-r1` (root 전용).
- 이전 개발 스키마72 DB: `gps_tracker_dev_align138_backup72`. PostgreSQL DB 단위 복사본이며 검증용 복제를 통해 사용 가능성을 확인했다. 검증 후 자동 Timescale 작업 중지·접속 닫힘으로 보관한다. 같은 VPS의 백업이며 외부 재해복구 사본을 새로 만든 것은 아니다.
- 검증 DB `gps_tracker_dev_align138_check`는 삭제했다. 서버 웹 배포 디렉터리의 일회성 소스 bundle도 제거했다.
- 이전 웹 `/home/gps-dev/releases/dev-design-cleanup-20261028-7e42f90/web`과 이전 소스 브랜치는 남아 있다.
- 스키마114 반영 이후 새 UI 작업 데이터가 생길 수 있으므로72 백업을 현재 DB에 자동 덮어쓰지 않는다. 웹만의 장애는 링크 복귀, API/DB 문제는 신규 데이터를 보존한 뒤 앞으로 수정하거나 별도 복구 절차를 정한다.
