SELECT jsonb_build_object('id',c.id,'key',c.metric_key,'label',c.label,'unit',c.unit,'sensor_set',c.sensor_set,
 'active',c.sensor_set=d.active_sensor_set,
 'latest',(SELECT jsonb_build_object('value',(values_json->>c.id::text)::double precision,'at',measured_at) FROM readings r
   WHERE r.device_id=c.device_id AND r.user_id=$2 AND values_json ? c.id::text ORDER BY recorded_at DESC,id DESC LIMIT 1),
 'stats',(SELECT jsonb_build_object('min',min((values_json->>c.id::text)::double precision),'max',max((values_json->>c.id::text)::double precision),'avg',avg((values_json->>c.id::text)::double precision))
   FROM readings r WHERE r.device_id=c.device_id AND r.user_id=$2 AND recorded_at>=$3 AND recorded_at<$4 AND values_json ? c.id::text),
 'chart',COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY at) FROM (
    SELECT date_bin(interval '5 minutes',recorded_at,'2000-01-01'::timestamptz) at,avg((values_json->>c.id::text)::double precision) value
    FROM readings r WHERE r.device_id=c.device_id AND r.user_id=$2 AND recorded_at>=$3 AND recorded_at<$4 AND values_json ? c.id::text GROUP BY 1
 ) b),'[]'::jsonb))
FROM sensor_channels c JOIN devices d ON d.id=c.device_id WHERE d.id=$1 AND d.owner_id=$2 ORDER BY c.id
