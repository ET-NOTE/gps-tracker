import { lockModalFocus } from '../../lib/modalFocus';
import { useContext, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../Icon';
import { WorkspaceHeaderContext } from './WorkspaceHeader';
import './workspace-navigation.css';

export default function BusinessDrawer({ title, subtitle, onClose, children, navigation = false, onHome }) {
  const member = useContext(WorkspaceHeaderContext);
  const panel = useRef(null), backdrop = useRef(null), close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => lockModalFocus(panel.current, backdrop.current,
    () => ({ closeOnEsc: true, onClose: close.current, initialFocus: navigation ? panel : undefined })), [navigation]);
  return createPortal(<div ref={backdrop} className={navigation ? 'business-drawer-backdrop corporate-phone-menu' : 'business-drawer-backdrop'} data-member-navigation={navigation && member ? true : undefined} onClick={onClose}>
    <section ref={panel} tabIndex={-1} className="business-drawer gps-user-panel" role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
      <header><div>{navigation && onHome
        ? <button type="button" className="ws-nav-brand" onClick={onHome} aria-label={title+' 운영 현황'}><span><Icon name="car" size={17}/></span>{title}</button>
        : <h2>{title}</h2>}{subtitle && <p>{subtitle}</p>}</div><button type="button" className="business-button" onClick={onClose} aria-label={navigation ? '메뉴 닫기' : '상세 닫기'}>×</button></header>
      <div className="business-drawer-body">{children}</div>
    </section>
  </div>, document.body);
}
