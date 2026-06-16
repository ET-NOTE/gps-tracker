// 카카오 로드뷰 — 인앱 모달.
// kakao.maps.Roadview() 는 WebView 안에서도 정상 동작 (별도 앱 호출 X).
// 호출자가 probeRoadview() 로 panoId 확보 후 열기 때문에 모달이 뜨면 항상 영상 있음.
import { useEffect, useRef, useState } from 'react';

// 50m 반경에서 가장 가까운 panoId 를 비동기로 반환. 없으면 null.
// 호출 측이 결과를 보고 모달을 열거나, 토스트로 "로드뷰 없음" 안내.
export function probeRoadview(lat, lng) {
  return new Promise((resolve) => {
    if (!window.kakao?.maps) { resolve(null); return; }
    window.kakao.maps.load(() => {
      const pos = new window.kakao.maps.LatLng(lat, lng);
      const client = new window.kakao.maps.RoadviewClient();
      client.getNearestPanoId(pos, 50, (panoId) => resolve(panoId || null));
    });
  });
}

export default function RoadviewModal({ lat, lng, panoId, onClose }) {
  const containerRef = useRef(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!window.kakao?.maps) {
      setError('카카오 지도가 로드되지 않았습니다.');
      return;
    }
    window.kakao.maps.load(() => {
      if (!containerRef.current) return;
      const pos = new window.kakao.maps.LatLng(lat, lng);
      const rv = new window.kakao.maps.Roadview(containerRef.current);
      rv.setPanoId(panoId, pos);
    });
  }, [lat, lng, panoId]);

  return (
    <div onClick={onClose} style={s.backdrop}>
      <div onClick={e => e.stopPropagation()} style={s.modal}>
        <div style={s.header}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            로드뷰
          </span>
          <button onClick={onClose} style={s.closeBtn}>✕</button>
        </div>
        {error
          ? <div style={s.error}>{error}</div>
          : <div ref={containerRef} style={s.container} />
        }
      </div>
    </div>
  );
}

const s = {
  backdrop: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,.6)',
    zIndex: 200,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  modal: {
    width: '95vw', maxWidth: 800,
    height: '85vh',
    background: 'var(--surface)',
    borderRadius: 12,
    overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
    boxShadow: '0 8px 24px rgba(0,0,0,.4)',
  },
  header: {
    padding: '12px 16px',
    fontWeight: 'bold',
    borderBottom: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    background: 'var(--surface)',
  },
  closeBtn: {
    background: 'transparent', border: 'none',
    fontSize: 18, cursor: 'pointer', color: 'var(--text-2)',
  },
  container: { flex: 1, width: '100%', height: '100%' },
  error: {
    padding: 24, textAlign: 'center', color: 'var(--text-2)', fontSize: 13,
  },
};
