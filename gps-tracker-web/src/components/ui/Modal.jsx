// (2026-07-28) Phase F1 primitive — 표준 Modal.
//
// 감사 결과: 22개 파일에서 각자 `position:fixed;inset:0;background:rgba(0,0,0,.5)` 백드롭 구현.
// 각자 다른 padding/radius/z-index. 이 컴포넌트로 통일.
//
// 사용:
//   <Modal open={open} onClose={close} title="제목">...</Modal>
//   <Modal open size="lg" title="넓은 모달">...</Modal>       // size: sm|md|lg|xl|full
//   <Modal open onClose={close} closeOnBackdrop={false}>...</Modal>
//   <Modal open footer={<button ...>저장</button>}>...</Modal>
//
// 접근성: Esc 로 닫기, backdrop 클릭 닫기 (opt-out 가능),
//         내부 스크롤 (긴 폼 대응), scroll lock (body overflow hidden).

import { useEffect } from 'react';

const SIZE = {
  sm:   360,
  md:   460,
  lg:   640,
  xl:   860,
  full: '95vw',
};

export default function Modal({
  open,
  onClose,
  title,
  subtitle,
  size = 'md',
  closeOnBackdrop = true,
  closeOnEsc = true,
  footer,
  children,
  bodyStyle,
}) {
  // Esc 로 닫기
  useEffect(() => {
    if (!open || !closeOnEsc) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeOnEsc, onClose]);

  // scroll lock — 여러 모달 스택 시엔 counter 필요하지만 우리 UI 는 stack 안 함
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  const maxWidth = SIZE[size] ?? size;

  return (
    <div
      onClick={closeOnBackdrop ? onClose : undefined}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.5)',
        zIndex: 'var(--z-modal)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--space-2)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        style={{
          background: 'var(--surface)',
          color: 'var(--text)',
          borderRadius: 'var(--radius-xl)',
          padding: 'var(--space-4)',
          width: '100%',
          maxWidth,
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
          boxSizing: 'border-box',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        {(title != null || subtitle != null) && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2)' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              {title != null && (
                <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>{title}</div>
              )}
              {subtitle != null && (
                <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>{subtitle}</div>
              )}
            </div>
            {onClose && (
              <button
                onClick={onClose}
                aria-label="닫기"
                style={{
                  background: 'transparent', color: 'var(--text-2)',
                  border: 'none', cursor: 'pointer',
                  padding: 'var(--space-1) var(--space-2)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 18, lineHeight: 1,
                }}
              >×</button>
            )}
          </div>
        )}
        <div style={{
          overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 'var(--space-3)',
          minHeight: 0, flex: 1,
          ...bodyStyle,
        }}>
          {children}
        </div>
        {footer && (
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-1)' }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
