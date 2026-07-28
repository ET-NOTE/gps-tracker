-- (2026-07-28) Stage-R9-a 확장: rental_photos kind 확장 — 연료 게이지 사진 추가.
--
-- 기존 CHECK: ('pickup_odometer','pickup_damage','return_odometer','return_damage')
-- 신규: + ('pickup_fuel','return_fuel')

ALTER TABLE rental_photos DROP CONSTRAINT IF EXISTS rental_photos_kind_check;
ALTER TABLE rental_photos
    ADD CONSTRAINT rental_photos_kind_check CHECK (kind IN (
        'pickup_odometer','pickup_damage','pickup_fuel',
        'return_odometer','return_damage','return_fuel'
    ));
