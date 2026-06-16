// 지도 우상단의 컴팩트 디바이스 필터.
// 모든 해상도에서 단일 드롭다운으로 통일 — 좌측 MapControls 와 충돌 없음.
import { useEffect, useRef, useState } from 'react';
import { getDeviceColor } from '../colors';
import Icon from './Icon';

export default function DeviceFilter({ devices, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // 바깥 클릭으로 닫기
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('touchstart', onDoc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('touchstart', onDoc);
    };
  }, [open]);

  const sel = devices.find(d => d.id === selected);
  const label = sel ? (sel.display_name || sel.device_uid) : '전체';
  const color = sel ? getDeviceColor(sel) : 'var(--text-3)';

  return (
    <div ref={wrapRef} style={s.wrap}>
      <button onClick={() => setOpen(o => !o)} style={s.trigger}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0 }} />
        <span style={s.triggerLabel}>{label}</span>
        <Icon name={open ? 'close' : 'filter'} size={12} />
      </button>
      {open && (
        <div style={s.menu}>
          <Item color="var(--text-3)" on={selected === null}
            onClick={() => { onChange(null); setOpen(false); }}>
            전체 디바이스
          </Item>
          {devices.map(d => (
            <Item key={d.id} color={getDeviceColor(d)} on={selected === d.id}
              onClick={() => { onChange(d.id); setOpen(false); }}>
              {d.display_name || d.device_uid}
            </Item>
          ))}
        </div>
      )}
    </div>
  );
}

function Item({ color, on, onClick, children }) {
  return (
    <button onClick={onClick} style={{ ...s.item, ...(on ? s.itemOn : null) }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0 }} />
      <span style={s.itemLabel}>{children}</span>
    </button>
  );
}

const s = {
  wrap: {
    position: 'absolute',
    top: 12,
    left: 12,
    zIndex: 6,
    pointerEvents: 'none',
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
  },
  trigger: {
    pointerEvents: 'auto',
    display: 'inline-flex', alignItems: 'center', gap: 8,
    maxWidth: 220,
    padding: '7px 12px',
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 18,
    fontSize: 12, fontWeight: 500, cursor: 'pointer',
    boxShadow: '0 1px 4px rgba(0,0,0,.14)',
  },
  triggerLabel: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    maxWidth: 140,
  },
  menu: {
    pointerEvents: 'auto',
    marginTop: 6,
    minWidth: 200, maxWidth: 280,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 10, overflow: 'hidden',
    boxShadow: '0 6px 20px rgba(0,0,0,.18)',
    maxHeight: '60vh', overflowY: 'auto',
  },
  item: {
    display: 'flex', alignItems: 'center', gap: 8,
    width: '100%', padding: '10px 12px',
    background: 'transparent', color: 'var(--text)',
    border: 'none', borderBottom: '1px solid var(--border)',
    fontSize: 12, cursor: 'pointer', textAlign: 'left',
  },
  itemOn: {
    background: 'var(--surface-2)', fontWeight: 600, color: 'var(--primary)',
  },
  itemLabel: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    flex: 1, minWidth: 0,
  },
};
