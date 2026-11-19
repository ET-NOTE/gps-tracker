import { useSyncExternalStore } from 'react';

// Match the phone layout only on screen. Printed reports keep their tables.
const phone = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('screen and (max-width: 600px)')
  : null;

function subscribe(notify) {
  phone?.addEventListener('change', notify);
  return () => phone?.removeEventListener('change', notify);
}

const snapshot = () => phone?.matches ?? false;
export default function useCorporatePhone() {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
