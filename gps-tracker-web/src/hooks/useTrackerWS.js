// useTrackerWS.js — TrackerWS lifecycle hook'i.
// WebSocket ulanishi mount/unmount da avtomatik boshqariladi.
// onEvent ref'i orqali stale closure'dan xalos — har re-render'da WS qayta yaratilmaydi.
import { useState, useEffect, useRef } from 'react';
import { TrackerWS } from '../ws';

/**
 * @param {function} onEvent - WebSocket event handler (stale bo'lsa ham ref orqali yangilanadi)
 * @returns {{ wsRef: React.MutableRefObject, status: string }}
 */
export function useTrackerWS(onEvent) {
  const [status, setStatus] = useState('disconnected');
  const wsRef      = useRef(null);
  const onEventRef = useRef(onEvent);

  // Handler yangilanganda ref'ni yangilaymiz — WS qayta yaratilmaydi
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    const ws = new TrackerWS(
      (evt) => onEventRef.current(evt),
      setStatus,
    );
    ws.connect(localStorage.getItem('access_token'));
    wsRef.current = ws;
    return () => ws.disconnect();
  }, []); // faqat mount/unmount

  return { wsRef, status };
}
