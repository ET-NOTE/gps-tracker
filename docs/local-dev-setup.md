# 로컬 개발 환경 셋업

DB 조회 스크립트 (`gps-tracker-web/scripts/*.sh`) 등을 실행하기 위한 credential 설정.

## PGPASSWORD (DB 접속)

prod DB 접속 정보는 **maintainer 만** 갖고 있음. 스크립트는 env 로 pw 를 강제받음:

```bash
: ${PGPASSWORD:?PGPASSWORD required — see docs/local-dev-setup.md}
```

### 방법 1 — shell 세션마다 명시

```bash
export PGPASSWORD='<mmm 로부터 전달받은 값>'
bash gps-tracker-web/scripts/db_inspect.sh
```

### 방법 2 — profile 파일 (권장)

`~/.gps_tracker_env` 파일 생성 (권한 `600` 필수):

```bash
cat > ~/.gps_tracker_env << 'EOF'
export PGPASSWORD='<mmm 로부터 전달받은 값>'
EOF
chmod 600 ~/.gps_tracker_env
```

셀 진입 시 자동 로드:
```bash
# ~/.bashrc 또는 ~/.zshrc 에 추가
[ -f ~/.gps_tracker_env ] && source ~/.gps_tracker_env
```

### 방법 3 — direnv (프로젝트 단위)

```bash
# .envrc (프로젝트 root, gitignore 됨)
export PGPASSWORD='<...>'
```

## 원격 접속 (VPS)

- **maintainer (mmm)**: 실 배포·rotation·prod DB 직접 접속
- **junior (gps-dev)**: dev 환경만. prod DB 4계층 차단 (memory 참조)

접근 필요 시 maintainer 에게 SSH key 등록 요청.

## 재발급 이력

Credential 노출/유출/이직 등으로 rotation 필요 시:
1. maintainer 가 `ALTER USER ... WITH PASSWORD '새값'` 실행
2. VPS 실서비스 `.env` 갱신 + `systemctl restart gps-tracker-api`
3. 로컬 사용자들에게 새 pw 전달
4. 이 문서에 재발급 일자 (선택) 기록

- 2026-07-25: DB password rotation (사유: 이전 pw 가 스크립트에 하드코딩된 상태로 public repo 이력 노출)
