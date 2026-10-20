import { useEffect, useRef, useState } from 'react';
import { loadKakaoMaps } from '../../lib/kakaoSdk';
import { validPosition } from '../../lib/businessWorkspace';
import { vehicleName } from '../../lib/business';
import { classifyDevice } from '../../colors';

// A small independent map; the home map's route playback and camera are untouched.
export default function BusinessMap({ devices = [], onSelect }) {
  const container = useRef(null), map = useRef(null), select = useRef(onSelect);
  const fitted = useRef('');
  const [ready, setReady] = useState(false), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  select.current = onSelect;
  const located = devices.filter(validPosition);
  const hasPositions = located.length > 0;
  useEffect(() => {
    if (!hasPositions) return;
    let disposed = false, observer;
    setError(false);
    loadKakaoMaps().then(() => {
      if (disposed || !container.current) return;
      const sdk = window.kakao.maps;
      map.current = new sdk.Map(container.current, { center: new sdk.LatLng(36.5, 127.5), level: 12 });
      observer = new ResizeObserver(() => { if (map.current) { const center = map.current.getCenter(); map.current.relayout(); map.current.setCenter(center); } });
      observer.observe(container.current);
      setReady(true);
    }).catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; observer?.disconnect(); map.current = null; fitted.current = ''; setReady(false); };
  }, [hasPositions, retry]);
  useEffect(() => {
    if (!ready || !map.current) return;
    const sdk = window.kakao.maps, bounds = new sdk.LatLngBounds();
    const markers = located.map(device => {
      const position = new sdk.LatLng(Number(device.last_lat), Number(device.last_lng));
      bounds.extend(position);
      const button = document.createElement(select.current ? 'button' : 'span');
      button.className = 'business-map-pin';
      button.type = 'button';
      button.textContent = vehicleName(device);
      button.setAttribute('aria-label', `${vehicleName(device)} 차량 상세`);
      const status = classifyDevice(device);
      button.title = `${vehicleName(device)} · ${status.label} · 마지막 수신 위치`;
      button.style.borderColor = status.color;
      button.onclick = () => select.current?.(device);
      return new sdk.CustomOverlay({ position, content: button, map: map.current, yAnchor: 1 });
    });
    const key = located.map(d => d.id).sort().join(',');
    if (key && key !== fitted.current) {
      if (located.length === 1) { map.current.setCenter(bounds.getSouthWest()); map.current.setLevel(5); }
      else map.current.setBounds(bounds, 55, 65, 45, 65);
      fitted.current = key;
    }
    return () => markers.forEach(marker => marker.setMap(null));
  }, [devices, ready]);
  return <div className="business-map-wrap">
    <div className="business-map-canvas" ref={container} aria-label="차량의 마지막 수신 위치 지도" />
    {(!hasPositions || !ready || error) && <div className="business-map-placeholder" role="status">
      {!hasPositions ? '아직 위치가 수신된 차량이 없습니다.' : error ? <>지도를 불러오지 못했습니다.<button className="business-button" onClick={() => setRetry(v => v + 1)}>지도 다시 시도</button></> : '차량 지도를 불러오는 중…'}
    </div>}
  </div>;
}
