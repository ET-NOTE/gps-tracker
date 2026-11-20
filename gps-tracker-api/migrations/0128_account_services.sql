-- A null preference inherits the original account type, including on existing accounts.
ALTER TABLE users
    ADD COLUMN corporate_service_enabled boolean,
    ADD COLUMN rental_service_enabled boolean,
    ADD COLUMN cargo_service_enabled boolean,
    ADD COLUMN start_route text NOT NULL DEFAULT '/'
        CHECK (start_route IN ('/', 'last', '/corporate', '/rentcar', '/cargo'));

CREATE FUNCTION gps_owner_service(account_row users, service text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE service
        WHEN 'corporate_fleet' THEN COALESCE(account_row.corporate_service_enabled, account_row.account_type = service)
        WHEN 'rentcar' THEN COALESCE(account_row.rental_service_enabled, account_row.account_type = service)
        WHEN 'delivery' THEN COALESCE(account_row.cargo_service_enabled, account_row.account_type = service)
        ELSE false
    END
$$;
