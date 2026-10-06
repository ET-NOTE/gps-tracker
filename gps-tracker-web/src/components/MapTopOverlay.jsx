import DeviceFilter from './DeviceFilter';
import MapControls from './MapControls';
import { liveMotion } from '../lib/liveMotion';
import { useVisibleNow } from '../hooks/useVisibleNow';
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
  showSpeed, liveSpeed, now, historyMode = false, cachedSources = {}, children }) {
  const clock = useVisibleNow(now == null && showSpeed && selected != null);
  now = now ?? clock;
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
      {devices.length > 0 && <div className="map-device-card">
        <DeviceFilter devices={devices} selected={selected} onChange={onSelect} integrated />
        {showSpeed && device ? <div className="map-live-summary" aria-label="실시간 운행 정보">
          <div className="map-live-reading">
            <strong>{motion.speedKmh == null ? '--' : Math.round(motion.speedKmh)}</strong>
            <span>km/h · 추정</span>
          </div>
          <div className="map-live-context">
            <span className="map-live-state" data-moving={motion.moving}>{motion.label}</span>
            <span className="map-live-age">{ageText ? `위치 ${ageText}` : '위치 수신 전'}</span>
          </div>
        </div> : device && <div className="map-view-mode">{historyMode ? '이동 기록 조회 중' : '지도 탐색 중 · 자동 추적 꺼짐'}</div>}
        {device?.license_plate && <div className="map-live-plate">{device.license_plate}</div>}
      </div>}
      {notice && <div className="map-cache-notice" role="status">{notice}</div>}
      {children}
    </div>
    <MapControls mapRef={mapRef} onOpenRoadview={onOpenRoadview} />
  </div>;
}
