// 지도 우상단 컨트롤 — 눈 아이콘만 기본 노출, 클릭 시 지도/위성·지적 확장.
import { useState } from 'react';
import Icon from './Icon';

const TYPES = [
  { id: 'roadmap', label: '지도' },
  { id: 'hybrid',  label: '위성' },
];

export default function MapControls({ mapRef, onOpenRoadview }) {
  const [mapType,   setMapType]   = useState('roadmap');
  const [cadastral, setCadastral] = useState(false);
  const [expanded,  setExpanded]  = useState(false);

  function selectType(t) {
    setMapType(t);
    mapRef.current?.setMapType(t);
  }
  function toggleCad() {
    const next = !cadastral;
    setCadastral(next);
    mapRef.current?.toggleCadastral(next);
  }
  function stop(e) { e.stopPropagation(); }
  function toggleExpanded(e) { stop(e); setExpanded(p => !p); }

  return (
    <div style={s.wrap}>
      <div style={s.card}>
        {/* 확장 시: 지도/위성 세그먼트 */}
        {expanded && (
          <>
            <div style={s.segment}>
              {TYPES.map(t => (
                <button key={t.id}
                  onPointerUp={(e) => { stop(e); selectType(t.id); }}
                  onClick={stop}
                  style={{ ...s.segBtn, ...(mapType === t.id ? s.segOn : null) }}>
                  {t.label}
                </button>
              ))}
            </div>
            <div style={s.divider} />
            {/* 지적 */}
            <button
              onPointerUp={(e) => { stop(e); toggleCad(); }}
              onClick={stop}
              title="지적도"
              style={{ ...s.iconBtn, ...(cadastral ? s.iconOn : null) }}>
              지적
            </button>
            <div style={s.divider} />
            {/* 로드뷰 */}
            <button
              onPointerUp={(e) => { stop(e); onOpenRoadview?.(); }}
              onClick={stop}
              title="현재 중심으로 로드뷰"
              style={s.iconBtn}>
              <Icon name="route" size={15} />
            </button>
            <div style={s.divider} />
          </>
        )}

        {/* 항상: 눈 아이콘 */}
        <button
          onPointerUp={toggleExpanded}
          onClick={stop}
          title={expanded ? '닫기' : '지도 옵션'}
          style={{ ...s.iconBtn, ...(expanded ? s.iconOn : null) }}>
          <Icon name="eye" size={15} />
        </button>
      </div>
    </div>
  );
}

const s = {
  wrap: {
    position: 'absolute',
    right: 10, top: 10,
    zIndex: 5,
    pointerEvents: 'none',
  },
  card: {
    display: 'flex',
    alignItems: 'center',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    overflow: 'hidden',
    pointerEvents: 'auto',
    boxShadow: '0 1px 4px rgba(0,0,0,.10)',
  },
  segment: {
    display: 'flex',
  },
  segBtn: {
    padding: '7px 11px',
    background: 'transparent',
    color: 'var(--text-2)',
    border: 'none',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '.02em',
    touchAction: 'manipulation',
    userSelect: 'none',
    minHeight: 36,
    whiteSpace: 'nowrap',
  },
  segOn: {
    background: 'var(--primary)',
    color: 'var(--primary-fg)',
  },
  divider: {
    width: 1,
    alignSelf: 'stretch',
    background: 'var(--border)',
    flexShrink: 0,
  },
  iconBtn: {
    padding: '7px 11px',
    background: 'transparent',
    color: 'var(--text-2)',
    border: 'none',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    touchAction: 'manipulation',
    userSelect: 'none',
    minHeight: 36,
    minWidth: 36,
  },
  iconOn: {
    background: 'var(--primary)',
    color: 'var(--primary-fg)',
  },
};
