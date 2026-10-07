import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { ageString, isFixStale } from '../colors';
import './DeviceCardSummary.css';

export default function DeviceCardSummary({ device, meta, status, color, pinned, detailOpen,
  onView, onDetail, onPin, onReceive, onColor, onRename, onUnpair }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  useEffect(() => {
    if (!open) return;
    const outside = e => { if (!root.current?.contains(e.target)) setOpen(false); };
    const escape = e => { if (e.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  function run(action) { setOpen(false); trigger.current?.focus(); action?.(); }
  const vbat = meta?.vbatMv ?? device.last_vbat_mv;
  const cbc = meta?.cbcMv ?? device.last_cbc_mv;
  return <div ref={root} className="device-summary">
    <div className="device-summary-heading">
      <div className="device-summary-identity">
        <h3>{device.display_name || device.device_uid}</h3>
        <span className="device-status" style={{ color: status.color, background: status.background || 'var(--surface-2)' }}>
          <span aria-hidden="true" style={{ background: status.color }} />{status.label}
        </span>
        {pinned && <span className="device-pinned">홈에 고정됨</span>}
      </div>
      <div className="device-more-wrap">
        <button ref={trigger} className="device-more" aria-label="단말기 더보기" aria-expanded={open} onClick={() => setOpen(v => !v)}>
          <Icon name="more" size={22} />
        </button>

      </div>
    </div>
        {open && <div className="device-more-menu" role="group" aria-label="단말기 작업">
          <button onClick={() => run(onPin)}><Icon name="home" />{pinned ? '홈 고정 해제' : '홈에 고정'}</button>
          <button onClick={() => run(onReceive)}><Icon name="refresh" />수신 로그</button>
          <button onClick={() => run(onColor)}><span className="device-color-swatch" style={{ background: color }} />색상 변경</button>
          <button onClick={() => run(onRename)}><Icon name="edit" />이름 변경</button>
          <button className="device-disconnect" onClick={() => run(onUnpair)}><Icon name="unlink" />연결 해제</button>
        </div>}
    <dl className="device-reception">
      <div><dt>최근 통신</dt><dd>{device.last_seen_at ? ageString(device.last_seen_at) : '수신 전'}</dd></div>
      <div><dt>최근 위치</dt><dd className={isFixStale(device.last_fix_at) ? 'device-location-stale' : undefined}>{device.last_fix_at ? ageString(device.last_fix_at) : '미수신'}</dd></div>
    </dl>
    <div className="device-primary-actions">
      <button onClick={onView}><Icon name="mapPin" size={17} />지도 보기</button>
      <button className="device-detail-toggle" aria-expanded={detailOpen} onClick={onDetail}><Icon name="bar" size={17} />{detailOpen ? '상세 닫기' : '상세·통계'}</button>
    </div>
    <details className="device-technical">
      <summary>단말기 식별 정보</summary>
      <dl>
        <div><dt>식별번호</dt><dd>{device.device_uid || '—'}</dd></div>
        {vbat != null && <div><dt>배터리 전압</dt><dd>{(vbat / 1000).toFixed(2)} V</dd></div>}
        {cbc != null && <div><dt>모듈 전압</dt><dd>{(cbc / 1000).toFixed(2)} V</dd></div>}
        {meta?.sat != null && <div><dt>위성</dt><dd>{meta.sat}개</dd></div>}
      </dl>
    </details>
  </div>;
}
