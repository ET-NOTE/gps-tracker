import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import './MapActions.css';

export default function MapActions({ hasDevice, tracking, paused, miniOpen, bottom,
  onTracking, onMini, onTool }) {
  const [expanded, setExpanded] = useState(false);
  const root = useRef(null);
  useEffect(() => {
    if (!expanded) return;
    const outside = event => { if (!root.current?.contains(event.target)) setExpanded(false); };
    const escape = event => { if (event.key === 'Escape') setExpanded(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [expanded]);
  function open(tool) { setExpanded(false); onTool(tool); }
  const trackingLabel = !tracking ? '라이브 추적 켜기' : paused ? '추적 ON (경로 탐색 중 일시 정지)' : '추적 끄기';
  return <div ref={root} className="map-actions" style={{ bottom }}>
    {expanded && <div className="map-tools-menu" role="group" aria-label="운행 도구 목록">
      <button onClick={() => open('seeker')} disabled={!hasDevice}>
        <Icon name="route" size={18} /><span>운행 분석<small>운행 분석·경로 재생</small></span>
      </button>
      <button onClick={() => open('geofence')}>
        <Icon name="fence" size={18} /><span>지오펜스 관리<small>펜스 설정·알림·이력</small></span>
      </button>
      <button onClick={() => open('route')}>
        <Icon name="mapPin" size={18} /><span>경로 계획<small>방문할 목적지 정리</small></span>
      </button>
      {!hasDevice && <p>운행 분석는 단말기를 선택한 뒤 사용할 수 있습니다.</p>}
    </div>}
    <button className="map-action btn-bounce" title="운행 도구" aria-label="운행 도구"
      aria-expanded={expanded} data-active={expanded} onClick={() => setExpanded(value => !value)}>
      <Icon name={expanded ? 'close' : 'wrench'} size={18} /><span>도구</span>
    </button>
    {hasDevice && <>
      <button className="map-action map-action-tracking btn-bounce" title={trackingLabel} aria-label={trackingLabel}
        aria-pressed={tracking} data-active={tracking} data-paused={paused} onClick={() => { setExpanded(false); onTracking(); }}>
        <Icon name="target" size={18} /><span>{tracking ? (paused ? '추적 대기' : '추적 중') : '자동 추적'}</span>
      </button>
      <button className="map-action btn-bounce" title="이동 기록" aria-label="이동 기록" aria-pressed={miniOpen}
        data-active={miniOpen} onClick={() => { setExpanded(false); onMini(); }}>
        <Icon name="clock" size={18} /><span>이동 기록</span>
      </button>
    </>}
  </div>;
}
