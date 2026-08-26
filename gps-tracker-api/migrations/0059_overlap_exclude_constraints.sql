-- 0059 (2026-08-14) 예약·계약 기간 겹침 근본 차단 — DB EXCLUDE 제약 (뿌리 A).
--
-- 배경: 겹침(더블부킹)은 앱층 check-then-insert 만으론 동시성 race 로 뚫린다. 앱층엔 device 별
--   advisory lock + 겹침검사를 넣었지만(신규 겹침 차단), 최종 방어선은 DB EXCLUDE 제약이다.
--
-- ⚠️ 이 migration 은 앱 부팅 시 sqlx::migrate! 로 자동 실행된다. EXCLUDE 제약을 그냥 걸면
--    (a) prod 에 이미 겹치는 기존 데이터가 있거나 (b) btree_gist extension 생성 권한이 없으면
--    migration 이 실패 → API 부팅 불가(장애)가 된다. 그래서 방어적으로 처리:
--      · 각 단계를 DO/EXCEPTION(PL/pgSQL savepoint)으로 감싸 실패해도 NOTICE 후 계속.
--      · 깨끗한 환경(dev/신규 설치)에선 제약이 실제로 걸리고,
--      · 더티 prod 에선 스킵되고 앱층(advisory lock + 겹침검사)이 계속 보호한다.
--
-- prod 에 확실히 적용하려면(권장): 겹침 데이터 정리 후, privileged 계정으로 아래 제약을 수동 추가.
--   SELECT device_id, count(*) FROM vehicle_reservations WHERE status IN ('planned','in_progress') ... 로
--   겹침 조사 → 정리 → ALTER TABLE ... ADD CONSTRAINT ... EXCLUDE ... 수동 실행.

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS btree_gist;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '0059: btree_gist 생성 스킵 (%) — 앱층 보호 유지', SQLERRM;
END $$;

-- corporate 예약: planned/in_progress 상태끼리 같은 device 기간 겹침 금지
DO $$
BEGIN
  ALTER TABLE vehicle_reservations
    ADD CONSTRAINT vehicle_reservations_no_overlap
    EXCLUDE USING gist (
      device_id WITH =,
      tstzrange(starts_at, ends_at) WITH &&
    ) WHERE (status IN ('planned','in_progress'));
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '0059: vehicle_reservations EXCLUDE 스킵 (%) — 앱층 보호 유지', SQLERRM;
END $$;

-- rentcar 계약: active/overdue 상태끼리 같은 device 기간 겹침 금지
DO $$
BEGIN
  ALTER TABLE rental_contracts
    ADD CONSTRAINT rental_contracts_no_overlap
    EXCLUDE USING gist (
      device_id WITH =,
      tstzrange(starts_at, ends_at) WITH &&
    ) WHERE (status IN ('active','overdue'));
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '0059: rental_contracts EXCLUDE 스킵 (%) — 앱층 보호 유지', SQLERRM;
END $$;
