// 모바일 친화 bottom-sheet — 지도 마커 클릭 시 하단에 떠오름.
// kakao InfoWindow 대체. 데스크톱은 사용 안 함 (KakaoMap 의 onPointInfo 미제공 시 InfoWindow 유지).
//
// 표시: 색 dot + 디바이스명/지점, 시각, 주소, 배터리/속도/위성, 로드뷰 버튼.
// 닫기: 우상단 X 또는 backdrop 영역 외부 탭 (없음 — 지도가 보이므로 X 만).
//
// compact 모드: 홈+간이 시커 활성 시 사용. 날짜 박스 (좌하단) 옆 + 시간 strip 위에 위치.
//   생략: 쓸어내리기 핸들, "선택 지점" 텍스트, 위경도, 위성 (간이 시커 컨텍스트에서 군더더기).
//   글자 ~1pt 작게.
import Icon from './Icon';

export default function PointInfoSheet({ info, onClose, onRoadview, compact = false, bottomOffset = 0, leftOffset = 0 }) {
  if (!info) return null;
  const { kind, label, color, meta, addr, lat, lng } = info;
  const recAt   = meta?.recordedAt ? new Date(meta.recordedAt) : null;
  const timeStr = recAt
    ? recAt.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';
  const title   = kind === 'main' ? (label || '디바이스') : '선택 지점';
  const isStop  = !!meta?.isStop;

  const speedStr = meta?.speedKmh != null ? `${meta.speedKmh.toFixed(1)} km/h` : null;
  // 정지 클러스터 요약 — 대표 dot 이면 timeStr 대신 range 표시.
  const isCluster = meta?.clusterCount > 1;
  const clusterRange = isCluster
    ? `${new Date(meta.clusterStartAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })} ~ ${new Date(meta.clusterEndAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}`
    : null;
  const clusterDur = isCluster ? (() => {
    const s = (new Date(meta.clusterEndAt).getTime() - new Date(meta.clusterStartAt).getTime()) / 1000;
    if (s < 60) return `${Math.max(1, Math.round(s))}초간 정지`;
    const mi = Math.round(s / 60);
    if (mi < 60) return `${mi}분간 정지`;
    const h = Math.floor(mi / 60), rm = mi % 60;
    return rm > 0 ? `${h}시간 ${rm}분간 정지` : `${h}시간 정지`;
  })() : null;
  // vbat (ESP ADC, 배터리 실측 근접) + cbc (모듈 AT+CBC, 배선 loss 뒤). cbc 는 있을 때만 부기.
  const battStr  = meta?.vbatMv != null
    ? (meta.cbcMv != null
        ? `${(meta.vbatMv/1000).toFixed(2)}V (모듈 ${(meta.cbcMv/1000).toFixed(2)}V)`
        : `${(meta.vbatMv/1000).toFixed(2)}V`)
    : null;
  const satStr   = meta?.sat != null ? `위성 ${meta.sat}` : null;

  const wrapStyle = compact
    ? { ...st.wrap, ...st.wrapCompact,
        bottom: `calc(${bottomOffset}px + 8px)`,
        // 날짜 박스와 살짝 더 떨어뜨림 (16px 갭) — 시각적 분리 + 손가락 닿음 영역 분리.
        left:   `calc(${leftOffset}px + 20px)` }
    : st.wrap;
  const titleRowStyle = compact ? { ...st.titleRow, gap: 5 } : st.titleRow;

  return (
    <div style={wrapStyle}>
      {/* 쓸어내리기 핸들 — 풀 사이즈일 때만. compact 는 어차피 swipe 미지원이라 생략. */}
      {!compact && <div style={st.handle} />}
      <div style={st.head}>
        <div style={titleRowStyle}>
          <span style={{ ...st.dot, background: color || '#888' }} />
          {/* compact 모드는 "선택 지점" 라벨 생략 — 컨텍스트가 이미 시커 슬롯 선택임. */}
          {(!compact || kind === 'main') && (
            <span style={compact ? st.titleTxtSmall : st.titleTxt}>{title}</span>
          )}
          {isStop && <span style={compact ? st.stopBadgeSmall : st.stopBadge}>정지</span>}
          <span style={compact ? st.timeTxtSmall : st.timeTxt}>{isCluster ? clusterRange : timeStr}</span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => onRoadview?.({ lat, lng })}
            className="btn-bounce"
            style={compact ? st.roadBtnSmall : st.roadBtn}>
            <Icon name="cam" size={compact ? 11 : 13} /> 로드뷰
          </button>
          <button onClick={onClose}
            className="btn-bounce btn-hover-bg"
            style={compact ? st.closeBtnSmall : st.closeBtn} title="닫기">
            <Icon name="close" size={compact ? 12 : 14} />
          </button>
        </div>
      </div>

      <div style={compact ? st.addrSmall : st.addr}>
        {addr === null
          ? <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>주소 확인 중...</span>
          : addr
            ? <>
                <Icon name="mapPin" size={compact ? 11 : 12} style={{ color: 'var(--primary)', marginRight: 4 }} />
                {addr.road || addr.jibun || '주소 미상'}
                {addr.building && <span style={{ color: 'var(--text-3)' }}> · {addr.building}</span>}
              </>
            : <span style={{ color: 'var(--text-3)' }}>주소 미상</span>}
      </div>

      <div style={compact ? st.statsSmall : st.stats}>
        {isCluster && (
          <span style={{ ...st.stat, color: 'var(--text)', fontWeight: 600 }}>
            {clusterDur} · {meta.clusterCount}개 합침
          </span>
        )}
        {battStr && <span style={st.stat}><Icon name="battery" size={compact ? 11 : 12} /> {battStr}</span>}
        {speedStr && <span style={st.stat}><Icon name="route" size={compact ? 11 : 12} /> {speedStr}</span>}
        {/* compact 모드: 위성 / 위경도 생략 — 군더더기 정보 */}
        {!compact && satStr && <span style={st.stat}><Icon name="sat" size={12} /> {satStr}</span>}
        {!compact && (
          <span style={{ ...st.stat, color: 'var(--text-3)', fontFamily: 'monospace', fontSize: 10 }}>
            {lat.toFixed(5)}, {lng.toFixed(5)}
          </span>
        )}
      </div>
    </div>
  );
}

const st = {
  wrap: {
    position: 'absolute',
    left: '50%', top: '50%',
    transform: 'translate(-50%, -50%)',
    width: 'calc(100% - 24px)',
    maxWidth: 380,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 14,
    boxShadow: '0 8px 28px rgba(0,0,0,.22)',
    padding: '10px 14px 12px',
    zIndex: 30,
    // fadeInUp 은 transform 을 덮어써서 중앙 정렬이 깨짐 — opacity-only 페이드 사용.
    animation: 'fadeInOnly .15s ease-out',
  },
  // compact: 날짜 박스 (좌하단) 오른쪽 + 시간 strip 위. left/bottom 은 prop 으로 동적 주입.
  //   · 모바일 (좁은 화면): right:8 로 화면 폭 끝까지 늘려 가독성 확보.
  //   · PC (넓은 화면): 컨텐츠 맞춤 + max 360px 로 캡 — 화면 폭에 끌려가지 않게.
  //                     `min()` CSS fn 으로 좁은 vw 에서도 안전.
  wrapCompact: {
    top: 'auto', transform: 'none',
    width: 'max-content',
    maxWidth: 'min(360px, calc(100vw - 132px))',
    padding: '7px 10px 8px',
    borderRadius: 10,
    boxShadow: '0 4px 14px rgba(0,0,0,.20)',
  },
  handle: {
    width: 36, height: 4, borderRadius: 2,
    background: 'var(--text-3)', opacity: 0.3,
    margin: '0 auto 8px',
  },
  head: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 8,
  },
  titleRow: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    minWidth: 0, flex: 1,
  },
  dot: {
    width: 10, height: 10, borderRadius: 5, flexShrink: 0,
  },
  titleTxt: {
    fontSize: 13, fontWeight: 700, color: 'var(--text)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  stopBadge: {
    fontSize: 10, fontWeight: 700,
    padding: '2px 6px', borderRadius: 8,
    background: '#FBBF24', color: '#1A1A2E',
    flexShrink: 0,
  },
  timeTxt: {
    fontSize: 11, color: 'var(--text-2)',
    fontVariantNumeric: 'tabular-nums',
    marginLeft: 'auto',
    flexShrink: 0,
  },
  roadBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '5px 10px', fontSize: 11, fontWeight: 700,
    background: 'var(--primary)', color: 'var(--primary-fg, white)',
    border: 'none', borderRadius: 14, cursor: 'pointer',
    flexShrink: 0,
  },
  closeBtn: {
    width: 28, height: 28, borderRadius: 14,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid var(--border)', cursor: 'pointer',
    flexShrink: 0,
  },
  addr: {
    fontSize: 12, color: 'var(--text)',
    marginTop: 8,
    display: 'flex', alignItems: 'center',
    flexWrap: 'wrap',
  },
  stats: {
    display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
    marginTop: 8, paddingTop: 8,
    borderTop: '1px solid var(--border)',
    fontSize: 11, color: 'var(--text-2)',
  },
  stat: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
  },

  // compact 변형 — ~1pt 더 작은 글자 + 더 좁은 spacing.
  titleTxtSmall: {
    fontSize: 12, fontWeight: 700, color: 'var(--text)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  timeTxtSmall: {
    fontSize: 10, color: 'var(--text-2)',
    fontVariantNumeric: 'tabular-nums',
    marginLeft: 'auto',
    flexShrink: 0,
  },
  stopBadgeSmall: {
    fontSize: 9, fontWeight: 700,
    padding: '1px 5px', borderRadius: 7,
    background: '#FBBF24', color: '#1A1A2E',
    flexShrink: 0,
  },
  roadBtnSmall: {
    display: 'inline-flex', alignItems: 'center', gap: 3,
    padding: '4px 8px', fontSize: 10, fontWeight: 700,
    background: 'var(--primary)', color: 'var(--primary-fg, white)',
    border: 'none', borderRadius: 12, cursor: 'pointer',
    flexShrink: 0,
  },
  closeBtnSmall: {
    width: 24, height: 24, borderRadius: 12,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid var(--border)', cursor: 'pointer',
    flexShrink: 0,
  },
  addrSmall: {
    fontSize: 11, color: 'var(--text)',
    marginTop: 5,
    display: 'flex', alignItems: 'center',
    flexWrap: 'wrap',
  },
  statsSmall: {
    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    marginTop: 5, paddingTop: 5,
    borderTop: '1px solid var(--border)',
    fontSize: 10, color: 'var(--text-2)',
  },
};
