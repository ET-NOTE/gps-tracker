// (2026-07-28) Phase F6-a-1 — WS lifecycle slice hook.
//
// Dashboard.jsx 의 60+ useState + 100줄 handleWsEvent 중 WS 연결·재연결·상태·subscribe
// 부분만 추출. handleWsEvent 콜백은 caller 소유 (Dashboard 의 refs 들과 얽혀 있어 추출하기
// 어렵고, 이 hook 은 pure lifecycle 담당).
//
// 사용:
//   const { status, subscribe } = useLiveWS({
//     onEvent: (msg) => { ... },
//     enabled: authed,        // false 면 disconnect + no reconnect
//   });
//   useEffect(() => { subscribe(devices.map(d => d.id)); }, [devices]);

import { useEffect, useRef, useState } from 'react';
import { TrackerWS } from '../ws';

export function useLiveWS({ onEvent, enabled = true }) {
  const [status, setStatus] = useState('disconnected');
  const wsRef = useRef(null);
  // onEvent 를 ref 로 잡아 — 매 렌더마다 새 함수 identity 여도 WS 재연결 안 됨.
  const onEventRef = useRef(onEvent);
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);

  useEffect(() => {
    if (!enabled) return;
    const ws = new TrackerWS(
      (msg) => onEventRef.current?.(msg),
      (s) => setStatus(s),
    );
    // TrackerWS.connect 는 첫 token 을 인자로 받지만 내부에서 activeStorage 재조회 하므로
    // null 전달해도 무방. localStorage 명시로 하위 호환 유지.
    ws.connect(typeof localStorage !== 'undefined' ? localStorage.getItem('access_token') : null);
    wsRef.current = ws;
    return () => {
      ws.disconnect();
      wsRef.current = null;
    };
  }, [enabled]);

  const subscribe = (deviceIds) => {
    wsRef.current?.subscribe(deviceIds || []);
  };

  return { status, subscribe };
}
