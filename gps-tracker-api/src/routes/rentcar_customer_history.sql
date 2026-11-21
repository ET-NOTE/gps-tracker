, matches AS (
    SELECT id,starts_at,
           CASE WHEN customer_id=$2 AND driver_id=$2 THEN 'both'
                WHEN customer_id=$2 THEN 'customer' ELSE 'driver' END AS role
    FROM contract_parties WHERE customer_id=$2 OR driver_id=$2
), page AS (
    SELECT * FROM matches
    WHERE $3::timestamptz IS NULL OR (starts_at,id)<($3,$4::bigint)
    ORDER BY starts_at DESC,id DESC LIMIT ($5::bigint+1)
), shown AS (
    SELECT p.id,p.role,p.starts_at,c.ends_at,c.returned_at,c.status,c.renter_name,
           c.rental_terms->>'driver_name' AS driver_name,nullif(a.plate,'') AS license_plate,
           nullif(a.display_name,'') AS vehicle_name,c.rental_terms->>'requested_model' AS requested_model,
           c.pickup_location,c.return_location,c.settled_at
    FROM (SELECT * FROM page ORDER BY starts_at DESC,id DESC LIMIT $5) p
    JOIN rental_contracts c ON c.id=p.id AND c.user_id=$1
    LEFT JOIN rental_asset_directory a ON a.vehicle_id=c.vehicle_id AND a.owner_id=c.user_id
)
SELECT jsonb_build_object(
    'total',(SELECT count(*) FROM matches),
    'items',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.starts_at DESC,s.id DESC) FROM shown s),'[]'),
    'next_cursor',CASE WHEN (SELECT count(*) FROM page)>$5 THEN (
        SELECT to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || id
        FROM shown ORDER BY starts_at,id LIMIT 1
    ) END
)
FROM customers WHERE id=$2
