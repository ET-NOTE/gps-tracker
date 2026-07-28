// (2026-07-28) Phase F4-b — Fleet dashboard 좌측 device list panel.
// 참고 이미지 스타일: compact row + 검색 + 상태별 sort + react-window 로 100+ 대 virtualize.
//
// props:
//   devices: 필터링된 device 배열
//   selectedId: 선택된 device id (highlight)
//   onSelect: (device) => void
//   query, onQuery: 검색어 controlled

import { useMemo, useState, useRef, useEffect } from 'react';
import { FixedSizeList } from 'react-window';
import { classifyDevice } from './SummaryChips';
import Icon from '../Icon';

const ROW_HEIGHT = 72;

const STATE_META = {
  active:  { label: '운행',    color: 'var(--accent)',  dot: '#10B981' },
  idle:    { label: '대기',    color: 'var(--primary)', dot: '#3B82F6' },
  offline: { label: '오프라인', color: 'var(--text-3)',  dot: '#999' },
};

export default function DeviceListPanel({ devices = [], selectedId, onSelect, query, onQuery }) {
  const [containerH, setContainerH] = useState(400);
  const wrapRef = useRef(null);

  // 컨테이너 리사이즈 관찰 — ResizeObserver 로 real-time.
  useEffect(() => {
    if (!wrapRef.current) return;
    const el = wrapRef.current;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setContainerH(e.contentRect.height);
    });
    ro.observe(el);
    setContainerH(el.getBoundingClientRect().height);
    return () => ro.disconnect();
  }, []);

  const sorted = useMemo(() => {
    // 운행중 → 대기 → 오프라인 순, 각 그룹 안에선 최근 fix 우선.
    const order = { active: 0, idle: 1, offline: 2 };
    return [...devices].sort((a, b) => {
      const oa = order[classifyDevice(a)] ?? 3;
      const ob = order[classifyDevice(b)] ?? 3;
      if (oa !== ob) return oa - ob;
      return (new Date(b.last_fix_at || 0) - new Date(a.last_fix_at || 0));
    });
  }, [devices]);

  const filtered = useMemo(() => {
    const q = (query || '').trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(d =>
      (d.display_name || '').toLowerCase().includes(q) ||
      (d.license_plate || '').toLowerCase().includes(q) ||
      (d.device_uid || '').toLowerCase().includes(q));
  }, [sorted, query]);

  const Row = ({ index, style }) => {
    const d = filtered[index];
    const state = classifyDevice(d);
    const m = STATE_META[state];
    const selected = selectedId === d.id;
    return (
      <div style={style}>
        <button
          onClick={() => onSelect?.(d)}
          style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
            width: '100%', height: ROW_HEIGHT - 4, marginBottom: 4,
            padding: '0 var(--space-3)',
            background: selected
              ? 'color-mix(in srgb, var(--primary) 12%, var(--surface))'
              : 'var(--surface)',
            border: '1px solid ' + (selected ? 'var(--primary)' : 'var(--border)'),
            borderLeft: '4px solid ' + m.dot,
            borderRadius: 'var(--radius-md)',
            cursor: 'pointer',
            textAlign: 'left',
            fontFamily: 'inherit',
          }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 13, fontWeight: 700, color: 'var(--text)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {d.license_plate ? (
                <>
                  <span>{d.license_plate}</span>
                  {d.display_name && (
                    <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-2)', marginLeft: 6 }}>
                      · {d.display_name}
                    </span>
                  )}
                </>
              ) : (d.display_name || d.device_uid)}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 3 }}>
              {d.last_fix_at ? new Date(d.last_fix_at).toLocaleString('ko-KR', {
                month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
              }) : '위치 미확인'}
            </div>
          </div>
          <span style={{
            fontSize: 10, fontWeight: 800, color: m.color,
            padding: '2px 8px', borderRadius: 999,
            background: `color-mix(in srgb, ${m.dot} 14%, transparent)`,
          }}>{m.label}</span>
        </button>
      </div>
    );
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      background: 'var(--surface-2)', borderRight: '1px solid var(--border)',
      minHeight: 0, height: '100%',
    }}>
      <div style={{
        padding: 'var(--space-3)', borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: 'var(--space-2) var(--space-3)',
          background: 'var(--surface-2)', borderRadius: 'var(--radius-md)',
        }}>
          <Icon name="search" size={13} style={{ color: 'var(--text-3)' }} />
          <input value={query || ''} onChange={e => onQuery?.(e.target.value)}
            placeholder="차량번호 · 이름 · UID"
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              fontSize: 12, color: 'var(--text)',
            }} />
          {query && (
            <button onClick={() => onQuery?.('')} style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--text-3)', padding: 0,
            }}><Icon name="close" size={12} /></button>
          )}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 6, textAlign: 'right' }}>
          {filtered.length} / {devices.length}대
        </div>
      </div>

      <div ref={wrapRef} style={{ flex: 1, minHeight: 0, padding: 'var(--space-2)' }}>
        {filtered.length === 0 ? (
          <div style={{
            padding: 'var(--space-6)', textAlign: 'center', color: 'var(--text-3)', fontSize: 12,
          }}>{query ? '검색 결과 없음' : '차량이 없습니다.'}</div>
        ) : (
          <FixedSizeList
            height={containerH - 16}
            width="100%"
            itemCount={filtered.length}
            itemSize={ROW_HEIGHT}
            overscanCount={4}
          >
            {Row}
          </FixedSizeList>
        )}
      </div>
    </div>
  );
}
