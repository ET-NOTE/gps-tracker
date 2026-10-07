const KAKAO_MAP_SDK_SRC = 'https://dapi.kakao.com/v2/maps/sdk.js?appkey=760ec0841163d1ee2cc5fef220a9df0b&libraries=services,clusterer&autoload=false';

export function ensureKakaoMapSdk() {
  if (typeof window === 'undefined') return Promise.reject(new Error('window is unavailable'));
  if (window.kakao?.maps) return Promise.resolve(window.kakao);
  const existing = document.querySelector('script[data-kakao-map-sdk="true"], script[src*="dapi.kakao.com/v2/maps/sdk.js"]');
  if (existing) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (window.kakao?.maps) {
          clearInterval(timer);
          resolve(window.kakao);
        } else if (Date.now() - startedAt > 8000) {
          clearInterval(timer);
          reject(new Error('Kakao Maps SDK did not become available'));
        }
      }, 100);
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.async = true;
    script.dataset.kakaoMapSdk = 'true';
    script.src = KAKAO_MAP_SDK_SRC;
    script.onload = () => (window.kakao?.maps ? resolve(window.kakao) : reject(new Error('Kakao Maps SDK loaded without maps')));
    script.onerror = () => reject(new Error('Failed to load Kakao Maps SDK'));
    document.head.appendChild(script);
  });
}
