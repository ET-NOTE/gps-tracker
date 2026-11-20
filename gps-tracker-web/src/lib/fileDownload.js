import { safeFilename } from './businessExport.js';
const MAX_NATIVE_BYTES = 8 * 1024 * 1024;
const UPDATE_MESSAGE = '이 파일 형식은 최신 앱에서 지원합니다. 앱을 업데이트하거나 브라우저에서 다운로드해 주세요.';
export function fileSaveMessage(result) {
  switch (result?.status) {
    case 'saved': return '선택한 위치에 파일을 저장했습니다.';
    case 'share_opened': return '공유 화면을 열었습니다. 공유할 앱에서 전송을 완료해 주세요.';
    case 'cancelled': return '파일 저장·공유를 취소했습니다.';
    case 'browser_started': return '다운로드를 요청했습니다. 브라우저의 다운로드 목록을 확인해 주세요.';
    default: return '파일 처리 결과를 확인하지 못했습니다.';
  }
}
async function nativeFiles() {
  if (window.GpsFiles?.version >= 1) return window.GpsFiles;
  if (!window.GpsNative) return null;
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); window.removeEventListener('gps-native-files-ready', finish); resolve(window.GpsFiles?.version >= 1 ? window.GpsFiles : null); };
    const timer = setTimeout(finish, 1500);
    window.addEventListener('gps-native-files-ready', finish);
  });
}

export async function saveBlob(blob, filename) {
  // Keep the extension and stay below common UTF-8 filesystem name limits.
  const extension = /\.(csv|pdf|json|jpe?g|png|webp|gif|xlsx|gpx)$/i.exec(String(filename))?.[0] || '';
  const stem = extension ? String(filename).slice(0, -extension.length) : String(filename);
  const name = ([...safeFilename(stem)].slice(0, 60).join('').replace(/^\.+/, '_') || '보고서') + extension;
  const bridge = await nativeFiles();
  if (bridge) {
    const mime = blob.type.split(';')[0];
    const supported = bridge.version >= 2 && Array.isArray(bridge.mimeTypes) ? bridge.mimeTypes : ['text/csv', 'application/pdf'];
    if (!supported.includes(mime)) throw new Error(UPDATE_MESSAGE);
    const limit = Number.isSafeInteger(bridge.maxBytes) && bridge.maxBytes > 0 ? Math.min(MAX_NATIVE_BYTES, bridge.maxBytes) : MAX_NATIVE_BYTES;
    if (!blob.size) throw new Error('파일이 비어 있습니다. 다시 조회해 주세요.');
    if (blob.size > limit) throw new Error('파일이 너무 큽니다. 앱에서는 최대 8MB까지 저장할 수 있습니다. 조회 기간을 줄이거나 브라우저에서 다운로드해 주세요.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const result = await bridge.exportReport({filename: name, mime, base64: btoa(binary)});
    if (!result?.ok) throw new Error(result?.error === 'busy' ? '다른 파일을 처리 중입니다. 열린 파일 화면을 먼저 닫아주세요.' : '파일을 저장하거나 공유하지 못했습니다. 다시 시도해 주세요.');
    if (!['saved', 'share_opened', 'cancelled'].includes(result.status)) throw new Error('파일 처리 결과를 확인하지 못했습니다. 저장 위치를 확인해 주세요.');
    return result;
  }
  if (window.GpsNative || window.FlutterAppOpenUrl) throw new Error('현재 앱에서는 보고서 저장을 지원하지 않습니다. 최신 앱으로 업데이트하거나 브라우저에서 다운로드해 주세요.');
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return {status: 'browser_started'};
}
