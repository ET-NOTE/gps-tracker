# GitHub Repo 클린 마이그레이션 (개인 → 회사 계정)

회사 org repo 의 commit log 깨끗 유지 + 개인 작업 인과 증명 둘 다 잡는 패턴.
이 프로젝트 (ET-NOTE/gps-tracker) 가 이 방법으로 마이그레이션됨.

## 세 가지 방법 비교

| 방법 | 회사 repo history | 인과 증명 | redirect | 흔적 |
|---|---|---|---|---|
| A. Transfer ownership | 100% 보존 | 자동 (transfer 기록) | 자동 redirect | 남음 |
| B. Mirror push (`git push --mirror`) | 100% 보존 | git history 그대로 | 없음 | 회사 repo 의 모든 commit 에 개인 작업 흔적 |
| **C. Fresh init + 매핑** ✓ | "Initial commit" 부터 새로 | **개인 마지막 commit hash + 회사 첫 commit hash** 매핑 | 없음 | **회사 repo 깨끗, 개인 repo 가 증명 보관** |

→ **C 가 우리 사용한 방법**. 회사 commit log 가 fresh "Initial commit" 부터 시작.

## 방법 C — Fresh init + 인과 매핑

### 1단계 — 개인 repo 의 끝단 commit hash 기록

마이그레이션 직전 개인 repo 에서:
```bash
cd YOUR_PERSONAL_WORKDIR
git log -1 --pretty='%H %ai %s'
git rev-parse HEAD                              # = 개인 repo 의 끝단 commit hash
git rev-parse HEAD^{tree}                       # = 그 tree SHA (인과 증명 핵심)
```

기록할 것:
- **personal_last_commit**: 마지막 commit SHA
- **personal_last_tree**: 그 commit 의 tree SHA  ← 인과 증명 핵심
- **personal_repo_url**: `https://github.com/PERSONAL_USER/REPO`

이 정보들은 사내 내부 문서 / Notion / Wiki 어딘가에 보관.

### 2단계 — 회사 org 에 새 빈 repo 생성

```bash
gh repo create COMPANY_ORG/REPO_NAME \
  --private \
  --description "..." \
  --confirm
```

`--gitignore` / `--license` / `--add-readme` 옵션 안 줌 (빈 상태로 둠).

### 3단계 — 로컬에서 fresh init + 첫 push

기존 작업 디렉토리에서 **`.git` 폴더 통째 삭제** 후 새로 init:

```bash
cd YOUR_WORKDIR
rm -rf .git                                     # ⚠️ 이전 git history 통째 삭제
git init -b main
git remote add origin git@github.com:COMPANY_ORG/REPO_NAME.git
git add -A
git commit -m "Initial commit"                  # ← 회사 repo 의 첫 commit
git push -u origin main
```

이제 회사 repo 의 첫 commit hash 확인:
```bash
git rev-parse HEAD                              # = company_first_commit
git rev-parse HEAD^{tree}                       # = company_first_tree
```

**인과 증명**: `company_first_tree == personal_last_tree` 이면 같은 코드 (모든 file content 동일). 누구든 두 hash 비교로 검증 가능.

### 4단계 — 매핑 기록

사내 wiki / 마이그레이션 로그 등에 기록:

```
Repo: REPO_NAME
Migrated: 2026-MM-DD (KST timezone)
Personal:
  url:    https://github.com/PERSONAL_USER/REPO_NAME
  last:   <personal_last_commit>
  tree:   <personal_last_tree>
Company:
  url:    https://github.com/COMPANY_ORG/REPO_NAME
  first:  <company_first_commit>
  tree:   <company_first_tree>
Proof:  personal_last_tree == company_first_tree (verified)
```

### 5단계 — 개인 repo 처리

증명용 보관:
- **Archive** (read-only, URL 살아있음):
  ```bash
  gh repo archive PERSONAL_USER/REPO_NAME --yes
  ```
- 그대로 두거나 — `private` 으로 유지 (사내 정책 따라)
- 삭제하면 인과 증명 못 함 → **삭제 안 하는 게 default**

### 6단계 — 검증

```bash
# tree SHA 비교 (핵심)
gh api repos/PERSONAL_USER/REPO_NAME/git/commits/<personal_last_commit> --jq '.tree.sha'
gh api repos/COMPANY_ORG/REPO_NAME/git/commits/<company_first_commit>   --jq '.tree.sha'
# 두 값이 같으면 동일 코드 = 인과 증명 ✓

# 회사 repo 의 fork 관계 없음 확인 (= 깨끗)
gh api repos/COMPANY_ORG/REPO_NAME --jq '{fork, parent, source}'
# {"fork": false, "parent": null, "source": null} 이면 깨끗 ✓

# 회사 repo 의 첫 commit 메시지
gh api repos/COMPANY_ORG/REPO_NAME/commits --jq 'last | .commit.message'
# "Initial commit" 이면 fresh start 확정
```

### 보정 작업

- **CI / Secrets**: github actions secrets 는 옮겨가지 않음. 새로 설정:
  ```bash
  gh secret list -R PERSONAL_USER/REPO_NAME
  # 각 secret 새 repo 에 다시 설정
  gh secret set NAME -R COMPANY_ORG/REPO_NAME < secret_value
  ```
- **Deploy key / Webhook**: 새 repo 에 다시 설정.
- **Branch protection rule**: 새 repo 에 다시 설정.
- **로컬 ssh config alias** (gh CLI 가 multi-account 인 경우):
  ```
  Host github-<alias>
    HostName github.com
    User git
    IdentityFile ~/.ssh/<key>
  ```
  `origin` URL 이 `git@github-<alias>:ORG/REPO.git` 형식이면 해당 alias 의 키로 인증.

## 함정

1. **`.git` 삭제 전 백업** — `rm -rf .git` 이 destructive. 개인 repo 가 살아있으면 복원 가능하지만 push 안 한 local commit 잃을 수 있음.
2. **개인 repo 즉시 삭제** — 인과 증명 못 함. archive 권장.
3. **`Initial commit` 가 아닌 다른 메시지** — 누군가 fork/copy 한 것처럼 보일 수 있음. "Initial commit" 이 신호.
4. **회사 repo 에 `parent` 가 null 안 됨** — `gh repo fork` 로 만든 경우 자동 fork 관계 생성. **fork 아닌 `gh repo create` 사용**.
5. **commit author 변경 안 하면 개인 이메일 보임** — `.noreply.github.com` 이메일이면 username 만 보임 (OK). 회사 이메일 원하면 `git config user.email` 미리 설정 후 첫 commit.

## ET-NOTE 이관 실측

이 프로젝트 (확인됨):

```
gh repo metadata:
  created_at: 2026-06-16T04:27:45Z (= 13:27:45 KST)
  fork:       false
  parent:     null
  source:     null

git log (oldest):
  508b2fa  2026-06-16 13:38:59 +0900  ETC11111  Initial commit       ← 11분 후 fresh push
  57c7b5e  2026-06-16 13:53:07 +0900  ETC11111  docs: 협업자 온보딩
  62991b7  2026-06-16 14:09:22 +0900  ETC11111  docs: clone URL 을 ET-NOTE org 로 갱신
```

회사 repo 깨끗. fork/parent 없음. 첫 commit "Initial commit" 으로 시작. 개인 repo 의 마지막 commit + tree SHA 가 어딘가 기록되어 있어 인과 증명 가능.
