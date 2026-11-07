import { lockModalFocus } from '../../lib/modalFocus';
import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export default function BusinessDrawer({ title, subtitle, onClose, children }) {
  const panel = useRef(null), backdrop = useRef(null), close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => lockModalFocus(panel.current, backdrop.current,
    () => ({ closeOnEsc: true, onClose: close.current })), []);
  return createPortal(<div ref={backdrop} className="business-drawer-backdrop" onClick={onClose}>
    <section ref={panel} tabIndex={-1} className="business-drawer gps-user-panel" role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
      <header><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button type="button" className="business-button" onClick={onClose} aria-label="상세 닫기">×</button></header>
      <div className="business-drawer-body">{children}</div>
    </section>
  </div>, document.body);
}
