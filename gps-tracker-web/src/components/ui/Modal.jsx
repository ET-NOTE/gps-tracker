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

import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { lockModalFocus } from '../../lib/modalFocus';

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
  mobileForm = false,
  placement = 'center',
  footer,
  children,
  bodyStyle,
}) {
  const dialog = useRef(null), backdrop = useRef(null), anchor = useRef(null);
  const options = useRef({ onClose, closeOnEsc });
  options.current = { onClose, closeOnEsc };
  useLayoutEffect(() => {
    if (!open || !dialog.current) return;
    const layer = backdrop.current;
    layer.classList.toggle('gps-member-modal', !!anchor.current?.closest('.pt-member-shell, .gps-member-modal, .business-drawer'));
    layer.classList.toggle('gps-business-modal', !!anchor.current?.closest('.business-workspace, .business-drawer, .gps-business-modal'));
    const touchForm = mobileForm && window.matchMedia('(pointer: coarse) and (max-width: 950px)').matches;
    const unlock = lockModalFocus(dialog.current, layer, () => ({ ...options.current, initialFocus: touchForm ? dialog : undefined }));
    const viewport = touchForm && window.visualViewport;
    if (!viewport) return unlock;

    // Android can resize and pan only the visual viewport when the keyboard opens.
    layer.style.setProperty('--form-dialog-max-height', 'min(92dvh, 100%)');
    const fit = () => {
      layer.style.setProperty('--form-viewport-top', `${viewport.offsetTop}px`);
      layer.style.setProperty('--form-viewport-height', `${viewport.height}px`);
    };
    fit();
    viewport.addEventListener('resize', fit);
    viewport.addEventListener('scroll', fit);
    return () => {
      viewport.removeEventListener('resize', fit);
      viewport.removeEventListener('scroll', fit);
      layer.style.removeProperty('--form-dialog-max-height');
      layer.style.removeProperty('--form-viewport-top');
      layer.style.removeProperty('--form-viewport-height');
      unlock();
    };
  }, [open, mobileForm]);

  if (!open) return null;

  const maxWidth = SIZE[size] ?? size;

  return <><span ref={anchor} hidden />{createPortal(
    <div
      ref={backdrop}
      className="gps-modal-backdrop"
      data-placement={placement}
      onClick={closeOnBackdrop ? onClose : undefined}
      style={{
        position: 'fixed', inset: 0,
        ...(mobileForm && { top: 'var(--form-viewport-top, 0px)', height: 'var(--form-viewport-height, auto)', boxSizing: 'border-box' }),
        background: 'rgba(0,0,0,0.5)',
        zIndex: 'var(--z-modal)',
        display: 'flex', alignItems: placement === 'end' ? 'stretch' : 'center', justifyContent: placement === 'end' ? 'flex-end' : 'center',
        padding: placement === 'end' ? 0 : 'var(--space-2)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        className="gps-user-panel gps-modal"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        style={{
          background: 'var(--surface)',
          color: 'var(--text)',
          borderRadius: placement === 'end' ? 0 : 'var(--radius-xl)',
          padding: 'var(--modal-padding, var(--space-4))',
          width: '100%',
          maxWidth,
          maxHeight: placement === 'end' ? '100%' : mobileForm ? 'var(--form-dialog-max-height, 92dvh)' : '92dvh',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--modal-gap, var(--space-3))',
          boxSizing: 'border-box',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        {(title != null || subtitle != null) && (
          <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0, gap: 'var(--space-2)' }}>
            <div style={{ minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}>
              {title != null && (
                <div style={{ fontSize: 'var(--modal-title-size, 15px)', fontWeight: 'var(--modal-title-weight, 800)', color: 'var(--text)' }}>{title}</div>
              )}
              {subtitle != null && (
                <div style={{ fontSize: 'var(--modal-subtitle-size, 12px)', color: 'var(--text-2)', marginTop: 4 }}>{subtitle}</div>
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
                  fontSize: 18, lineHeight: 1, minWidth: 44, minHeight: 44, flexShrink: 0,
                }}
              >×</button>
            )}
          </div>
        )}
        <div className="gps-modal-body" style={{
          overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 'var(--space-3)',
          minHeight: 0, flex: 1,
          ...bodyStyle,
        }}>
          {children}
        </div>
        {footer && (
          <div style={{ display: 'flex', flexShrink: 0, gap: 'var(--space-2)', marginTop: 'var(--space-1)' }}>
            {footer}
          </div>
        )}
      </div>
    </div>, document.body
  )}</>;
}
