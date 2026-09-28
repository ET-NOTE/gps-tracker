SELECT jsonb_build_object(
 'server_now',now(),
 'device',jsonb_build_object('id',d.id,'device_uid',d.device_uid,'display_name',d.display_name,'last_seen_at',d.last_seen_at),
 'latest',(SELECT to_jsonb(r) - 'user_id' - 'device_id' - 'message_id' FROM readings r WHERE r.device_id=d.id AND r.user_id=$2 ORDER BY recorded_at DESC,id DESC LIMIT 1),
 'temperature',(SELECT jsonb_build_object('value',temp_c,'measured_at',measured_at) FROM readings WHERE device_id=d.id AND user_id=$2 AND temp_c IS NOT NULL ORDER BY recorded_at DESC,id DESC LIMIT 1),
 'humidity',(SELECT jsonb_build_object('value',hum_pct,'measured_at',measured_at) FROM readings WHERE device_id=d.id AND user_id=$2 AND hum_pct IS NOT NULL ORDER BY recorded_at DESC,id DESC LIMIT 1),
 'position',(SELECT jsonb_build_object('recorded_at',recorded_at,'lat',lat,'lng',lng) FROM location_records WHERE device_id=d.id AND user_id=$2 AND fix ORDER BY recorded_at DESC LIMIT 1),
 'received_today',(SELECT count(*) FROM messages WHERE device_id=d.id AND user_id=$2 AND received_at>=date_trunc('day',now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'),
 'total',(SELECT count(*) FROM readings WHERE device_id=d.id AND user_id=$2 AND recorded_at>=$3 AND recorded_at<$4),
 'stats',(SELECT jsonb_build_object('temp_min',min(temp_c),'temp_avg',avg(temp_c),'temp_max',max(temp_c),'hum_min',min(hum_pct),'hum_avg',avg(hum_pct),'hum_max',max(hum_pct)) FROM readings WHERE device_id=d.id AND user_id=$2 AND recorded_at>=$3 AND recorded_at<$4),
 'chart',COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY at) FROM (
   SELECT date_bin(interval '5 minutes',recorded_at,'2000-01-01'::timestamptz) AS at,avg(temp_c) AS temp_c,avg(hum_pct) AS hum_pct,avg(pv_mv) AS pv_mv,count(*) AS samples
   FROM readings WHERE device_id=d.id AND user_id=$2 AND recorded_at>=$3 AND recorded_at<$4 GROUP BY 1
 ) b),'[]'::jsonb)
) FROM devices d WHERE d.id=$1 AND d.owner_id=$2
