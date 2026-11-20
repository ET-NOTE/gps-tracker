import { useCallback, useEffect, useRef, useState } from 'react';
import { buildNativeTrackingSnapshot } from '../lib/nativeTracking';
import { getDeviceColor, classifyDevice } from '../colors';

export function useNativeTracking({ mapRef, selectedId, devices, lastMetaRef, fences, cached, scope }) {
  const [available, setAvailable] = useState(() => window.GpsTrackingMap?.version === 1);
  const current = useRef(null);
  const session = useRef(null);
  current.current = { selectedId, devices, fences, cached, scope };
  const snapshot = useCallback(() => {
    const args = current.current;
    return buildNativeTrackingSnapshot({ ...args,
      display: mapRef.current?.getNativeTrackingData?.(args.selectedId),
      metadata: lastMetaRef.current,
      colors: Object.fromEntries(args.devices.map(d => [d.id, getDeviceColor(d)])),
      statuses: Object.fromEntries(args.devices.map(d => [d.id, classifyDevice(d, lastMetaRef.current[d.id]).label])),
    });
  }, [mapRef, lastMetaRef]);
  useEffect(() => {
    const ready = () => setAvailable(window.GpsTrackingMap?.version === 1);
    const closed = event => { if (session.current?.id === event.detail?.session) session.current = null; };
    const close = () => { session.current = null; window.GpsTrackingMap?.close().catch(() => {}); };
    window.addEventListener('gps-native-map-ready', ready);
    window.addEventListener('gps-native-map-closed', closed);
    window.addEventListener('gps-auth-clearing', close);
    ready();
    let pending = false;
    const timer = setInterval(async () => {
      const active = session.current;
      if (!active || pending) return;
      if (active.scope !== current.current.scope) { close(); return; }
      const data = snapshot();
      if (!data) { close(); return; }
      pending = true;
      try {
        const result = await window.GpsTrackingMap.update({ session: active.id, snapshot: data });
        if (!result?.ok && session.current === active) close();
      } catch { if (session.current === active) close(); }
      finally { pending = false; }
    }, 1000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('gps-native-map-ready', ready);
      window.removeEventListener('gps-native-map-closed', closed);
      window.removeEventListener('gps-auth-clearing', close);
      if (session.current) close();
    };
  }, [snapshot]);
  const open = useCallback(async () => {
    if (session.current) return null;
    const data = snapshot();
    if (!data) return '선택한 단말기에 수신된 위치가 없습니다. GPS 위치 수신 후 다시 열어 주세요.';
    const active = { id: crypto.randomUUID(), scope: current.current.scope };
    session.current = active;
    try {
      const result = await window.GpsTrackingMap?.open({ session: active.id, snapshot: data });
      if (result?.ok) return null;
    } catch { /* ordinary web map remains usable */ }
    if (session.current === active) session.current = null;
    return '회전 지도를 열지 못했습니다. 앱과 로그인 상태를 확인해 주세요.';
  }, [snapshot]);
  return { available, open };
}
