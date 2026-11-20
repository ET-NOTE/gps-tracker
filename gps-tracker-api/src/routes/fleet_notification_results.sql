WITH policy AS (
    SELECT coalesce((SELECT settings FROM fleet_notification_policy WHERE owner_id=$1),'{}'::jsonb) AS flags
), notices AS (
    SELECT 'reservation' AS category, a.id, a.created_at AS occurred_at, a.after_value->>'status' AS status,
           r.fleet_vehicle_id AS vehicle_id
    FROM gps_read_fleet_team_audit a
    JOIN vehicle_reservations r ON r.id=a.target_id AND r.user_id=a.owner_id
    CROSS JOIN policy
    WHERE a.owner_id=$1 AND a.action='reservation_review' AND r.fleet_vehicle_id=ANY($2)
      AND a.created_at>=now()-interval '7 days' AND coalesce((flags->>'reservation')::boolean,true)
      AND ($3 OR r.driver_staff_id=$4 OR r.submitted_by=$7 OR ($6 AND EXISTS
          (SELECT 1 FROM staff s WHERE s.user_id=$1 AND s.id=r.driver_staff_id AND s.department_id=$5)))
    UNION ALL
    SELECT 'trip',r.id,r.updated_at,r.status,r.fleet_vehicle_id
    FROM vehicle_reservations r CROSS JOIN policy
    WHERE r.user_id=$1 AND r.fleet_vehicle_id=ANY($2) AND r.status IN ('in_progress','completed')
      AND r.updated_at>=now()-interval '7 days' AND coalesce((flags->>'trip')::boolean,true)
      AND ($3 OR r.driver_staff_id=$4 OR r.submitted_by=$7 OR ($6 AND EXISTS
          (SELECT 1 FROM staff s WHERE s.user_id=$1 AND s.id=r.driver_staff_id AND s.department_id=$5)))
    UNION ALL
    SELECT 'expense',e.id,e.reviewed_at,e.status,e.vehicle_id
    FROM fleet_expenses e CROSS JOIN policy
    WHERE e.owner_id=$1 AND e.status IN ('approved','rejected') AND e.reviewed_at>=now()-interval '7 days'
      AND coalesce((flags->>'expense')::boolean,true)
      AND ($3 OR ((e.vehicle_id IS NULL OR e.vehicle_id=ANY($2)) AND (e.staff_id=$4 OR ($6 AND e.department_id=$5))))
)
SELECT jsonb_build_object('category',category,'id',id,'at',occurred_at,'status',status,'vehicle_id',vehicle_id)
FROM notices CROSS JOIN policy WHERE coalesce((flags->>'in_app')::boolean,true)
ORDER BY occurred_at DESC,category,id DESC LIMIT 40;
