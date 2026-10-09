import { reportCsv, reportPdfDefinition, safeFilename } from './businessExport.js';
import regularUrl from '../assets/fonts/NanumGothic-Regular.ttf?url';
import boldUrl from '../assets/fonts/NanumGothic-Bold.ttf?url';

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = safeFilename(filename);
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
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
  if (format==='csv') { saveBlob(new Blob([reportCsv(report)],{type:'text/csv;charset=utf-8'}),`${report.filename}.csv`); return; }
  const pdf = await loadPdf();
  const fonts={NanumGothic:{normal:'Regular.ttf',bold:'Bold.ttf',italics:'Regular.ttf',bolditalics:'Bold.ttf'}};
  const blob = await new Promise((resolve,reject)=> {
    const timeout=setTimeout(()=>reject(new Error('PDF 생성 시간이 초과되었습니다. 기간을 줄여 다시 시도해 주세요.')),60000);
    try { pdf.createPdf(reportPdfDefinition(report),null,fonts).getBlob(value=>{clearTimeout(timeout);resolve(value);}); }
    catch(e) {clearTimeout(timeout);reject(e);}
  });
  saveBlob(blob,`${report.filename}.pdf`);
}
