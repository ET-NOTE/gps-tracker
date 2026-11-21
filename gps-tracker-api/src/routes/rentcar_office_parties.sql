WITH customers AS (
    SELECT id,(details->>'account_id')::bigint AS account_id,
           regexp_replace(details->>'phone','[^0-9]','','g') AS phone
    FROM rental_office_catalog WHERE user_id=$1 AND kind='customers'
), contract_parties AS (
    SELECT c AS rental,c.id,c.starts_at,
           coalesce((c.rental_terms->>'customer_id')::bigint,matched.id) AS customer_id,
           (c.rental_terms->>'driver_id')::bigint AS driver_id
    FROM rental_contracts c
    LEFT JOIN customers matched ON c.rental_terms->>'customer_id' IS NULL
       AND matched.phone=regexp_replace(c.renter_phone,'[^0-9]','','g')
    WHERE c.user_id=$1
)
