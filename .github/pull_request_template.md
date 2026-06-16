<!--
  PR 올리기 전 [CONTRIBUTING.md](../CONTRIBUTING.md) 한 번 확인.
  체크박스는 자기 검토용 — 다 X여도 PR 자체는 올릴 수 있음.
-->

## 무엇을 / 왜

<!-- 한두 줄. 이 PR 의 의도. -->

## 어떻게 (선택)

<!-- 비자명한 구현 선택만. 간단한 변경이면 비워두기. -->

## 검토 체크

- [ ] 로컬에서 `cargo run` / `npm run dev` 정상 동작 확인
- [ ] `cargo fmt` / `cargo clippy --all-targets -- -D warnings` 통과 (Rust 변경 시)
- [ ] 새 env 변수 추가 → `gps-tracker-api/.env.example` 갱신
- [ ] 새 마이그레이션 추가 → 다음 번호 + 운영 DB 영향 본문에 메모
- [ ] API 스펙 변경 → `docs/API_CONTRACT.md` 갱신
- [ ] secret / 토큰 / 개인정보 포함 없음
- [ ] (필요 시) `STATUS.md` 진행 상태 갱신

## 운영 영향

- [ ] DB 마이그레이션 있음 (있으면 ↓ 명시)
- [ ] 새 env 변수 필요 (있으면 ↓ 명시)
- [ ] nginx / systemd 설정 변경 필요
- [ ] 모두 없음 — 그냥 머지 + 배포

<!-- 위 중 하나라도 체크했으면 maintainer 가 운영 반영 절차 따로 진행해야 함. -->
