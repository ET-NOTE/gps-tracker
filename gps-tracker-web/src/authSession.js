// Refresh keeps this scope; login/logout create a new one so late work cannot cross accounts.
export const AUTH_CHANGED = 'gps-auth-changed';
export function authScope() {
  const s = localStorage.getItem('access_token') ? localStorage : sessionStorage;
  const token = s.getItem('access_token');
  if (!token) return 'anonymous';
  return s.getItem('auth_session') || token.split('.')[1] || token;
}
export function assertSession(scope) {
  if (scope !== authScope()) throw new DOMException('계정이 변경되었습니다.', 'AbortError');
}
export function notifyAuthChanged() {
  window.dispatchEvent(new Event(AUTH_CHANGED));
}
