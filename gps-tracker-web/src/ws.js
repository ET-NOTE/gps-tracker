// WebSocket client for real-time GPS events.
// 도메인별 prefix 분기:
//   gps.serial.kr → /ws/realtime (clean)
//   기타 (seriallog.com 등) → /gps-tracker/ws/realtime
import { activeStorage, tryRefresh, isTokenExpiringSoon } from './api';

function buildWsUrl() {
  if (!import.meta.env.PROD) return 'wss://seriallog.com/gps-tracker/ws/realtime';
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
      // 토큰 없으면 5초 후 재시도 (로그인 직후 등)
      this._timer = setTimeout(() => this._open(), 5000);
      return;
    }
    const sock = new WebSocket(`${WS_URL}?token=${this.token}`);
    this.socket = sock;

    sock.onopen = () => {
      this.onStatus?.('connected');
      if (this.subscribed.size > 0) {
        this._send({ action: 'subscribe', device_ids: [...this.subscribed] });
      }
    };

    sock.onmessage = (e) => {
      try { this.onEvent(JSON.parse(e.data)); } catch { /* ignore malformed */ }
    };

    sock.onclose = () => {
      this.onStatus?.('disconnected');
      if (!this._dead) {
        this._timer = setTimeout(() => this._open(), 5000);
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
