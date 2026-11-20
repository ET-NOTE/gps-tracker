SELECT jsonb_build_object(
  'branch',b.name,'group',g.name,'permissions',g.permissions,
  'contracts',CASE WHEN 'dispatch_read'=ANY(g.permissions) THEN (
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.starts_at DESC,x.id DESC),'[]') FROM (
      SELECT c.id,c.renter_name,c.starts_at,c.ends_at,c.status,d.license_plate,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('body',n.body,'created_at',n.created_at) ORDER BY n.id DESC),'[]')
         FROM rental_handover_notes n WHERE n.branch_id=b.id AND n.contract_id=c.id) notes
      FROM rental_contracts c LEFT JOIN gps_read_devices d ON d.id=c.device_id AND d.owner_id=c.user_id
      WHERE c.user_id=t.owner_id AND b.name IN(c.pickup_location,c.return_location)
      ORDER BY c.starts_at DESC,c.id DESC LIMIT 200) x) ELSE '[]'::jsonb END,
  'work',CASE WHEN 'service_read'=ANY(g.permissions) THEN (
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.starts_at DESC,x.id DESC),'[]') FROM (
      SELECT w.id,w.kind,w.starts_at,w.ends_at,w.closed_at,d.license_plate FROM rental_fleet_work w
      JOIN rental_vehicle_profile p ON p.owner_id=w.owner_id AND p.device_id=w.device_id AND p.branch=b.name
      JOIN gps_read_devices d ON d.id=w.device_id AND d.owner_id=w.owner_id
      WHERE w.owner_id=t.owner_id ORDER BY w.starts_at DESC,w.id DESC LIMIT 200) x) ELSE '[]'::jsonb END)
FROM rental_staff t JOIN rental_branches b ON b.id=t.branch_id JOIN rental_staff_groups g ON g.id=t.group_id
JOIN users o ON o.id=t.owner_id AND o.account_type='rentcar'
WHERE t.account_id=$1 AND t.owner_id=$2 AND t.active
