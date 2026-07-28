// (2026-07-28) Phase F5-b — Cmd+K command palette.
//
// 오버레이 모달 with fuzzy 검색. 두 종류 항목:
//   - static commands (Fleet 이동, 진단, 테마, 로그아웃 등) — App 이 registerCommands 로 세팅
//   - dynamic devices (registerDevices 로 세팅) — 차량번호/이름 검색
//
// Store 는 module-level (Toast/Dialog pattern). App.jsx 가 <CommandPaletteHost /> 마운트
// + keyboard listener 로 Cmd+K/Ctrl+K bind.

import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../Icon';

const listeners = new Set();
let openState = false;
let commandsState = [];   // { id, label, hint, icon, run(), group? }
let devicesState  = [];   // 원본 device 배열

function emit() { listeners.forEach(fn => fn({ open: openState, commands: commandsState, devices: devicesState })); }

export function openPalette()  { openState = true;  emit(); }
export function closePalette() { openState = false; emit(); }
export function togglePalette(){ openState = !openState; emit(); }
export function registerCommands(list) { commandsState = list || []; emit(); }
export function registerDevices(list)  { devicesState  = list || []; emit(); }

export function CommandPaletteHost({ onSelectDevice }) {
  const [state, setState] = useState({ open: openState, commands: commandsState, devices: devicesState });
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    listeners.add(setState);
    return () => listeners.delete(setState);
  }, []);

  // 열릴 때 검색 초기화 + focus.
  useEffect(() => {
    if (state.open) {
      setQ(''); setCursor(0);
      // input 은 mount 후 tick 에 focus.
      const t = setTimeout(() => inputRef.current?.focus(), 20);
      return () => clearTimeout(t);
    }
  }, [state.open]);

  const items = useMemo(() => {
    const s = q.trim().toLowerCase();
    const cmds = state.commands.map(c => ({ ...c, _kind: 'command' }));
    const devs = state.devices.map(d => ({
      _kind: 'device',
      id:    `dev:${d.id}`,
      label: d.license_plate || d.display_name || d.device_uid,
      hint:  d.license_plate && d.display_name ? d.display_name : (d.device_uid || ''),
      icon:  'car',
      group: '차량',
      _raw:  d,
    }));
    const all = [...cmds, ...devs];
    if (!s) return all;
    return all.filter(i =>
      (i.label || '').toLowerCase().includes(s) ||
      (i.hint  || '').toLowerCase().includes(s));
  }, [q, state.commands, state.devices]);

  useEffect(() => { setCursor(0); }, [q]);

  function run(i) {
    const it = items[i];
    if (!it) return;
    if (it._kind === 'device') {
      onSelectDevice?.(it._raw);
    } else if (typeof it.run === 'function') {
      try { it.run(); } catch (e) { console.error(e); }
    }
    closePalette();
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(items.length - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(0, c - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(cursor); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  }

  if (!state.open) return null;

  // group 별로 렌더 (안정적 순서 유지).
  const groups = [];
  const seen = new Map();
  items.forEach((it, absIdx) => {
    const g = it.group || (it._kind === 'device' ? '차량' : '액션');
    if (!seen.has(g)) { seen.set(g, groups.length); groups.push({ label: g, entries: [] }); }
    groups[seen.get(g)].entries.push({ ...it, _absIdx: absIdx });
  });

  return (
    <div onClick={closePalette}
      style={{
        position: 'fixed', inset: 0, zIndex: 'var(--z-modal)',
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '10vh var(--space-4) var(--space-4)',
      }}>
      <div onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="빠른 이동"
        style={{
          background: 'var(--surface)', color: 'var(--text)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-lg)',
          width: '100%', maxWidth: 520,
          display: 'flex', flexDirection: 'column',
          maxHeight: '70vh', overflow: 'hidden',
          border: '1px solid var(--border)',
        }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
          padding: 'var(--space-3) var(--space-4)',
          borderBottom: '1px solid var(--border)',
        }}>
          <Icon name="search" size={14} style={{ color: 'var(--text-3)' }} />
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="차량 · 액션 검색... (Cmd+K)"
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              fontSize: 14, color: 'var(--text)',
            }}
          />
          <span style={{
            fontSize: 10, color: 'var(--text-3)',
            padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 4,
          }}>Esc</span>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, padding: 'var(--space-2)' }}>
          {items.length === 0 && (
            <div style={{ padding: 'var(--space-6)', textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
              검색 결과 없음
            </div>
          )}
          {groups.map(g => (
            <div key={g.label} style={{ marginBottom: 'var(--space-2)' }}>
              <div style={{
                fontSize: 10, fontWeight: 700, color: 'var(--text-3)',
                padding: '4px var(--space-2)', letterSpacing: 0.4, textTransform: 'uppercase',
              }}>{g.label}</div>
              {g.entries.map(it => {
                const active = cursor === it._absIdx;
                return (
                  <button key={it.id} onClick={() => run(it._absIdx)}
                    onMouseEnter={() => setCursor(it._absIdx)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                      width: '100%', padding: 'var(--space-2) var(--space-3)',
                      background: active
                        ? 'color-mix(in srgb, var(--primary) 12%, transparent)'
                        : 'transparent',
                      border: 'none', borderRadius: 'var(--radius-sm)',
                      cursor: 'pointer', textAlign: 'left', font: 'inherit',
                      color: 'var(--text)',
                    }}>
                    <div style={{
                      width: 24, height: 24, borderRadius: 'var(--radius-sm)',
                      background: 'var(--surface-2)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: active ? 'var(--primary)' : 'var(--text-2)',
                      flexShrink: 0,
                    }}>
                      <Icon name={it.icon || 'more'} size={12} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{it.label}</div>
                      {it.hint && (
                        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 1,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {it.hint}
                        </div>
                      )}
                    </div>
                    {active && <Icon name="chevron-right" size={12} style={{ color: 'var(--text-3)' }} />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div style={{
          padding: '6px var(--space-3)', borderTop: '1px solid var(--border)',
          fontSize: 10, color: 'var(--text-3)',
          display: 'flex', gap: 'var(--space-3)', justifyContent: 'space-between',
        }}>
          <span>↑↓ 이동 · Enter 선택</span>
          <span>Cmd+K / Ctrl+K</span>
        </div>
      </div>
    </div>
  );
}
