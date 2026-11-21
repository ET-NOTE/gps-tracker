export function rentalInventory(assets, devices) {
  const terminals = new Map(devices.map(device => [device.id, device]));
  return assets.map(asset => {
    const terminal = terminals.get(asset.device_id);
    return {
      ...terminal, ...asset,
      vehicle_id: asset.id,
      terminal,
      car_model: asset.model || terminal?.car_model || '',
      license_plate: asset.plate || terminal?.license_plate || terminal?.car_plate || '',
      car_plate: asset.plate || terminal?.car_plate || terminal?.license_plate || '',
      display_name: asset.display_name || asset.model || terminal?.display_name || '',
      rental_profile: asset,
    };
  });
}

export const isAssigned = contract => contract.vehicle_id != null || contract.device_id != null;
export function matchesVehicle(record, vehicle) {
  if (!record || !vehicle) return false;
  if (record.vehicle_id != null && vehicle.vehicle_id != null) return String(record.vehicle_id)===String(vehicle.vehicle_id);
  const deviceId = vehicle.vehicle_id != null ? vehicle.device_id : vehicle.id;
  return record.device_id != null && deviceId != null && String(record.device_id) === String(deviceId);
}
export const agreedPrice = contract => contract?.rental_terms?.pricing?.mode === 'agreed' ? contract.rental_terms.pricing : null;
export const priceTotal = p => Number(p.base_krw)+Number(p.option_krw||0)-Number(p.discount_krw||0)+Number(p.extension_krw||0)+Number(p.return_extra_krw||0);
