import { saveBlob } from './fileDownload.js';
export { saveBlob } from './fileDownload.js';
import { reportCsv, reportPdfDefinition } from './businessExport.js';
import regularUrl from '../assets/fonts/NanumGothic-Regular.ttf?url';
import boldUrl from '../assets/fonts/NanumGothic-Bold.ttf?url';

let pdfRuntime;
async function loadPdf() {
  if (!pdfRuntime) pdfRuntime = (async () => {
    const [{default:pdf}, regular, bold] = await Promise.all([
      import('pdfmake/build/pdfmake'), font(regularUrl), font(boldUrl),
    ]);
    pdf.addVirtualFileSystem({'Regular.ttf':regular,'Bold.ttf':bold});
    return pdf;
  })().catch(e=>{pdfRuntime=null; throw e;});
  return pdfRuntime;
}
async function font(url) {
  const response = await fetch(url, {signal:AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error('PDF 글꼴을 불러오지 못했습니다. 다시 시도해 주세요.');
  const data = new Uint8Array(await response.arrayBuffer());
  let result='';
  for(let i=0;i<data.length;i+=8192) result+=String.fromCharCode(...data.subarray(i,i+8192));
  return btoa(result);
}
export async function downloadReport(report, format) {
  if (format==='csv') return saveBlob(new Blob([reportCsv(report)],{type:'text/csv;charset=utf-8'}),`${report.filename}.csv`);
  const pdf = await loadPdf();
  const fonts={NanumGothic:{normal:'Regular.ttf',bold:'Bold.ttf',italics:'Regular.ttf',bolditalics:'Bold.ttf'}};
  const blob = await new Promise((resolve,reject)=> {
    const timeout=setTimeout(()=>reject(new Error('PDF 생성 시간이 초과되었습니다. 기간을 줄여 다시 시도해 주세요.')),60000);
    try { pdf.createPdf(reportPdfDefinition(report),null,fonts).getBlob(value=>{clearTimeout(timeout);resolve(value);}); }
    catch(e) {clearTimeout(timeout);reject(e);}
  });
  return saveBlob(blob,`${report.filename}.pdf`);
}

// Existing Android builds accept PDF/CSV. Keep receipt originals in storage,
// and provide an image-to-PDF copy without changing the native bridge.
export async function downloadReceipt(blob, filename, asPdf = false) {
  const stem = filename.replace(/\.[^.]+$/, '') || '영수증';
  const extension = {'application/pdf':'pdf','image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[blob.type];
  if (!extension) throw new Error('지원하지 않는 영수증 형식입니다.');
  if (!asPdf || blob.type === 'application/pdf') return saveBlob(blob, `${stem}.${extension}`);
  const bitmap = await createImageBitmap(blob);
  try {
    const ratio = Math.min(1, 3000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const pdf = await loadPdf();
    const copy = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('영수증 PDF 생성 시간이 초과되었습니다.')), 30000);
      try { pdf.createPdf({pageSize:'A4',pageMargins:[24,24,24,24],content:[{image:canvas.toDataURL('image/jpeg',0.9),fit:[547,794]}]}).getBlob(value => {clearTimeout(timer);resolve(value);}); }
      catch(e) {clearTimeout(timer);reject(e);}
    });
    return saveBlob(copy, `${stem}.pdf`);
  } finally { bitmap.close(); }
}
