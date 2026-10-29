export function projectFleetAssets(assets=[],devices=[]) {
  return assets.map(asset=>{
    const primary=asset.bindings.find(b=>b.is_primary),sim=devices.find(d=>d.id===primary?.device_id);
    const telemetry={...sim};
    if(primary && !(Date.parse(sim?.last_fix_at)>=Date.parse(primary.started_at))) {
      for(const key of ['last_lat','last_lng','last_fix_at'])telemetry[key]=null;
    }
    return {...telemetry,...asset.profile,id:asset.id,fleet_vehicle_id:asset.id,source_device_id:sim?.id,
      vehicle_name:asset.name,car_model:asset.car_model,car_plate:asset.license_plate,license_plate:asset.license_plate,
      display_name:sim?.display_name||sim?.device_uid||'단말기 미연결',device_uid:sim?.device_uid||'',
      department:asset.department,enabled:asset.enabled,created_at:asset.created_at,asset};
  });
}
