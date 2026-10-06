// 지도 마커 상세: 지도 안 하단 카드. 날짜 패널 옆의 compact 모드도 지원.
// kakao InfoWindow 대체. 데스크톱은 사용 안 함 (KakaoMap 의 onPointInfo 미제공 시 InfoWindow 유지).
//
// 표시: 색 dot + 디바이스명/지점, 시각, 주소, 배터리/속도/위성, 로드뷰 버튼.
// 닫기: 우상단 X 또는 backdrop 영역 외부 탭 (없음 — 지도가 보이므로 X 만).
//
// compact 모드: 홈+간이 시커 활성 시 사용. 날짜 박스 (좌하단) 옆 + 시간 strip 위에 위치.
//   생략: 쓸어내리기 핸들, "선택 지점" 텍스트, 위경도, 위성 (간이 시커 컨텍스트에서 군더더기).
//   글자 ~1pt 작게.
import Icon from './Icon';
import './PointInfoSheet.css';

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

  return <section className={`point-info${compact ? ' point-info-compact' : ''}`}
    aria-label="위치 정보" style={{ bottom: bottomOffset + 8, ...(compact ? { left: leftOffset + 20 } : {}) }}>
    <header className="point-info-header">
      <div className="point-info-title"><span style={{ background: color || 'var(--primary)' }} />
        <strong>{title}</strong>{isStop && <span className="point-stop">정지</span>}
      </div>
      <button className="map-sheet-close" onClick={onClose} aria-label="위치 정보 닫기"><Icon name="close" size={20} /></button>
    </header>
    <div className="point-info-body">
      <p className="point-info-time">{isCluster ? clusterRange : timeStr}</p>
      <div className="point-info-address">{addr === null ? '주소 확인 중…' : addr
        ? <>{addr.road || addr.jibun || '주소 미상'}{addr.building && ` · ${addr.building}`}</> : '주소 미상'}</div>
      <dl className="point-info-stats">
        {isCluster && <div><dt>정차</dt><dd>{clusterDur} · {meta.clusterCount}개 지점</dd></div>}
        {speedStr && <div><dt>속도</dt><dd>{speedStr}</dd></div>}
        {battStr && <div><dt>배터리</dt><dd>{battStr}</dd></div>}
        {!compact && satStr && <div><dt>위성</dt><dd>{meta.sat}개</dd></div>}
        {!compact && Number.isFinite(lat) && Number.isFinite(lng) && <div><dt>좌표</dt><dd>{lat.toFixed(5)}, {lng.toFixed(5)}</dd></div>}
      </dl>
      <button className="point-roadview" onClick={() => onRoadview?.({ lat, lng })} disabled={!onRoadview}>
        <Icon name="cam" size={18} />로드뷰 보기
      </button>
    </div>
  </section>;
}
