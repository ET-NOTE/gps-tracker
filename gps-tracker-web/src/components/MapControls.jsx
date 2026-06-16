// 지도 위 우상단 컨트롤 — 눈 아이콘 토글로 그룹(지도/위성, 지적, 로드뷰) 펼치고 접기.
// 기본 상태는 접힘. 컨트롤이 평소엔 지도를 가리지 않고, 필요할 때만 사용자가 펼침.
import { useState } from 'react';
import Icon from './Icon';

const TYPES = [
  { id: 'roadmap', label: '지도', title: '일반' },
  { id: 'hybrid',  label: '위성', title: '위성+라벨' },
];

export default function MapControls({ mapRef, onOpenRoadview }) {
  const [mapType, setMapType] = useState('roadmap');
  const [cadastral, setCadastral] = useState(false);
  const [expanded, setExpanded] = useState(false);

  function selectType(t) {
    setMapType(t);
    mapRef.current?.setMapType(t);
  }
  function toggleCad() {
    const next = !cadastral;
    setCadastral(next);
    mapRef.current?.toggleCadastral(next);
  }

  // 모바일에서 "눈 아이콘 → 지도/위성 → 다시 눈" 시 두번째 눈 클릭이 자주 씹힘.
  // 원인: ① 36x36 작은 hit-area + Kakao 지도의 touch-drag 핸들러가 미세 움직임 흡수
  //       ② 300ms 클릭 지연 + ghost click 충돌
  // 대책: touchAction:'manipulation' (지연 제거) + onPointerUp 우선 + stopPropagation.
  function toggleExpanded(e) {
    e.stopPropagation();
    setExpanded(prev => !prev);
  }

  return (
    <div style={s.wrap}>
      {/* 항상 보이는 토글 — 눈 아이콘. 펼친 상태일 때 primary 색상으로 활성 표시. */}
      <button
        onPointerUp={toggleExpanded}
        onClick={(e) => e.stopPropagation()}  // 중복 발화 방지 (pointerUp 이 이미 처리)
        title={expanded ? '컨트롤 숨기기' : '지도 옵션'}
        style={{ ...s.iconBtn, ...(expanded ? s.iconOn : null) }}>
        <Icon name="eye" size={16} />
      </button>

      {/* 펼침 그룹 — 토글 활성 시에만 노출. */}
      {expanded && (
        <>
          {/* 지도 타입 — 세그먼트 토글 */}
          <div style={{ ...s.segment, animation: 'fadeInUp .15s ease-out' }}>
            {TYPES.map(t => (
              <button key={t.id}
                onPointerUp={(e) => { e.stopPropagation(); selectType(t.id); }}
                onClick={(e) => e.stopPropagation()}
                title={t.title}
                style={{ ...s.segBtn, ...(mapType === t.id ? s.segOn : null) }}>
                {t.label}
              </button>
            ))}
          </div>
          {/* 지적 */}
          <button
            onPointerUp={(e) => { e.stopPropagation(); toggleCad(); }}
            onClick={(e) => e.stopPropagation()}
            title="지적도"
            style={{ ...s.iconBtn, ...(cadastral ? s.iconOn : null), animation: 'fadeInUp .15s ease-out' }}>
            지적
          </button>
          {/* 로드뷰 — 길 모양 (route) 아이콘 */}
          <button
            onPointerUp={(e) => { e.stopPropagation(); onOpenRoadview?.(); }}
            onClick={(e) => e.stopPropagation()}
            title="현재 중심으로 로드뷰"
            style={{ ...s.iconBtn, animation: 'fadeInUp .15s ease-out' }}>
            <Icon name="route" size={16} />
          </button>
        </>
      )}
    </div>
  );
}

const s = {
  wrap: {
    position: 'absolute',
    right: 12, top: 12,
    display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8,
    zIndex: 5,
    pointerEvents: 'none',
  },
  segment: {
    display: 'flex',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    overflow: 'hidden',
    pointerEvents: 'auto',
    boxShadow: '0 1px 3px rgba(0,0,0,.12)',
  },
  segBtn: {
    padding: '8px 12px', minWidth: 44, minHeight: 40,
    background: 'transparent', color: 'var(--text-2)',
    border: 'none', cursor: 'pointer',
    fontSize: 11, fontWeight: 600, letterSpacing: '.02em',
    touchAction: 'manipulation',  // 300ms 클릭 지연 + double-tap zoom 차단 → 모바일 빠른 응답
    userSelect: 'none',
  },
  segOn: {
    background: 'var(--primary)', color: 'var(--primary-fg)',
  },
  iconBtn: {
    width: 40, height: 40,        // 36 → 40 (Material 48dp 권고에 더 가깝게, 핀치 영역 확장)
    background: 'var(--surface)', color: 'var(--text-2)',
    border: '1px solid var(--border)',
    borderRadius: 8, cursor: 'pointer',
    fontSize: 11, fontWeight: 600,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    pointerEvents: 'auto',
    boxShadow: '0 1px 3px rgba(0,0,0,.12)',
    touchAction: 'manipulation',
    userSelect: 'none',
  },
  iconOn: {
    background: 'var(--primary)', color: 'var(--primary-fg)',
    borderColor: 'var(--primary)',
  },
};
