import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FIX_STALE_THRESHOLD_MS } from '../../colors';
import { validPosition } from '../../lib/businessWorkspace';
import { terminalName } from '../../lib/corporateOverview';
import { useVisibleNow } from '../../hooks/useVisibleNow';
import Icon from '../Icon';
import DeviceReadingTime from './DeviceReadingTime';

function DeviceMapMarker({ map, device, selected, now, onSelect }) {
  const [host] = useState(() => {
    const element = document.createElement('div');
    element.className = 'pt-location-anchor';
    return element;
  });
  const overlay = useRef(null);
  const lat = Number(device.last_lat), lng = Number(device.last_lng);
  useLayoutEffect(() => {
    const layer = new window.kakao.maps.CustomOverlay({ content:host, xAnchor:.5, yAnchor:.5, clickable:true });
    overlay.current = layer;
    return () => { layer.setMap(null); overlay.current = null; };
  }, [host]);
  useLayoutEffect(() => {
    overlay.current.setPosition(new window.kakao.maps.LatLng(lat, lng));
    overlay.current.setMap(map);
  }, [map, lat, lng]);
  useLayoutEffect(() => { overlay.current.setZIndex(selected ? 210 : 205); }, [selected]);

  const stamp = Date.parse(device.last_fix_at);
  const lastKnown = !Number.isFinite(stamp) || now - stamp > FIX_STALE_THRESHOLD_MS;
  const label = terminalName(device);
  const icon = device.portalServices?.includes('delivery') ? 'truck' : device.portalServices?.length ? 'car' : 'mapPin';
  return createPortal(<button type="button" className={'pt-location-marker' + (lastKnown ? ' is-last-known' : '')}
    aria-label={label + ' 마지막 수신 위치 선택'} aria-pressed={selected} onClick={() => onSelect(device.id)}>
    <span className="pt-location-symbol"><Icon name={icon} size={selected ? 18 : 15}/></span>
    {selected && <span className="pt-location-caption"><strong>{label}</strong>{lastKnown &&
      <small>마지막 수신 · {Number.isFinite(stamp) ? <DeviceReadingTime value={device.last_fix_at} shortFor={now}/> : '시각 미수신'}</small>}</span>}
  </button>, host);
}

export default function DeviceMapMarkers({ map, devices, selectedId, onSelect }) {
  const now = useVisibleNow(true, 60000);
  return devices.filter(validPosition).map(device =>
    <DeviceMapMarker key={device.id} map={map} device={device} selected={device.id === selectedId} now={now} onSelect={onSelect}/>);
}
