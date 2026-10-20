const KAKAO_MAP_SDK_SRC = 'https://dapi.kakao.com/v2/maps/sdk.js?appkey=760ec0841163d1ee2cc5fef220a9df0b&libraries=services,clusterer&autoload=false';
const LOAD_TIMEOUT_MS = 12_000;
let scriptPromise = null;
let readyPromise = null;

function removeFailedScript() {
  document.querySelectorAll('script[data-kakao-map-sdk="true"], script[src*="dapi.kakao.com/v2/maps/sdk.js"]').forEach(script => script.remove());
}

export function ensureKakaoMapSdk() {
  if (typeof window === 'undefined') return Promise.reject(new Error('window is unavailable'));
  if (window.kakao?.maps) return Promise.resolve(window.kakao);
  if (scriptPromise) return scriptPromise;
  const pending = new Promise((resolve, reject) => {
    let script = document.querySelector('script[data-kakao-map-sdk="true"], script[src*="dapi.kakao.com/v2/maps/sdk.js"]');
    const isNew = !script;
    if (!script) {
      script = document.createElement('script');
      script.async = true;
      script.dataset.kakaoMapSdk = 'true';
      script.src = KAKAO_MAP_SDK_SRC;
    }
    const cleanup = () => {
      clearTimeout(timeout); clearInterval(poll);
      script.removeEventListener('load', loaded); script.removeEventListener('error', failed);
    };
    const loaded = () => {
      if (!window.kakao?.maps) return;
      cleanup(); resolve(window.kakao);
    };
    const failed = () => {
      cleanup(); script.remove(); reject(new Error('지도를 불러오지 못했습니다. 연결 상태를 확인해 주세요.'));
    };
    const timeout = setTimeout(failed, LOAD_TIMEOUT_MS);
    const poll = setInterval(loaded, 100);
    script.addEventListener('load', loaded);
    script.addEventListener('error', failed);
    if (isNew) document.head.appendChild(script);
  });
  scriptPromise = pending.catch(error => { scriptPromise = null; throw error; });
  return scriptPromise;
}

// Deduplicate both script download and autoload=false initialization. A retry
// after network/initialization failure must be able to inject a fresh script.
export function loadKakaoMaps() {
  if (readyPromise) return readyPromise;
  readyPromise = ensureKakaoMapSdk().then(kakao => new Promise((resolve, reject) => {
    if (kakao.maps.Map) { resolve(kakao); return; }
    const timeout = setTimeout(() => reject(new Error('지도 초기화 시간이 초과되었습니다. 다시 시도해 주세요.')), LOAD_TIMEOUT_MS);
    try {
      kakao.maps.load(() => {
        clearTimeout(timeout);
        if (kakao.maps.Map) resolve(kakao);
        else reject(new Error('지도 초기화를 완료하지 못했습니다.'));
      });
    } catch (error) { clearTimeout(timeout); reject(error); }
  })).catch(error => {
    readyPromise = null;
    scriptPromise = null;
    if (!window.kakao?.maps?.Map) { removeFailedScript(); delete window.kakao; }
    throw error;
  });
  return readyPromise;
}
