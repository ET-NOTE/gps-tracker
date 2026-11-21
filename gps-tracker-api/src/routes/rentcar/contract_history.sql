-- Evaluate scope and fetch the timeline in the same snapshot. A staff login only
-- inherits its own active branch and explicitly assigned dispatch/service rights.
WITH access AS (
    SELECT c.id, c.user_id=$1 AS is_owner,
           c.user_id=$1 OR 'service_read'=ANY(g.permissions) AS service_read
    FROM rental_contracts c
    JOIN users o ON o.id=c.user_id AND gps_owner_service(o,'rentcar')
    LEFT JOIN rental_staff t ON t.owner_id=c.user_id AND t.account_id=$1 AND t.active
    LEFT JOIN rental_staff_groups g ON g.owner_id=t.owner_id AND g.id=t.group_id
    LEFT JOIN rental_branches b ON b.owner_id=t.owner_id AND b.id=t.branch_id
    WHERE c.id=$2 AND (c.user_id=$1 OR
        ('dispatch_read'=ANY(g.permissions) AND b.name IN(c.pickup_location,c.return_location)))
)
SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',e.id,'event_kind',e.event_kind,'occurred_at',e.occurred_at,
    'summary',CASE e.event_kind
        WHEN 'created' THEN '예약·계약 등록'
        WHEN 'assigned' THEN '차량 배정'
        WHEN 'unassigned' THEN '차량 배정 해제'
        WHEN 'updated' THEN '예약 조건 변경'
        WHEN 'extended' THEN '대여 기간 연장 · ' ||
            to_char(e.ends_before AT TIME ZONE 'Asia/Seoul','YYYY.MM.DD HH24:MI') || ' → ' ||
            to_char(e.ends_after AT TIME ZONE 'Asia/Seoul','YYYY.MM.DD HH24:MI')
        WHEN 'reviewed' THEN '계약 조건 확인 완료'
        WHEN 'review_revoked' THEN '계약 재확인 필요'
        WHEN 'license_checked' THEN '실운전자 면허 확인'
        WHEN 'license_revoked' THEN '실운전자 면허 재확인 필요'
        WHEN 'activated' THEN '계약 이용 시작'
        WHEN 'checkout' THEN '차량 인도 완료'
        WHEN 'returned' THEN '차량 반납 처리'
        WHEN 'settled' THEN '대여료 정산 완료'
        WHEN 'cancelled' THEN '예약·계약 취소'
        WHEN 'no_show' THEN '고객 미방문 처리'
        WHEN 'overdue' THEN '반납 예정 시각 경과'
        WHEN 'payment' THEN '대여료 수납'
        WHEN 'refund' THEN '대여료 환불'
        WHEN 'deposit_in' THEN '보증금 수납'
        WHEN 'deposit_out' THEN '보증금 반환'
        WHEN 'incident_opened' THEN '사고·고장 접수'
        WHEN 'incident_closed' THEN '사고·고장 처리 완료'
        WHEN 'inspection_released' THEN '차량 점검 해제'
        WHEN 'return_inspection_closed' THEN '반납 차량 점검 완료'
    END
) ORDER BY e.occurred_at DESC,e.id DESC) FILTER (WHERE e.id IS NOT NULL),'[]'::jsonb)
FROM access a LEFT JOIN rental_contract_events e ON e.contract_id=a.id
    AND (a.is_owner OR e.event_kind NOT IN ('settled','payment','refund','deposit_in','deposit_out'))
    AND (a.service_read OR e.event_kind NOT IN ('incident_opened','incident_closed','inspection_released','return_inspection_closed'))
GROUP BY a.id;
