-- Older contracts keep their original document text; it does not identify a source template.
ALTER TABLE rental_office_catalog ADD UNIQUE (user_id,id);
ALTER TABLE rental_contracts ADD COLUMN template_id bigint,
    ADD FOREIGN KEY (user_id,template_id) REFERENCES rental_office_catalog(user_id,id)
        DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX rental_contracts_template ON rental_contracts(template_id) WHERE template_id IS NOT NULL;

-- Keep only the idempotency key after a cost is deleted. A retry of the original
-- creation request must never recreate a deleted cost, including from older clients.
CREATE TABLE rental_office_cost_keys (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_key text NOT NULL,
    PRIMARY KEY (user_id,request_key)
);
LOCK TABLE rental_office_costs IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO rental_office_cost_keys SELECT user_id,request_key FROM rental_office_costs;

DO $$
DECLARE runtime_role oid := to_regrole('gps_runtime');
BEGIN
    IF runtime_role IS NOT NULL AND has_table_privilege(runtime_role,'rental_office_costs','INSERT') THEN
        GRANT INSERT ON rental_office_cost_keys TO gps_runtime;
    END IF;
END
$$;

CREATE FUNCTION rental_office_claim_cost_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO rental_office_cost_keys(user_id,request_key) VALUES (NEW.user_id,NEW.request_key);
    RETURN NULL;
END
$$;
-- AFTER INSERT is intentionally skipped by an idempotent ON CONFLICT DO UPDATE.
CREATE TRIGGER rental_office_claim_cost_key AFTER INSERT ON rental_office_costs
    FOR EACH ROW EXECUTE FUNCTION rental_office_claim_cost_key();
