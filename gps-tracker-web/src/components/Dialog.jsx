// 커스텀 모달 — 브라우저 네이티브 alert/confirm/prompt 대체.
// imperative API: await confirmDialog({...}) / alertDialog({...}) / promptDialog({...}).
// DialogHost 한 번 마운트하면 어디서든 호출 가능.
import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';

// ─── 싱글톤 큐 ───────────────────────────────────────────
const listeners = new Set();
function emit(state) { listeners.forEach(fn => fn(state)); }

export function alertDialog(opts) {
  return new Promise(resolve => {
    emit({
      kind: 'alert',
      title: opts.title || '알림',
      body: opts.body || '',
      confirmLabel: opts.confirmLabel || '확인',
      tone: opts.tone || 'info',           // 'info' | 'success' | 'warn' | 'danger'
      resolve: () => resolve(true),
    });
  });
}

export function confirmDialog(opts) {
  return new Promise(resolve => {
    emit({
      kind: 'confirm',
      title: opts.title || '확인',
      body: opts.body || '',
      confirmLabel: opts.confirmLabel || '확인',
      cancelLabel:  opts.cancelLabel  || '취소',
      tone: opts.tone || (opts.danger ? 'danger' : 'info'),
      resolve,
    });
  });
}

export function promptDialog(opts) {
  return new Promise(resolve => {
    emit({
      kind: 'prompt',
      title: opts.title || '입력',
      body: opts.body || '',
      placeholder: opts.placeholder || '',
      defaultValue: opts.defaultValue || '',
      confirmLabel: opts.confirmLabel || '확인',
      cancelLabel:  opts.cancelLabel  || '취소',
      multiline: !!opts.multiline,
      tone: opts.tone || 'info',
      resolve,
    });
  });
}

// ─── 호스트 컴포넌트 ─────────────────────────────────────
export default function DialogHost() {
  const [stack, setStack] = useState([]);   // 동시 여러 dialog 스태킹 — 사용 빈도 낮으나 안전망

  useEffect(() => {
    const fn = (s) => setStack(prev => [...prev, { ...s, _id: Math.random().toString(36).slice(2) }]);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);

  if (stack.length === 0) return null;

  function close(item, value) {
    item.resolve(value);
    setStack(prev => prev.filter(x => x._id !== item._id));
  }

  return (
    <>
      {stack.map((s, i) => (
        <DialogModal key={s._id} state={s} top={i === stack.length - 1}
          onCancel={() => close(s, s.kind === 'alert' ? true : (s.kind === 'prompt' ? null : false))}
          onConfirm={(value) => close(s, s.kind === 'prompt' ? value : true)} />
      ))}
    </>
  );
}

function DialogModal({ state, top, onCancel, onConfirm }) {
  const [val, setVal] = useState(state.defaultValue || '');
  const inputRef = useRef(null);
  const confirmRef = useRef(null);

  useEffect(() => {
    // 진입 시 적절한 요소에 포커스 — input 있으면 input, 없으면 confirm
    setTimeout(() => {
      if (state.kind === 'prompt') inputRef.current?.focus();
      else                          confirmRef.current?.focus();
    }, 50);
  }, [state.kind]);

  // ESC / Enter 단축키 (최상위 dialog 만 반응)
  useEffect(() => {
    if (!top) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter' && state.kind !== 'prompt') {
        e.preventDefault();
        onConfirm();
      } else if (e.key === 'Enter' && state.kind === 'prompt' && !state.multiline) {
        e.preventDefault();
        onConfirm(val);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [top, state, val, onCancel, onConfirm]);

  const tone = state.tone;
  const accent = TONE_COLOR[tone] || 'var(--primary)';
  const iconName = TONE_ICON[tone] || 'spark';

  return (
    <div style={st.backdrop} onClick={state.kind === 'alert' ? onConfirm : onCancel}>
      <div style={st.modal} onClick={e => e.stopPropagation()}>
        {/* 헤더 — 아이콘 + 타이틀 */}
        <div style={st.header}>
          <div style={{
            ...st.iconWrap,
            background: `${accent}1a`,        // 12% alpha
            color: accent,
          }}>
            <Icon name={iconName} size={22} stroke={2} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={st.title}>{state.title}</div>
          </div>
          {state.kind !== 'alert' && (
            <button onClick={onCancel} style={st.closeBtn} aria-label="닫기">
              <Icon name="close" size={16} />
            </button>
          )}
        </div>

        {/* 본문 */}
        {state.body && (
          <div style={st.body}>{state.body}</div>
        )}

        {/* prompt 입력 */}
        {state.kind === 'prompt' && (
          state.multiline ? (
            <textarea ref={inputRef} value={val} onChange={e => setVal(e.target.value)}
              placeholder={state.placeholder}
              style={{ ...st.input, minHeight: 80, resize: 'vertical', fontFamily: 'inherit' }} />
          ) : (
            <input ref={inputRef} value={val} onChange={e => setVal(e.target.value)}
              placeholder={state.placeholder}
              style={st.input} />
          )
        )}

        {/* 액션 */}
        <div style={st.actions}>
          {state.kind !== 'alert' && (
            <button onClick={onCancel} style={st.btnSecondary}>
              {state.cancelLabel}
            </button>
          )}
          <button ref={confirmRef}
            onClick={() => onConfirm(state.kind === 'prompt' ? val : true)}
            style={{
              ...st.btnPrimary,
              background: accent,
              color: tone === 'warn' ? 'var(--text)' : 'white',
            }}>
            {state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const TONE_COLOR = {
  info:    'var(--primary)',
  success: 'var(--accent)',
  warn:    'var(--warning, #fbbf24)',
  danger:  'var(--danger)',
};
const TONE_ICON = {
  info:    'spark',
  success: 'spark',
  warn:    'warn',
  danger:  'warn',
};

const st = {
  backdrop: {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'rgba(0, 0, 0, 0.5)',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16,
    animation: 'fadeInUp .15s ease-out',
  },
  modal: {
    background: 'var(--surface)',
    color: 'var(--text)',
    borderRadius: 16,
    boxShadow: '0 20px 60px rgba(0,0,0,.4), 0 4px 12px rgba(0,0,0,.2)',
    width: '100%', maxWidth: 380,
    overflow: 'hidden',
    animation: 'fadeInUp .18s ease-out',
    border: '1px solid var(--border)',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '18px 18px 12px',
  },
  iconWrap: {
    width: 40, height: 40, borderRadius: 12,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  title: {
    fontSize: 16, fontWeight: 700, color: 'var(--text)',
    lineHeight: 1.3,
  },
  closeBtn: {
    width: 28, height: 28, borderRadius: 8,
    background: 'transparent', color: 'var(--text-3)',
    border: 'none', cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  body: {
    padding: '0 18px 16px 70px',
    fontSize: 13, lineHeight: 1.55,
    color: 'var(--text-2)',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  },
  input: {
    display: 'block', width: 'calc(100% - 36px)', margin: '0 18px 16px',
    padding: '10px 12px',
    background: 'var(--surface-2)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 8,
    fontSize: 14, boxSizing: 'border-box',
    outline: 'none',
  },
  actions: {
    display: 'flex', gap: 8,
    padding: '12px 18px 18px',
  },
  btnPrimary: {
    flex: 1, padding: '11px 16px',
    background: 'var(--primary)', color: 'white',
    border: 'none', borderRadius: 8,
    fontSize: 13, fontWeight: 600, cursor: 'pointer',
    transition: 'transform .08s, opacity .12s',
  },
  btnSecondary: {
    flex: 1, padding: '11px 16px',
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 8,
    fontSize: 13, fontWeight: 500, cursor: 'pointer',
  },
};
