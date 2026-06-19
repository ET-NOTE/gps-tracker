// 사용자 ↔ 관리자 채팅 (사용자 측). 5초 폴링, after_id 로 incremental fetch.
// onRead: unread 가 0 으로 마킹되면 부모 뱃지 갱신.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import Icon from './Icon';

const POLL_MS = 5000;

export default function ChatPanel({ onRead }) {
  const [messages, setMessages] = useState([]);
  const [text,     setText]     = useState('');
  const [busy,     setBusy]     = useState(false);
  const lastIdRef = useRef(0);
  const scrollRef = useRef(null);

  async function loadInitial() {
    try {
      const list = await api.chatMyMessages();
      setMessages(list || []);
      if (list && list.length > 0) lastIdRef.current = list[list.length - 1].id;
      try { await api.chatMarkReadUser(); } catch {}
      onRead?.();
    } catch (e) { console.error(e); }
  }

  async function pollNew() {
    try {
      const list = await api.chatMyMessages(lastIdRef.current);
      if (list && list.length > 0) {
        setMessages(prev => [...prev, ...list]);
        lastIdRef.current = list[list.length - 1].id;
        try { await api.chatMarkReadUser(); } catch {}
        onRead?.();
      }
    } catch { /* noop */ }
  }

  useEffect(() => {
    loadInitial();
    const iv = setInterval(pollNew, POLL_MS);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      lastIdRef.current = msg.id;
      setText('');
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  // system 메시지 연속 여러 개를 그룹으로 묶기
  const grouped = [];
  for (const m of messages) {
    if (m.sender_role === 'system') {
      const last = grouped[grouped.length - 1];
      if (last?.type === 'system-group') {
        last.items.push(m);
      } else {
        grouped.push({ type: 'system-group', items: [m], key: m.id });
      }
    } else {
      grouped.push({ type: 'msg', data: m, key: m.id });
    }
  }

  return (
    <div style={s.wrap}>
      {/* 헤더 */}
      <div style={s.header}>
        <div style={s.headerAvatar}>A</div>
        <div>
          <div style={s.headerName}>관리자 채팅</div>
          <div style={s.headerSub}>SIM 충전, 결제, 기타 문의</div>
        </div>
      </div>

      {/* 메시지 영역 */}
      <div ref={scrollRef} style={s.scroll}>
        {messages.length === 0 && (
          <div style={s.empty}>
            <Icon name="message" size={28} />
            <div style={{ marginTop: 8 }}>관리자에게 문의하세요</div>
            <div style={{ fontSize: 11, marginTop: 4, color: 'var(--text-3)' }}>SIM 충전, 결제, 기타 무엇이든</div>
          </div>
        )}

        {grouped.map(g => {
          if (g.type === 'system-group') {
            return <SystemGroup key={g.key} items={g.items} />;
          }
          return <Bubble key={g.key} m={g.data} />;
        })}
      </div>

      {/* 입력창 */}
      <div style={s.inputRow}>
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="메시지를 입력하세요..."
          style={s.input}
        />
        <button onClick={send} disabled={busy || !text.trim()} style={{
          ...s.sendBtn,
          opacity: (busy || !text.trim()) ? 0.4 : 1,
        }} aria-label="전송">
          <Icon name="send" size={15} />
        </button>
      </div>
    </div>
  );
}

// system 메시지 여러 개를 접을 수 있는 그룹
function SystemGroup({ items }) {
  const [open, setOpen] = useState(false);
  const preview = items[items.length - 1].body;
  const count = items.length;

  return (
    <div style={{ margin: '8px 0', textAlign: 'center' }}>
      <button onClick={() => setOpen(o => !o)} style={sg.toggle}>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={10} />
        <span>{open ? '접기' : `시스템 알림 ${count}건`}</span>
        {!open && <span style={sg.preview}> · {preview.length > 20 ? preview.slice(0, 20) + '…' : preview}</span>}
      </button>
      {open && (
        <div style={sg.list}>
          {items.map(m => (
            <div key={m.id} style={sg.item}>{m.body}</div>
          ))}
        </div>
      )}
    </div>
  );
}

const sg = {
  toggle: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '3px 10px', borderRadius: 20,
    background: 'var(--surface-2)', border: '1px solid var(--border)',
    fontSize: 10, color: 'var(--text-3)', cursor: 'pointer',
  },
  preview: { color: 'var(--text-2)', fontStyle: 'italic' },
  list: {
    marginTop: 4, padding: '6px 12px',
    background: 'var(--surface-2)', borderRadius: 8,
    border: '1px solid var(--border)',
    display: 'inline-block', textAlign: 'left', maxWidth: '85%',
  },
  item: {
    fontSize: 11, color: 'var(--text-2)', padding: '2px 0',
    borderBottom: '1px solid var(--border)',
  },
};

function Bubble({ m }) {
  const mine = m.sender_role === 'user';

  const time = new Date(m.created_at).toLocaleString('ko-KR', {
    month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  return (
    <div style={{
      display: 'flex',
      flexDirection: mine ? 'row-reverse' : 'row',
      alignItems: 'flex-end',
      gap: 6, margin: '6px 0',
    }}>
      {/* 관리자 아바타 */}
      {!mine && (
        <div style={b.avatar}>A</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start', maxWidth: '72%' }}>
        {!mine && <div style={b.senderName}>관리자</div>}
        <div style={{
          padding: '9px 12px', borderRadius: 14, fontSize: 13,
          background: mine ? 'var(--primary)' : 'var(--surface)',
          color: mine ? 'white' : 'var(--text)',
          borderBottomRightRadius: mine ? 4 : 14,
          borderBottomLeftRadius:  mine ? 14 : 4,
          boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          lineHeight: 1.45,
        }}>
          {m.body}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 3, paddingInline: 2 }}>{time}</div>
      </div>
    </div>
  );
}

const b = {
  avatar: {
    width: 28, height: 28, borderRadius: 14, flexShrink: 0,
    background: 'var(--primary)', color: 'white',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 12, fontWeight: 700, marginBottom: 18,
  },
  senderName: {
    fontSize: 10, color: 'var(--text-2)', marginBottom: 3, paddingInline: 2,
  },
};

const s = {
  wrap: {
    display: 'flex', flexDirection: 'column',
    flex: 1, minHeight: 0,
    background: 'var(--bg)',
    borderRadius: 6, overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '12px 14px',
    background: 'var(--surface)',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  headerAvatar: {
    width: 36, height: 36, borderRadius: 18,
    background: 'var(--primary)', color: 'white',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 14, fontWeight: 700, flexShrink: 0,
  },
  headerName: { fontSize: 14, fontWeight: 700, color: 'var(--text)' },
  headerSub:  { fontSize: 11, color: 'var(--text-3)', marginTop: 1 },
  scroll: {
    flex: 1, padding: '12px 10px', overflowY: 'auto',
  },
  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', height: '100%', minHeight: 160,
    color: 'var(--text-3)', fontSize: 13,
  },
  inputRow: {
    display: 'flex', gap: 6, padding: '8px 10px',
    borderTop: '1px solid var(--border)',
    background: 'var(--surface)',
    flexShrink: 0,
  },
  input: {
    flex: 1, padding: '9px 12px',
    background: 'var(--surface-2)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 20, fontSize: 13,
    outline: 'none',
  },
  sendBtn: {
    width: 38, height: 38,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--primary)', color: 'white',
    border: 'none', borderRadius: 19, cursor: 'pointer',
    flexShrink: 0, transition: 'opacity 0.15s',
  },
};
