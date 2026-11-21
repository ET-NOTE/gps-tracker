WITH period AS (
    SELECT $2::date::timestamp AT TIME ZONE 'Asia/Seoul' AS lo,
           ($3::date+1)::timestamp AT TIME ZONE 'Asia/Seoul' AS hi
), entries AS (
    SELECT l.id,l.contract_id,l.kind,l.method,l.amount_krw,l.recorded_at,l.memo,
           c.renter_name,c.vehicle_id,c.device_id
    FROM rental_office_ledger l JOIN rental_contracts c ON c.id=l.contract_id AND c.user_id=l.user_id
    CROSS JOIN period p
    WHERE l.user_id=$1 AND l.recorded_at>=p.lo AND l.recorded_at<p.hi
), contracts AS (
    SELECT c.id,c.vehicle_id,c.device_id,c.renter_name,c.renter_phone,c.starts_at,c.ends_at,c.returned_at,c.status,
           c.pickup_location,c.return_location,c.deposit_krw,c.rental_terms->>'requested_model' AS requested_model,
           c.rental_terms->'customer_id' AS customer_id,
           coalesce(nullif(a.plate,''),nullif(a.display_name,'')) AS vehicle_name,
           CASE WHEN c.cancellation_request_key IS NOT NULL THEN c.rental_terms->>'cancel_outcome' END AS cancel_outcome,
           CASE WHEN c.cancellation_request_key IS NOT NULL THEN (c.rental_terms->>'cancellation_fee_krw')::bigint END AS cancellation_fee_krw,
           c.settlement_request_key IS NOT NULL AS settlement_finalized,
           rental_office_contract_fee(c) AS billed_krw,
           balances.paid_krw,balances.held_krw
    FROM rental_contracts c CROSS JOIN period p
    LEFT JOIN rental_asset_directory a ON a.vehicle_id=c.vehicle_id AND a.owner_id=c.user_id
    CROSS JOIN LATERAL (
        SELECT coalesce(sum(CASE kind WHEN 'payment' THEN amount_krw WHEN 'refund' THEN -amount_krw ELSE 0 END),0) AS paid_krw,
               coalesce(sum(CASE kind WHEN 'deposit_in' THEN amount_krw WHEN 'deposit_out' THEN -amount_krw ELSE 0 END),0) AS held_krw
        FROM rental_office_ledger WHERE user_id=$1 AND contract_id=c.id
    ) balances
    WHERE c.user_id=$1 AND ((c.starts_at<p.hi AND greatest(c.ends_at,coalesce(c.returned_at,c.ends_at),
        CASE WHEN c.status IN ('active','overdue') THEN current_timestamp ELSE c.ends_at END)>p.lo)
        OR c.id IN (SELECT contract_id FROM entries)
        OR (c.cancellation_request_key IS NOT NULL AND c.updated_at>=p.lo AND c.updated_at<p.hi))
), costs AS (
    SELECT id,vehicle_id,device_id,vehicle_name,occurred_on,category,amount_krw,vendor,memo,revision
    FROM rental_office_costs WHERE user_id=$1 AND occurred_on BETWEEN $2 AND $3
)
SELECT jsonb_build_object(
    'company_name',(SELECT company_name FROM corporate_info WHERE user_id=$1),
    'contracts',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY starts_at DESC,id DESC) FROM contracts c),'[]'),
    'entries',coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY recorded_at DESC,id DESC) FROM entries e),'[]'),
    'costs',coalesce((SELECT jsonb_agg(to_jsonb(k) ORDER BY occurred_on DESC,id DESC) FROM costs k),'[]'))
