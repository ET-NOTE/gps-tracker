# Contributing

이 repo 는 `main` 보호. **모든 변경은 PR 통해서만** 들어갑니다.

## 1. 시작하기 (한 번만)

### 1-1. Clone + SSH 인증

회사 GitHub 계정 (협업자로 초대받은 계정) 으로 SSH 키 등록 후:

```bash
git clone git@github.com:ETC11111/gps-tracker.git
cd gps-tracker
```

### 1-2. git 신원 (LOCAL — 반드시 `--local`)

회사 계정으로 commit 이 author 표시되게:

```bash
git config --local user.name  "본인이름"
git config --local user.email "<github-id>+<username>@users.noreply.github.com"
```

> 회사 GitHub 의 noreply 이메일은 Settings → Emails → "Keep my email addresses private" 체크 시 표시되는 값.

### 1-3. Commit 서명 (권장)

GitHub 의 `Verified` 뱃지 표시 + 신원 위조 방지:

```bash
git config --local gpg.format ssh
git config --local user.signingkey ~/.ssh/id_ed25519.pub  # 사용 중인 SSH 키 경로
git config --local commit.gpgsign true
git config --local tag.gpgsign true
```

같은 SSH 키를 GitHub Settings → SSH and GPG keys → "New SSH key" 시 **Key type = Signing Key** 로 한 번 더 등록.

### 1-4. 로컬 환경

```bash
cd gps-tracker-api
cp .env.example .env       # 값은 maintainer 에게 요청 (절대 commit X)
cargo run

cd ../gps-tracker-web
npm install
npm run dev
```

키 발급처: [docs/SETUP.md](docs/SETUP.md) 표 참고.

## 2. 작업 흐름

### 2-1. 브랜치

```bash
git checkout -b feat/<짧은-이름>    # 기능
git checkout -b fix/<짧은-이름>     # 버그
git checkout -b docs/<짧은-이름>    # 문서
git checkout -b chore/<짧은-이름>   # 설정/배포/리팩토링
```

### 2-2. 커밋 메시지

한국어 OK. 한 줄 요약 + 빈 줄 + 본문 (필요 시):

```
feat: SIM 충전 요청에 데이터량 50MB 옵션 추가

기존 500MB 고정이었던 것을 50MB / 200MB / 500MB 중 선택 가능하게.
1NCE plan 정책상 실제 충전은 500MB 만 가능하지만 UI 표시용.
```

prefix: `feat / fix / docs / refactor / chore / test / perf / build`

### 2-3. PR 올리기

1. 브랜치 push: `git push -u origin feat/your-branch`
2. GitHub 가 자동으로 PR 템플릿 띄움 — 채우기
3. CODEOWNERS 가 maintainer 를 자동 reviewer 지정
4. **승인 1개 + 모든 conversation resolved + main 최신 sync** 되면 머지 가능

### 2-4. 머지 후

```bash
git checkout main
git pull
git branch -d feat/your-branch    # 로컬 브랜치 정리
```

## 3. 코드 스타일

### Rust (gps-tracker-api)

- `cargo fmt` 통과 — PR 전 자동 포맷
- `cargo clippy --all-targets -- -D warnings` 통과
- 새 마이그레이션: `migrations/NNNN_short_name.sql` (NNNN = 다음 번호)
- error handling: `?` + `anyhow::Result` (라우트 핸들러는 `AppError`)
- 새 env 변수 추가 시 → `.env.example` 도 같이 수정

### React (gps-tracker-web)

- 함수형 + hooks (class 컴포넌트 X)
- props 타입은 JSDoc 만 (이 repo 는 JS, TS 안 씀)
- 같은 디렉토리 안의 inline `<style>` 패턴 따르기 (별도 CSS 파일 만들기 전 maintainer 확인)

### 공통

- **WHY 만 주석으로** — WHAT 은 코드가 말함. 자세한 가이드: 코드 안 다른 주석들 참고
- 함수/변수 영어, 주석/UI 문구 한국어 OK
- TODO 는 GitHub 이슈로 — 코드 안 `TODO:` 남기지 말 것

## 4. 절대 하지 말 것

| 행동 | 이유 |
|---|---|
| `.env` 또는 secret 값 commit | 유출. `.gitignore` 가 막지만 강제 add 금지 |
| `main` 에 직접 push | branch protection 으로 막혀있지만 강제 금지 |
| `git push --force` / `--force-with-lease` 를 공유 브랜치에 | 동료 작업 날아감. 자기 PR 브랜치만 |
| `git commit --amend` 이미 push 한 브랜치에 | 위와 동일 (force push 됨) |
| pre-commit hook 우회 (`--no-verify`) | 검증 우회. 실패하면 원인 고치고 다시 |
| 의존성 메이저 버전 업그레이드 | maintainer 와 사전 협의 |
| DB 마이그레이션 down/revert | 운영 DB 에 적용 후 되돌리기 불가 — 신규 마이그레이션으로 보정 |

## 5. 막힐 때

- 큰 변경 전: 이슈 먼저 열어서 방향 합의
- 작은 변경: 그냥 PR 올리고 commit/리뷰로 진행
- 운영 장애 의심: maintainer 에게 즉시 ping (slack / direct)

## 6. 보안

비밀번호, 토큰, API 키, 개인정보, DB 덤프 — 어떤 채널로도 repo / PR / 이슈 / 댓글에 붙이지 마세요. 1Password 같은 별도 채널 사용.

부주의로 secret 올렸으면 즉시 `git revert` + maintainer 에게 알리고 키 회전.
