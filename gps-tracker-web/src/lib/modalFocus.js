// One owner for focus/scroll locking, including nested dialogs.
const stack = [];
const originalInert = new Map();
let originalOverflow;
const selector = 'button:not(:disabled),a[href],input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

function syncBackground() {
  for (const [node, value] of originalInert) node.inert = value;
  const top = stack.at(-1);
  if (!top) { originalInert.clear(); return; }
  for (const node of document.body.children) {
    if (!originalInert.has(node)) originalInert.set(node, !!node.inert);
    node.inert = node !== top.backdrop;
  }
}

export function lockModalFocus(dialog, backdrop, options) {
  const opener = document.activeElement;
  const entry = { dialog, backdrop };
  if (!stack.length) {
    originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  stack.push(entry);
  syncBackground();
  const items = () => Array.from(dialog.querySelectorAll(selector)).filter(node =>
    node.tabIndex >= 0 && !node.closest('[inert]') && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
  const focusFirst = () => {
    const fields = items();
    const initial = options().initialFocus?.current || fields.find(node => node.matches('[autofocus],input,select,textarea')) || fields[0] || dialog;
    initial.focus({ preventScroll: true });
  };
  focusFirst();
  const keydown = event => {
    if (stack.at(-1) !== entry) return;
    if (event.key === 'Escape') {
      event.stopImmediatePropagation();
      if (options().closeOnEsc) { event.preventDefault(); options().onClose?.(); }
    }
    if (event.key !== 'Tab') return;
    const fields = items(), active = document.activeElement;
    if (!fields.length || !dialog.contains(active) ||
      (event.shiftKey ? active === fields[0] || active === dialog : active === fields.at(-1))) {
      event.preventDefault();
      (event.shiftKey ? fields.at(-1) || dialog : fields[0] || dialog).focus();
    }
  };
  const focusin = () => {
    if (stack.at(-1) === entry && !dialog.contains(document.activeElement)) focusFirst();
  };
  document.addEventListener('keydown', keydown, true);
  document.addEventListener('focusin', focusin);
  // Include body-level portals inserted while the modal is open.
  const observer = new MutationObserver(syncBackground);
  observer.observe(document.body, { childList: true });
  return () => {
    observer.disconnect();
    document.removeEventListener('keydown', keydown, true);
    document.removeEventListener('focusin', focusin);
    const wasTop = stack.at(-1) === entry;
    stack.splice(stack.indexOf(entry), 1);
    syncBackground();
    if (!stack.length) document.body.style.overflow = originalOverflow;
    if (wasTop && opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
  };
}
