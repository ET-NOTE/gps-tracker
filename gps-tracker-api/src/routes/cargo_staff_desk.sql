SELECT jsonb_build_object(
  'branch',b->>'name','group',g.name,'permissions',g.permissions,
  'shipments',CASE WHEN 'dispatch_read'=ANY(g.permissions) THEN
    (SELECT coalesce(jsonb_agg(jsonb_build_object('id',j->>'id','number',j->>'number','start',j->>'start','end',j->>'end','status',j->>'status',
      'notes',(SELECT coalesce(jsonb_agg(jsonb_build_object('body',n.body) ORDER BY n.id),'[]') FROM cargo_handover_notes n JOIN cargo_staff author ON author.id=n.staff_id WHERE author.owner_id=t.owner_id AND n.branch_id=t.branch_id AND n.shipment_id=j->>'id')) ORDER BY j->>'start' DESC),'[]')
     FROM jsonb_array_elements(w.data->'shipments') j WHERE j->>'branchId'=t.branch_id)
    ELSE '[]'::jsonb END,
  'vehicles',CASE WHEN 'fleet_read'=ANY(g.permissions) THEN
    (SELECT coalesce(jsonb_agg(jsonb_build_object('id',v->>'id','plate',v->>'plate','type',v->>'type','readiness',v->>'readiness') ORDER BY v->>'plate'),'[]')
     FROM jsonb_array_elements(w.data->'vehicles') v WHERE v->>'branchId'=t.branch_id)
    ELSE '[]'::jsonb END)
FROM cargo_staff t JOIN users o ON o.id=t.owner_id AND gps_owner_service(o,'delivery')
JOIN cargo_staff_groups g ON g.id=t.group_id AND g.owner_id=t.owner_id
JOIN cargo_workspaces w ON w.owner_id=t.owner_id
JOIN LATERAL jsonb_array_elements(w.data->'branches') b ON b->>'id'=t.branch_id AND coalesce((b->>'active')::boolean,true)
WHERE t.owner_id=$2 AND t.account_id=$1 AND t.active
