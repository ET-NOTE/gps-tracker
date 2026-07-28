// (2026-07-29 F7-b) Chat WS 메시지 module-level bus.
//
// 배경: ChatPanel 은 이전엔 5초 polling, useChatUnread 는 10초 polling.
// 백엔드는 이제 chat_message event 를 WS 로 push (routes/chat.rs).
// TrackerWS 는 Dashboard 에서만 인스턴스화 되므로, 그 onEvent 콜백이
// chat_message 를 chatBus.publish 로 fan-out. ChatPanel / useChatUnread 는
// chatBus.subscribe 로 즉시 반영. Polling 은 fallback (30s) 로 남김 —
// WS 유실 시 데이터 정합 회복 안전망.
//
// 사용:
//   import { chatBus } from './lib/chatBus';
//   const unsub = chatBus.subscribe(msg => { ... });   // msg = { id, thread_id, sender_role, sender_id, body, created_at }
//   chatBus.publish(msg);

const listeners = new Set();

export const chatBus = {
  subscribe(cb) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },
  publish(msg) {
    for (const cb of listeners) {
      try { cb(msg); } catch { /* consumer 오류로 다른 구독자 막지 않음 */ }
    }
  },
};
