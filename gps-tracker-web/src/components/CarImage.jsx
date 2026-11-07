import { useEffect, useState } from 'react';
import { api } from '../api';

export default function CarImage({ deviceId, vehicleId, version, alt = '', fallback = null }) {
  const [source, setSource] = useState(null);
  useEffect(() => {
    setSource(null);
    if (!version) return;
    const controller = new AbortController();
    let url;
    (vehicleId ? api.getFleetPhoto(vehicleId,{signal:controller.signal}) : api.getCarImage(deviceId, { signal: controller.signal })).then(blob => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob); setSource(url);
    }).catch(() => {});
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [deviceId, vehicleId, version]);
  return source ? <img src={source} alt={alt} /> : fallback;
}
