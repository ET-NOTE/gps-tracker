CREATE TABLE rental_office_catalog (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('customers','accounts','rates','templates')),
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
    active boolean NOT NULL DEFAULT true,
    details jsonb NOT NULL CHECK (jsonb_typeof(details)='object'),
    revision bigint NOT NULL DEFAULT 1
);
CREATE INDEX rental_office_catalog_owner ON rental_office_catalog (user_id,kind,id);
CREATE UNIQUE INDEX rental_office_master_name ON rental_office_catalog (user_id,kind,lower(name))
    WHERE kind <> 'customers';
CREATE UNIQUE INDEX rental_office_customer_phone ON rental_office_catalog
    (user_id,regexp_replace(details->>'phone','[^0-9]','','g')) WHERE kind='customers';
CREATE UNIQUE INDEX rental_office_business_number ON rental_office_catalog
    (user_id,(details->>'business_number')) WHERE kind='accounts' AND details->>'business_number'<>'';

CREATE TABLE rental_office_ledger (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contract_id bigint NOT NULL REFERENCES rental_contracts(id),
    kind text NOT NULL CHECK (kind IN ('payment','refund','deposit_in','deposit_out')),
    method text NOT NULL CHECK (method IN ('card','cash','transfer')),
    amount_krw bigint NOT NULL CHECK (amount_krw BETWEEN 1 AND 1000000000),
    recorded_at timestamptz NOT NULL,
    memo text NOT NULL DEFAULT '' CHECK (length(memo)<=500),
    request_key text NOT NULL,
    UNIQUE (user_id,request_key)
);
CREATE INDEX rental_office_ledger_contract ON rental_office_ledger(user_id,contract_id);
CREATE INDEX rental_office_ledger_day ON rental_office_ledger(user_id,recorded_at);

CREATE TABLE rental_office_costs (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id bigint REFERENCES devices(id) ON DELETE SET NULL,
    vehicle_name text NOT NULL,
    occurred_on date NOT NULL,
    category text NOT NULL CHECK (category IN ('wash','repair','fuel','insurance','other')),
    amount_krw bigint NOT NULL CHECK (amount_krw BETWEEN 1 AND 1000000000),
    vendor text NOT NULL DEFAULT '' CHECK (length(vendor)<=80),
    memo text NOT NULL DEFAULT '' CHECK (length(memo)<=500),
    revision bigint NOT NULL DEFAULT 1,
    request_key text NOT NULL,
    UNIQUE (user_id,request_key)
);
CREATE INDEX rental_office_costs_day ON rental_office_costs(user_id,occurred_on);

-- The existing return calculation bills whole minutes/hours/days before rounding
-- to hours/days/months. A returned contract uses the saved settlement instead.
CREATE FUNCTION rental_office_fee(
    state text, settled bigint, starts timestamptz, ends timestamptz, unit text, rate bigint
) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN state='cancelled' THEN 0 ELSE COALESCE(settled,
        rate::numeric * GREATEST(1, CASE unit
            WHEN 'hourly' THEN ceiling(floor(extract(epoch FROM ends-starts)/60)/60)
            WHEN 'monthly' THEN ceiling(floor(extract(epoch FROM ends-starts)/86400)/30)
            ELSE ceiling(floor(extract(epoch FROM ends-starts)/3600)/24) END)) END
$$;
