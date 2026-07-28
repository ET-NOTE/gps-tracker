// WebSocket client for real-time GPS events.
// 도메인별 prefix 분기:
//   gps.serial.kr → /ws/realtime (주 도메인)
//   legacy /gps-tracker/ 서브패스 → /gps-tracker/ws/realtime
import { activeStorage, tryRefresh, isTokenExpiringSoon } from './api';
import { chatBus } from './lib/chatBus';

function buildWsUrl() {
  if (!import.meta.env.PROD) return 'wss://gps.serial.kr/ws/realtime';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const path  = location.hostname === 'gps.serial.kr' ? '/ws/realtime' : '/gps-tracker/ws/realtime';
  return `${proto}://${location.host}${path}`;
}
const WS_URL = buildWsUrl();

export class TrackerWS {
  constructor(onEvent, onStatus) {
    this.onEvent = onEvent;
    this.onStatus = onStatus;   // ('connected' | 'disconnected') => void
    this.token = null;
    this.socket = null;
    this.subscribed = new Set();
    this._timer = null;
    this._dead = false;
    // (F0-4) 재연결 exp backoff — 5s 고정이 아니라 1s→30s cap 로 지수 증가 + jitter.
    // 대량 client 가 서버 죽음 → 동시 재접속으로 thundering herd 되는 것 방지.
    // 성공 (onopen) 시 리셋. 스킬 순서: 1s, 2s, 4s, 8s, 16s, 30s cap.
    this._reconnectAttempts = 0;
    // (F3) rAF coalesce — WS onmessage 폭주 시 매 프레임에 한 번만 flush.
    // 100대 device 가 동시에 fix POST → onmessage 100 회 → 100 회 React setState
    // → 프레임 드롭 60fps → <10fps 문제 정면 해소.
    // location message 만 batch (wake/sleep 은 실시간성 중요, 즉시 dispatch).
    this._pending = [];
    this._rafScheduled = false;
  }

  _reconnectDelay() {
    const base = Math.min(30_000, 1000 * Math.pow(2, this._reconnectAttempts));
    const jitter = Math.random() * base * 0.3;   // ±30%
    this._reconnectAttempts++;
    return Math.round(base + jitter);
  }

  connect(token) {
    this.token = token;
    this._open();
  }

  async _open() {
    if (this._dead) return;
    // 매 재연결 시 activeStorage 에서 최신 토큰 — refresh 로 갱신된 토큰 반영.
    // localStorage 만 보면 remember_me=false (sessionStorage) 사용자가 WS 못 받음.
    const s = activeStorage();
    let t = s ? s.getItem('access_token') : null;
    // 만료 임박/만료된 토큰이면 먼저 refresh 후 최신 토큰으로 연결.
    // (REST 는 401→tryRefresh 로 자동 갱신되지만 WS handshake 는 그 경로가 없어
    //  만료 토큰으로 무한 401 fail loop 에 빠짐 — 24h+ 창 방치 사용자 실사례.)
    if (t && isTokenExpiringSoon(t, 60_000)) {
      const r = await tryRefresh();
      if (r === 'unauth') {
        // refresh 도 만료/취소 — 로그아웃 상태. 재시도 무의미하니 조용히 종료.
        this.onStatus?.('disconnected');
        this._dead = true;
        return;
      }
      const s2 = activeStorage();
      t = s2 ? s2.getItem('access_token') : null;
    }
    if (t) this.token = t;
    if (!this.token) {
      // 토큰 없으면 exp backoff 로 재시도 (로그인 직후 등)
      this._timer = setTimeout(() => this._open(), this._reconnectDelay());
      return;
    }
    const sock = new WebSocket(`${WS_URL}?token=${this.token}`);
    this.socket = sock;

    sock.onopen = () => {
      this._reconnectAttempts = 0;   // (F0-4) 성공 시 backoff 리셋
      this.onStatus?.('connected');
      if (this.subscribed.size > 0) {
        this._send({ action: 'subscribe', device_ids: [...this.subscribed] });
      }
    };

    sock.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      // (F7-b) chat_message 는 device 컨텍스트와 무관 — chatBus 로 직접 fan-out.
      // ChatPanel / useChatUnread 는 chatBus.subscribe 로 즉시 반영.
      if (msg?.type === 'chat_message') {
        chatBus.publish(msg.message || msg);
        return;
      }
      // (F3) location fix 만 rAF batch — 폭주 시 프레임당 한 번 flush.
      // 상태 event (wake/sleep/rental_*) 는 즉시 dispatch (실시간성 우선).
      if (msg?.type === 'location') {
        this._pending.push(msg);
        if (!this._rafScheduled) {
          this._rafScheduled = true;
          const flush = () => {
            this._rafScheduled = false;
            const batch = this._pending;
            this._pending = [];
            for (const m of batch) {
              try { this.onEvent(m); } catch { /* ignore consumer err */ }
            }
          };
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
          else setTimeout(flush, 16);
        }
      } else {
        try { this.onEvent(msg); } catch { /* noop */ }
      }
    };

    sock.onclose = () => {
      this.onStatus?.('disconnected');
      if (!this._dead) {
        this._timer = setTimeout(() => this._open(), this._reconnectDelay());
      }
    };
  }

  subscribe(deviceIds) {
    deviceIds.forEach(id => this.subscribed.add(id));
    if (this.socket?.readyState === WebSocket.OPEN) {
      this._send({ action: 'subscribe', device_ids: deviceIds });
    }
  }

  _send(obj) {
    this.socket?.send(JSON.stringify(obj));
  }

  disconnect() {
    this._dead = true;
    clearTimeout(this._timer);
    this.socket?.close();
  }
}
