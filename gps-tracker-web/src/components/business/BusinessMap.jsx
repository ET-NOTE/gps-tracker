import { useEffect, useRef, useState } from 'react';
import { loadKakaoMaps } from '../../lib/kakaoSdk';
import { validPosition } from '../../lib/businessWorkspace';
import { vehicleName } from '../../lib/business';
import { classifyDevice } from '../../colors';
import { groupMapPositions, terminalName } from '../../lib/corporateOverview';
import Icon from '../Icon';

function fitVehicles(map, positions, sdk) {
  if (!map || !positions.length) return;
  if (positions.length === 1) {
    map.setLevel(5);
    map.setCenter(positions[0]);
    return;
  }
  const bounds = new sdk.LatLngBounds();
  positions.forEach(position => bounds.extend(position));
  map.setBounds(bounds, 55, 75, 45, 75);
}

export default function BusinessMap({ devices = [], onSelect, selectedId, controls }) {
  const container = useRef(null), map = useRef(null), select = useRef(onSelect), fitted = useRef('');
  const [ready, setReady] = useState(false), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  const [view, setView] = useState(0), [groupIds, setGroupIds] = useState([]);
  select.current = onSelect;
  const located = devices.filter(validPosition), hasPositions = located.length > 0;
  useEffect(() => {
    if (!hasPositions) return;
    let disposed = false, observer, instance, idle, sdk;
    setError(false);
    loadKakaoMaps().then(kakao => {
      if (disposed || !container.current) return;
      sdk = kakao.maps;
      instance = new sdk.Map(container.current, { center: new sdk.LatLng(36.5, 127.5), level: 12 });
      map.current = instance;
      idle = () => { if (!disposed) setView(v => v + 1); };
      sdk.event.addListener(instance, 'idle', idle);
      observer = new ResizeObserver(() => { if (map.current) { const center = map.current.getCenter(); map.current.relayout(); map.current.setCenter(center); idle(); } });
      observer.observe(container.current);
      setReady(true);
    }).catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; observer?.disconnect(); if(instance && idle) sdk.event.removeListener(instance,'idle',idle); map.current = null; fitted.current = ''; setReady(false); };
  }, [hasPositions, retry]);
  useEffect(() => {
    if (!ready || !map.current) return;
    const sdk = window.kakao.maps, projection = map.current.getProjection();
    const items = located.map(device => {
      const position = new sdk.LatLng(Number(device.last_lat), Number(device.last_lng));
      const pixel = projection.containerPointFromCoords(position);
      return { device, position, x: pixel.x, y: pixel.y };
    });
    const groups = groupMapPositions(items);
    const markers = groups.map(group => {
      const active = group.items.some(({device}) => String(device.id) === String(selectedId));
      const device = group.items.find(({device})=>String(device.id)===String(selectedId))?.device || group.items[0].device;
      const multiple = group.items.length > 1;
      const button = document.createElement(select.current ? 'button' : 'span');
      button.className = `business-map-pin${multiple ? ' is-cluster' : ''}${active ? ' is-selected' : ''}`;
      button.type = 'button';
      button.textContent = multiple ? `${group.items.length}대${active ? ' · 선택됨' : ''}` : vehicleName(device);
      button.setAttribute('aria-label', multiple ? `같은 위치 주변 차량 ${group.items.length}대 선택` : `${vehicleName(device)} · ${terminalName(device)} 선택`);
      button.title = multiple ? group.items.map(i=>terminalName(i.device)).join(', ') : `${vehicleName(device)} · ${classifyDevice(device).label} · 마지막 수신 위치`;
      if (!active && !multiple) button.style.borderColor = classifyDevice(device).color;
      button.onclick = () => { if (multiple) setGroupIds(group.items.map(i=>String(i.device.id))); else { setGroupIds([]); select.current?.(device); } };
      return new sdk.CustomOverlay({ position: group.items[0].position, content: button, map: map.current, yAnchor: 1, zIndex: active ? 5 : 1 });
    });
    const key = located.map(d => d.id).sort().join(',');
    if (key && key !== fitted.current) {
      fitted.current = key;
      fitVehicles(map.current, items.map(item => item.position), sdk);
    }
    return () => markers.forEach(marker => marker.setMap(null));
  }, [devices, ready, view, selectedId]);
  useEffect(() => {
    const device = devices.find(d=>String(d.id) === String(selectedId));
    if (ready && map.current && device && validPosition(device)) map.current.panTo(new window.kakao.maps.LatLng(Number(device.last_lat),Number(device.last_lng)));
  }, [selectedId, ready]); // A snapshot refresh must not reset a manually moved camera.
  const choices = devices.filter(d=>groupIds.includes(String(d.id)));
  const level = controls && ready && hasPositions ? map.current?.getLevel() : null;
  function zoomBy(delta) {
    const instance = map.current;
    if (instance) instance.setLevel(Math.max(1, Math.min(14, instance.getLevel() + delta)));
  }
  function resetView() {
    const sdk = window.kakao?.maps;
    if (!sdk || !map.current) return;
    const positions = located.map(device => new sdk.LatLng(Number(device.last_lat), Number(device.last_lng)));
    fitVehicles(map.current, positions, sdk);
  }
  return <div className="business-map-wrap">
    <div className="business-map-canvas" ref={container} aria-label="차량의 마지막 수신 위치 지도" />
    {(!hasPositions || !ready || error) && <div className="business-map-placeholder" role="status">
      {!hasPositions ? (devices.some(d=>d.subject_scope==='confirmed-subject-intervals')?'확인된 구간에 표시할 위치가 없습니다.':'아직 위치가 수신된 차량이 없습니다.') : error ? <>지도를 불러오지 못했습니다.<button className="business-button" onClick={() => setRetry(v => v + 1)}>지도 다시 시도</button></> : '차량 지도를 불러오는 중…'}
    </div>}
    {level!=null && <div className={'fleet-map-controls'+(controls==='compact'?' is-compact':'')} role="group" aria-label="지도 보기 조절">
      <div className="fleet-map-zoom">
        <button type="button" aria-label="지도 확대" title="지도 확대" disabled={level<=1} onClick={()=>zoomBy(-1)}><Icon name="plus" size={17}/></button>
        <button type="button" aria-label="지도 축소" title="지도 축소" disabled={level>=14} onClick={()=>zoomBy(1)}><span className="fleet-map-minus" /></button>
      </div>
      <output aria-label="지도 확대 단계">{level}단계</output>
      <button type="button" className="fleet-map-fit" aria-label="지도 전체 보기" title="지도 전체 보기" onClick={resetView}><Icon name="target" size={17}/></button>
    </div>}
    {choices.length > 0 && <div className="business-map-choices" role="group" aria-label="주변 차량 선택"><div><strong>주변 차량 {choices.length}대</strong><button className="business-button" onClick={()=>setGroupIds([])} aria-label="주변 차량 목록 닫기">닫기</button></div>{choices.map(d=><button className="business-button" key={d.id} onClick={()=>{setGroupIds([]);select.current?.(d);}}>{vehicleName(d)}<small>{terminalName(d)}</small></button>)}</div>}
  </div>;
}
