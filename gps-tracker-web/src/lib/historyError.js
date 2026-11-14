// Server internals are useful in logs, but not as a map status message.
export function historyError(error, fallback) {
  if (error?.status === 429) return '조회가 많습니다. 잠시 후 다시 시도해 주세요.';
  if (error?.status === 408) return '조회 시간이 초과되었습니다. 기간을 줄여 다시 조회해 주세요.';
  if (error?.status === 401) return '로그인이 만료되었습니다. 다시 로그인해 주세요.';
  if (error?.status === 403 || error?.status === 404) return '이 단말기의 조회 권한을 확인해 주세요.';
  if (error?.status >= 500 || /database error|internal server error/i.test(error?.message || '')) return fallback;
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(error?.message || '')) {
    return '서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.';
  }
  return error?.message || fallback;
}
