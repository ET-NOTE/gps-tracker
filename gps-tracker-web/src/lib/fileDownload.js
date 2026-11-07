import { safeFilename } from './businessExport.js';
const MAX_NATIVE_BYTES = 8 * 1024 * 1024;
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
  const extension = /\.(csv|pdf|jpe?g|png|webp)$/i.exec(String(filename))?.[0] || '';
  const stem = extension ? String(filename).slice(0, -extension.length) : String(filename);
  const name = ([...safeFilename(stem)].slice(0, 60).join('').replace(/^\.+/, '_') || '보고서') + extension;
  const bridge = await nativeFiles();
  if (bridge) {
    if (!blob.size || blob.size > MAX_NATIVE_BYTES) throw new Error('파일이 너무 큽니다. 조회 기간을 줄여 다시 시도해 주세요.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const result = await bridge.exportReport({filename: name, mime: blob.type.split(';')[0], base64: btoa(binary)});
    if (!result?.ok) throw new Error(result?.error === 'busy' ? '다른 파일을 처리 중입니다. 열린 파일 화면을 먼저 닫아주세요.' : '파일을 저장하거나 공유하지 못했습니다. 다시 시도해 주세요.');
    return result;
  }
  if (window.GpsNative || window.FlutterAppOpenUrl) throw new Error('현재 앱에서는 보고서 저장을 지원하지 않습니다. 최신 앱으로 업데이트하거나 브라우저에서 다운로드해 주세요.');
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return {status: 'browser_started'};
}
