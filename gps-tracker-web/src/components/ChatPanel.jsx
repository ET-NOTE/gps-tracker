// 사용자 ↔ 관리자 채팅 (사용자 측).
// (F7-b) WS chat_message push → chatBus 로 즉시 반영. Polling 은 30s fallback
//        (WS 유실/재연결 갭 대비 안전망).
// onRead: unread 가 0 으로 마킹되면 부모 뱃지 갱신.
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { chatBus } from '../lib/chatBus';
import Icon from './Icon';

const POLL_MS = 30_000;

export default function ChatPanel({ onRead }) {
  const [messages, setMessages] = useState([]);
  const [text,     setText]     = useState('');
  const [busy,     setBusy]     = useState(false);
  const lastIdRef = useRef(0);
  const scrollRef = useRef(null);
  const qc = useQueryClient();
  // (F2-c) unread 캐시 갱신 helper — ProfilePanel 뱃지 자동 반영.
  const markUnreadZero = () => qc.setQueryData(['chat-unread'], 0);

  async function loadInitial() {
    try {
      const list = await api.chatMyMessages();
      const initial = list || [];
      const initialLastId = initial.length ? initial[initial.length - 1].id : 0;
      // (F7-d) 로딩 중 WS 로 append 된 message (id > initialLastId) 는 유지.
      // 이전엔 setMessages(list||[]) 로 무조건 대체 → race 로 도착한 admin push 유실.
      setMessages(prev => {
        const extras = prev.filter(m => m.id > initialLastId);
        return [...initial, ...extras];
      });
      lastIdRef.current = Math.max(lastIdRef.current, initialLastId);
      try { await api.chatMarkReadUser(); markUnreadZero(); } catch {}
      onRead?.();
    } catch (e) { console.error(e); }
  }

  async function pollNew() {
    try {
      const list = await api.chatMyMessages(lastIdRef.current);
      if (list && list.length > 0) {
        setMessages(prev => [...prev, ...list]);
        lastIdRef.current = list[list.length - 1].id;
        // admin 메시지 들어왔으면 read 처리
        try { await api.chatMarkReadUser(); markUnreadZero(); } catch {}
        onRead?.();
      }
    } catch { /* noop */ }
  }

  useEffect(() => {
    loadInitial();
    const iv = setInterval(pollNew, POLL_MS);
    // (F7-b) WS chatBus 구독 — 서버 push 시 즉시 append + dedup (id 기준).
    const unsub = chatBus.subscribe(async (m) => {
      if (!m || !m.id) return;
      if (m.id <= lastIdRef.current) return;   // 이미 반영됨 (poll 이 먼저 가져갔거나 자기 송신 echo)
      lastIdRef.current = m.id;
      setMessages(prev => [...prev, m]);
      // admin 메시지 push 로 도달 시 자동 read 처리 (패널 열려 있을 때만 이 hook 활성)
      if (m.sender_role === 'admin') {
        try { await api.chatMarkReadUser(); markUnreadZero(); } catch {}
        onRead?.();
      }
    });
    return () => { clearInterval(iv); unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 새 메시지 도착 시 스크롤 하단
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  async function send() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const msg = await api.chatSendUser(body);
      setMessages(prev => [...prev, msg]);
      // (F7-d) 자기 송신 완료 사이에 WS 로 admin 답장이 먼저 도착했다면
      // lastIdRef 는 이미 그 id 로 진행됨 — 뒤에 assigned 된 자기 msg.id 로
      // 되돌리면 다음 pollNew(after_id=msg.id) 가 admin 답장 재fetch → duplicate.
      lastIdRef.current = Math.max(lastIdRef.current, msg.id);
      setText('');
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.wrap}>
      <div ref={scrollRef} style={s.scroll}>
        {messages.length === 0 && (
          <div style={s.empty}>
            관리자에게 보낼 메시지를 입력하세요. SIM 충전 요청, 문의 등 무엇이든 좋습니다.
          </div>
        )}
        {messages.map(m => <Bubble key={m.id} m={m} />)}
      </div>
      <div style={s.inputRow}>
        <input value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="메시지를 입력하세요..."
          style={s.input} />
        <button onClick={send} disabled={busy || !text.trim()} style={s.sendBtn} aria-label="전송">
          <Icon name="send" size={16} />
        </button>
      </div>
    </div>
  );
}

function Bubble({ m }) {
  const mine = m.sender_role === 'user';
  const sys  = m.sender_role === 'system';

  if (sys) {
    return (
      <div style={{
        textAlign: 'center', fontSize: 11, color: 'var(--text-3)',
        fontStyle: 'italic', margin: '6px 0',
      }}>{m.body}</div>
    );
  }

  return (
    <div style={{
      display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start',
      margin: '4px 0',
    }}>
      <div style={{
        maxWidth: '78%', padding: '7px 10px', borderRadius: 10, fontSize: 13,
        background: mine ? 'var(--primary)' : 'var(--surface)',
        color:      mine ? 'white' : 'var(--text)',
        borderBottomRightRadius: mine ? 2  : 10,
        borderBottomLeftRadius:  mine ? 10 : 2,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {!mine && (
          <div style={{ fontSize: 10, color: 'var(--text-2)', marginBottom: 2 }}>관리자</div>
        )}
        {m.body}
        <div style={{
          fontSize: 9, opacity: 0.7, marginTop: 3,
          color: mine ? 'rgba(255,255,255,0.85)' : 'var(--text-3)',
          textAlign: 'right',
        }}>
          {new Date(m.created_at).toLocaleString('ko-KR', {
            month: 'numeric', day: 'numeric',
            hour: '2-digit', minute: '2-digit',
          })}
        </div>
      </div>
    </div>
  );
}

const s = {
  wrap: {
    display: 'flex', flexDirection: 'column',
    // 부모(ChatTab) 가 flex 컨테이너 — 남은 높이 전부 차지.
    flex: 1, minHeight: 0,
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 6, overflow: 'hidden',
  },
  scroll: {
    flex: 1, padding: 8, overflowY: 'auto',
    background: 'var(--surface-2)',
  },
  empty: {
    textAlign: 'center', color: 'var(--text-3)',
    fontSize: 12, padding: 24, fontStyle: 'italic',
  },
  inputRow: {
    display: 'flex', gap: 6, padding: 6,
    borderTop: '1px solid var(--border)',
    background: 'var(--surface)',
  },
  input: {
    flex: 1, padding: '8px 10px',
    background: 'var(--surface-2)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6, fontSize: 13,
  },
  sendBtn: {
    width: 38, height: 36,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--primary)', color: 'white',
    border: 'none', borderRadius: 6, cursor: 'pointer',
    flexShrink: 0,
  },
};
