# DB 스키마 / 마이그레이션 책임 모형

main DB (prod) 와 dev DB 의 schema sync 책임이 누구에게 있는지, 부사수가 prod 에 도달할 수 있는 경로가 있는지 정리.

관련 문서: [CONTRIBUTING.md](../CONTRIBUTING.md), [STATUS.md](../STATUS.md)

---

## 1. 책임 매트릭스

|  | maintainer (`@ETC11111`) | junior (`developers` team) |
|---|---|---|
| **prod DB** 직접 수정 (psql/ALTER) | ✓ | ❌ — 아래 §3 의 4계층 차단 |
| **dev DB** 수정 | ✓ (catchup) | ✓ (자기 branch deploy 시) |
| **main 머지** | ✓ (admin bypass) | ❌ (PR 제출만 가능, Code Owner 자동 reviewer = ETC11111 필수) |
| **prod deploy** (`bash deploy.sh prod`) | ✓ | ❌ |
| **dev deploy** (`bash deploy.sh dev`) | ✓ | ✓ (자기 branch 으로) |

> 부사수의 의도가 prod DB 까지 가려면 maintainer 손이 **최소 2번** (PR approve + prod deploy) 거쳐야 함.

---

## 2. 두 가지 sync 책임 — 모두 maintainer

### 2-1. Down-sync (main → dev) — **매 main 마이그레이션 머지 직후 즉시**

**왜:** 부사수는 자기 branch 의 base + 자기 마이그레이션 만 알아 main 의 신규 마이그레이션 모름. dev 환경 schema 완전성은 maintainer 가 보장해야 함. 안 하면 dev 에 배포된 펌웨어/web 이 새 컬럼 가정하는데 DB 에 없어 silent drop.

**예시 — 2026-06-19 실제 사례:**
- main 의 0033 (`device_beep`), 0034 (`location_heading`) 가 prod 에 적용됨
- 부사수가 0033 을 자기 `device_maintenance` 로 써서 dev deploy → dev DB 에 우리 0033/0034 가 영영 못 들어감
- 결과: 펌웨어가 heading 보내도 dev DB 에 저장 안 됨 (frontend 화살표 안 뜸)

**How:**
```sql
-- dev DB 에 직접 적용 (IF NOT EXISTS — idempotent)
ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS beep_pending      BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS beep_requested_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS devices_beep_pending_idx ON devices(id) WHERE beep_pending;

ALTER TABLE location_records
    ADD COLUMN IF NOT EXISTS heading REAL;
```

**`_sqlx_migrations` 테이블은 건들지 않음.** 부사수 branch 가 자기 마이그레이션 적용 기록을 가지고 있는 상태 보존. 이후 부사수가 main rebase 후 새 마이그레이션 적용 시 sqlx 가 자연스럽게 처리.

### 2-2. Up-sync (dev → main) — **PR 머지 + prod deploy**

**왜:** 부사수 dev 변경은 PR → 우리 승인 → 머지 → `bash deploy.sh prod` 거쳐야 prod 에 도달. 마지막 단계가 maintainer 단독.

**Common pitfall — 마이그레이션 번호 충돌:**
- 부사수 branch 의 `0033_xxx.sql` ↔ main 의 `0033_yyy.sql` 같이 번호 겹침
- 부사수 PR 리뷰 시 마이그레이션 번호 재명명 요청 (예: `0035_xxx.sql` 로 bump)
- 머지 전에 정리되어야 main 깔끔하게 prod 에 적용됨

**리뷰 체크:**
```bash
# main 의 마지막 마이그레이션 번호 확인
ls gps-tracker-api/migrations/ | tail -3
# 부사수 PR 의 마이그레이션 번호와 비교 — 같으면 재명명 요청
```

---

## 3. 부사수가 prod DB 못 만지는 4계층 차단

| # | 시도 경로 | 차단 메커니즘 |
|---|---|---|
| 1 | SSH `mmm@vps` | 부사수 키가 `/home/mmm/.ssh/authorized_keys` 에 **없음** |
| 2 | `sudo systemctl restart gps-tracker-api` | gps-dev 의 sudoers (`/etc/sudoers.d/gps-dev`) 가 **`gps-tracker-api-dev`** 만 허용 |
| 3 | `/home/mmm/projects/gps-tracker-api/.env` 읽기 (prod DB 비번) | mmm 소유 0600. gps-dev 접근 불가 |
| 4 | `psql -U gps_tracker_dev_app -d gps_tracker` 시도 | `gps_tracker_dev_app` role 에 `REVOKE CONNECT ON DATABASE gps_tracker` 적용됨 |

각각 독립이라 한 단계 우회 가능해도 다음 단계가 막음.

상세 셋업 절차: [STATUS.md](../STATUS.md) 의 "dev 환경 셋업" 섹션 + 메모리 `project_db_schema_responsibility`.

---

## 4. Routine — main 머지 후 maintainer 체크리스트

```
1. [ ] main 에 머지된 마이그레이션 있는지 확인
       git diff <last>..HEAD -- gps-tracker-api/migrations/
2. [ ] prod 배포 (bash deploy.sh prod) → 마이그레이션 자동 적용
3. [ ] dev DB 에 동일 ALTER (IF NOT EXISTS) 직접 적용
       wsl -d Ubuntu -- bash -lc 'ssh mmm@... "sudo -u postgres psql -d gps_tracker_dev" <<PSQL ... PSQL'
4. [ ] dev API restart 필요 X (단순 ALTER 는 hot — 새 ingest 부터 적용)
       단 컬럼 NOT NULL DEFAULT 추가는 큰 테이블에서 락 주의
5. [ ] 부사수에게 "main 변경 있음, rebase 권장" 알림 (Slack 등)
```

---

## 5. 부사수 PR 흡수 시 (up-sync) maintainer 체크리스트

```
1. [ ] gh pr checkout <PR번호> — 로컬에서 부사수 branch 받기
2. [ ] git log main..HEAD -- gps-tracker-api/migrations/ — 새 마이그레이션 확인
3. [ ] 번호 충돌 시 부사수에게 재명명 요청 (또는 우리가 rebase + amend)
4. [ ] cargo check + npm run build — 코드/schema sync 확인
5. [ ] 일부만 흡수하려면 cherry-pick / path-checkout / hunk-restore
       (자세한 절차: 이 문서의 별도 절 또는 사례별 안내)
6. [ ] PR 머지 → bash deploy.sh prod
7. [ ] dev DB 와 prod DB 일치 여부 재검증 (위 down-sync routine 4 단계)
```

---

## 변경 이력

| 일자 | 변경 |
|---|---|
| 2026-06-19 | 최초 작성. 부사수가 0033 마이그레이션 번호 충돌 사례 직후. |
