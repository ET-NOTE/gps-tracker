-- Expenses are a company ledger. SIM ingest identities and raw trips are unchanged.
CREATE TABLE fleet_expense_categories (
 id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 parent_id BIGINT, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('group','expense','fuel')),
 active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,parent_id) REFERENCES fleet_expense_categories(owner_id,id),
 CHECK((kind='group')=(parent_id IS NULL))
);
CREATE UNIQUE INDEX fleet_expense_category_name ON fleet_expense_categories(owner_id,COALESCE(parent_id,0),name);
CREATE FUNCTION seed_fleet_expenses(uid BIGINT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE vehicle_group BIGINT; travel_group BIGINT;
BEGIN
 INSERT INTO fleet_expense_categories(owner_id,name,kind) VALUES(uid,'차량유지비','group') RETURNING id INTO vehicle_group;
 INSERT INTO fleet_expense_categories(owner_id,name,kind) VALUES(uid,'여비교통비','group') RETURNING id INTO travel_group;
 INSERT INTO fleet_expense_categories(owner_id,parent_id,name,kind) VALUES
 (uid,vehicle_group,'유류비','fuel'),(uid,vehicle_group,'정비비','expense'),(uid,vehicle_group,'통행료','expense'),(uid,vehicle_group,'주차비','expense'),
 (uid,travel_group,'숙박비','expense'),(uid,travel_group,'식대','expense'),(uid,travel_group,'기타','expense');
END $$;
SELECT seed_fleet_expenses(id) FROM users;
CREATE FUNCTION seed_new_fleet_expenses() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM seed_fleet_expenses(NEW.id); RETURN NEW; END $$;
CREATE TRIGGER fleet_expense_catalog AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION seed_new_fleet_expenses();

CREATE TABLE fleet_expenses (
 id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
 request_id UUID NOT NULL, request_value JSONB NOT NULL,
 spent_on DATE NOT NULL, category_id BIGINT NOT NULL, category_name TEXT NOT NULL, group_name TEXT NOT NULL, category_kind TEXT NOT NULL,
 staff_id BIGINT, staff_name TEXT NOT NULL, department_id BIGINT, department_name TEXT NOT NULL,
 vehicle_id BIGINT, vehicle_name TEXT NOT NULL,
 amount_krw INTEGER NOT NULL CHECK(amount_krw BETWEEN 1 AND 1000000000),
 payment_method TEXT NOT NULL CHECK(payment_method IN ('company_card','personal_card','cash','transfer','other')),
 note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
 source_device_id BIGINT, binding_id BIGINT, trip_started_at TIMESTAMPTZ,
 reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL, reviewed_at TIMESTAMPTZ, review_note TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id), UNIQUE(owner_id,created_by,request_id),
 FOREIGN KEY(owner_id,category_id) REFERENCES fleet_expense_categories(owner_id,id),
 FOREIGN KEY(owner_id,staff_id) REFERENCES staff(user_id,id),
 FOREIGN KEY(owner_id,vehicle_id) REFERENCES fleet_vehicles(owner_id,id),
 CHECK((trip_started_at IS NULL AND source_device_id IS NULL AND binding_id IS NULL) OR (trip_started_at IS NOT NULL AND source_device_id IS NOT NULL AND binding_id IS NOT NULL AND vehicle_id IS NOT NULL)),
 CHECK(trip_started_at IS NULL OR category_kind='fuel')
);
CREATE INDEX fleet_expenses_query ON fleet_expenses(owner_id,spent_on DESC,id DESC);
CREATE UNIQUE INDEX fleet_expense_trip_once ON fleet_expenses(owner_id,source_device_id,trip_started_at) WHERE trip_started_at IS NOT NULL AND status<>'cancelled';
ALTER TABLE trip_annotations ADD COLUMN fuel_expense_id BIGINT REFERENCES fleet_expenses(id) ON DELETE SET NULL;
CREATE TABLE fleet_expense_audit (
 id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL, expense_id BIGINT NOT NULL,
 actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL, action TEXT NOT NULL,
 before_value JSONB, after_value JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,expense_id) REFERENCES fleet_expenses(owner_id,id) ON DELETE CASCADE
);
CREATE TABLE fleet_expense_receipts (
 id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL, expense_id BIGINT NOT NULL,
 filename TEXT NOT NULL, mime TEXT NOT NULL, content BYTEA NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 5242880),
 digest TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), removed_at TIMESTAMPTZ,
 FOREIGN KEY(owner_id,expense_id) REFERENCES fleet_expenses(owner_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX fleet_receipt_retry ON fleet_expense_receipts(expense_id,digest) WHERE removed_at IS NULL;
