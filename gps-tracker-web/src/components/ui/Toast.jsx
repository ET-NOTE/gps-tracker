// (2026-07-28) Phase F5-a — Toast (non-blocking 성공/정보 알림).
//
// alertDialog/confirmDialog 는 blocking modal — 사용자가 OK 눌러야 진행.
// Toast 는 non-blocking — 저장 성공 · 복사 완료 등 짧은 성공 알림에 적합.
//
// Store 는 module-level (Dialog.jsx pattern 참조 — DialogHost 처럼 하나만 마운트).
// 어디서든 `toast.success('저장 완료')` `toast.error(err.message)` 호출.

import { useEffect, useState } from 'react';
import Icon from '../Icon';

const listeners = new Set();
let nextId = 1;
let items = [];   // { id, tone, title, body, timeout, createdAt }

function emit() { listeners.forEach(fn => fn(items.slice())); }

function push(tone, arg, opts = {}) {
  const item = typeof arg === 'string'
    ? { title: arg }
    : { title: arg?.title, body: arg?.body };
  const id = nextId++;
  const timeout = opts.duration ?? (tone === 'danger' ? 6000 : 3000);
  const entry = { id, tone, ...item, timeout, createdAt: Date.now() };
  items = [...items, entry];
  emit();
  if (timeout > 0) {
    setTimeout(() => dismiss(id), timeout);
  }
  return id;
}
function dismiss(id) {
  items = items.filter(x => x.id !== id);
  emit();
}
function dismissAll() { items = []; emit(); }

export const toast = {
  success: (arg, opts) => push('success', arg, opts),
  info:    (arg, opts) => push('info',    arg, opts),
  warning: (arg, opts) => push('warning', arg, opts),
  danger:  (arg, opts) => push('danger',  arg, opts),
  error:   (arg, opts) => push('danger',  arg, opts),   // alias
  dismiss,
  dismissAll,
};

const TONE = {
  success: { color: 'var(--accent)',  icon: 'check' },
  info:    { color: 'var(--primary)', icon: 'info' },
  warning: { color: 'var(--warning)', icon: 'warn' },
  danger:  { color: 'var(--danger)',  icon: 'warn' },
};

export function ToastHost() {
  const [list, setList] = useState(items);
  useEffect(() => {
    listeners.add(setList);
    return () => listeners.delete(setList);
  }, []);
  if (list.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed', zIndex: 'var(--z-toast)',
        right: 'max(16px, env(safe-area-inset-right))',
        bottom: 'max(16px, env(safe-area-inset-bottom))',
        display: 'flex', flexDirection: 'column', gap: 'var(--space-2)',
        pointerEvents: 'none',
        maxWidth: 'calc(100vw - 32px)',
      }}
    >
      {list.map(t => {
        const m = TONE[t.tone] || TONE.info;
        return (
          <div key={t.id} style={{
            pointerEvents: 'auto',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderLeft: `3px solid ${m.color}`,
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-lg)',
            padding: 'var(--space-2) var(--space-3)',
            display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start',
            minWidth: 240, maxWidth: 380,
            color: 'var(--text)',
            animation: 'ui-toast-in 0.2s ease-out',
          }}>
            <div style={{
              width: 22, height: 22, borderRadius: 'var(--radius-sm)',
              background: `color-mix(in srgb, ${m.color} 15%, transparent)`,
              color: m.color,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, marginTop: 1,
            }}>
              <Icon name={m.icon} size={13} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {t.title && (
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{t.title}</div>
              )}
              {t.body && (
                <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>{t.body}</div>
              )}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="닫기"
              style={{
                background: 'transparent', border: 'none', color: 'var(--text-3)',
                cursor: 'pointer', padding: 2, fontSize: 14, lineHeight: 1,
              }}>×</button>
          </div>
        );
      })}
    </div>
  );
}

// index.css 에 애니메이션 없으면 head 에 주입.
if (typeof document !== 'undefined') {
  const styleId = 'ui-toast-anim';
  if (!document.getElementById(styleId)) {
    const s = document.createElement('style');
    s.id = styleId;
    s.textContent = `@keyframes ui-toast-in {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }`;
    document.head.appendChild(s);
  }
}
