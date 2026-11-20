import { useEffect, useRef, useState } from 'react';

export function readDeviceLink(search) {
  const query = new URLSearchParams(search);
  if (!query.has('device')) return { present: false };
  const values = query.getAll('device'), value = values[0];
  const id = /^\d+$/.test(value) ? Number(value) : NaN;
  return { present: true, id: values.length === 1 && Number.isSafeInteger(id) && id > 0 ? id : null };
}
export function withoutDeviceLink(search) {
  const query = new URLSearchParams(search); query.delete('device');
  return query.size ? `?${query}` : '';
}

// A notification is an explicit user intent. Do not fall back to a different car.
export function useDeviceDeepLink({ search, devices, loaded, ready, onSelect, onConsume }) {
  const handled = useRef(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const target = readDeviceLink(search);
    if (!target.present) { handled.current = null; return; }
    if (!loaded || !ready || handled.current === search) return;
    handled.current = search;
    const owned = target.id != null && devices.some(device => device.id === target.id);
    onSelect(owned ? target.id : null);
    setNotice(owned ? '' : '알림의 단말기를 찾을 수 없습니다. 연결된 단말기 목록을 확인해 주세요.');
    onConsume(withoutDeviceLink(search));
  }, [search, devices, loaded, ready, onSelect, onConsume]);
  return { notice, dismiss: () => setNotice('') };
}
