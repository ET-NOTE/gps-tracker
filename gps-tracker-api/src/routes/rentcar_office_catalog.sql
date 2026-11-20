WITH masters AS (
    SELECT * FROM rental_office_catalog WHERE user_id=$1
), customers AS (
    SELECT id,(details->>'account_id')::bigint AS account_id,
           regexp_replace(details->>'phone','[^0-9]','','g') AS phone FROM masters WHERE kind='customers'
), payments AS (
    SELECT contract_id,sum(CASE kind WHEN 'payment' THEN amount_krw WHEN 'refund' THEN -amount_krw ELSE 0 END) AS paid
    FROM rental_office_ledger WHERE user_id=$1 GROUP BY contract_id
), contracts AS (
    SELECT c.id, coalesce((c.rental_terms->>'customer_id')::bigint,matched.id) AS customer_id,
           (c.rental_terms->>'driver_id')::bigint AS driver_id,
           greatest(0,rental_office_fee(c.status,c.settled_amount_krw,c.starts_at,c.ends_at,c.rate_type,c.rate_amount_krw)
             -coalesce(p.paid,0)) AS outstanding
    FROM rental_contracts c LEFT JOIN payments p ON p.contract_id=c.id
    LEFT JOIN customers matched ON c.rental_terms->>'customer_id' IS NULL
       AND matched.phone=regexp_replace(c.renter_phone,'[^0-9]','','g')
    WHERE c.user_id=$1
), counts AS (
    SELECT id,count(*) AS total FROM (
        SELECT id AS contract,customer_id AS id FROM contracts
        UNION SELECT id, driver_id FROM contracts
    ) x WHERE id IS NOT NULL GROUP BY id
), accounts AS (
    SELECT c.account_id,count(DISTINCT c.id) AS customers,coalesce(sum(t.outstanding),0) AS outstanding
    FROM customers c LEFT JOIN contracts t ON t.customer_id=c.id GROUP BY c.account_id
), cars AS (
    SELECT coalesce(nullif(trim(p.class_name),''),nullif(trim(d.car_model),''),'차종 미지정') AS name,count(*) AS total
    FROM gps_read_devices d LEFT JOIN rental_vehicle_profile p ON p.device_id=d.id AND p.owner_id=d.owner_id
    WHERE d.owner_id=$1 GROUP BY 1
), sections AS (
    SELECT m.kind,jsonb_agg(m.details || jsonb_build_object('id',m.id,'name',m.name,'active',m.active,'revision',m.revision)
        || CASE m.kind WHEN 'customers' THEN jsonb_build_object('contracts_count',coalesce(n.total,0))
                       WHEN 'accounts' THEN jsonb_build_object('customers_count',coalesce(a.customers,0),
                         'outstanding_krw',coalesce(a.outstanding,0))
                       WHEN 'rates' THEN jsonb_build_object('vehicles_count',coalesce(v.total,0))
                       ELSE '{}'::jsonb END ORDER BY m.active DESC,m.name,m.id) AS rows
    FROM masters m LEFT JOIN counts n ON n.id=m.id AND m.kind='customers'
    LEFT JOIN accounts a ON a.account_id=m.id AND m.kind='accounts'
    LEFT JOIN cars v ON v.name=m.name AND m.kind='rates' GROUP BY m.kind
)
SELECT coalesce(jsonb_object_agg(kind,rows),'{}') FROM sections
