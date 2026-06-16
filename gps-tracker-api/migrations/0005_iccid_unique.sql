-- ICCID 는 SIM 카드 일련번호로 전 세계적으로 유일.
-- 동일 ICCID 중복 row 방지 (race condition 방어).
-- NULL은 여러 개 허용 (ICCID 없는 레거시/anon 행 공존).

CREATE UNIQUE INDEX IF NOT EXISTS devices_iccid_unique
    ON devices(iccid)
    WHERE iccid IS NOT NULL;
