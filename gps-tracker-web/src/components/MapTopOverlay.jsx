import DeviceFilter from './DeviceFilter';
import MapControls from './MapControls';
import { getDeviceColor } from '../colors';
import { liveMotion } from '../lib/liveMotion';
import './MapTopOverlay.css';

export function mapCacheNotice(sources, selected) {
  const cachedPath = selected == null
    ? Object.entries(sources).some(([key, cached]) => key !== 'devices' && cached)
    : sources[selected];
  if (sources.devices && cachedPath) return '연결 지연 · 단말기 정보와 이전 경로는 저장본입니다.';
  if (sources.devices) return '연결 지연 · 단말기 목록은 저장된 정보입니다.';
  if (cachedPath) return '이전 경로 일부는 저장본입니다. 연결되면 다시 불러옵니다.';
  return null;
}

export default function MapTopOverlay({ devices, selected, onSelect, mapRef, onOpenRoadview,
  showSpeed, liveSpeed, now, cachedSources = {}, children }) {
  const device = devices.find(d => d.id === selected);
  // A device change must never briefly display the previous device's speed/name.
  const sample = liveSpeed?.deviceId === selected ? liveSpeed : null;
  const lastAt = sample?.recordedAt || device?.last_fix_at || device?.last_seen_at;
  const motion = liveMotion(sample?.speedKmh, lastAt, now);
  const notice = mapCacheNotice(cachedSources, selected);
  const ageMs = lastAt ? now - Date.parse(lastAt) : NaN;
  const ageText = !Number.isFinite(ageMs) ? null : ageMs < 60_000 ? '방금'
    : ageMs < 3600_000 ? `${Math.floor(ageMs / 60_000)}분 전`
    : ageMs < 86400_000 ? `${Math.floor(ageMs / 3600_000)}시간 전` : `${Math.floor(ageMs / 86400_000)}일 전`;
  return <div className="map-top-overlay">
    <div className="map-top-main">
      {devices.length > 0 && <DeviceFilter devices={devices} selected={selected} onChange={onSelect} />}
      {showSpeed && device && <div className="map-live-summary" aria-label="실시간 운행 정보">
        <span className="map-live-dot" style={{ background: getDeviceColor(device) }} />
        <div className="map-live-details">
          <div className="map-live-heading">
            <span className="map-live-name" title={device.display_name || device.device_uid}>{device.display_name || device.device_uid}</span>
            <span className="map-live-state" data-moving={motion.moving}>{motion.label}</span>
          </div>
          {device.license_plate && <span className="map-live-plate">{device.license_plate}</span>}
          <div className="map-live-reading">
            <strong>{motion.speedKmh == null ? '--' : Math.round(motion.speedKmh)}</strong>
            <span>km/h · 추정</span>
            {ageText && <span className="map-live-age">{ageText}</span>}
          </div>
        </div>
      </div>}
      {notice && <div className="map-cache-notice" role="status">{notice}</div>}
      {children}
    </div>
    <MapControls mapRef={mapRef} onOpenRoadview={onOpenRoadview} />
  </div>;
}
