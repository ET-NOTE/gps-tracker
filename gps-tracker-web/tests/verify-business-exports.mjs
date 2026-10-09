// Offline PDF/CSV integration check using a user-authorized API snapshot.
// node tests/verify-business-exports.mjs SNAPSHOT_JSON OUTPUT_DIRECTORY
import fs from 'node:fs/promises';
import path from 'node:path';
import PdfPrinter from 'pdfmake';
import {tripReport,rentalReport,invoiceReport,monthlyReport,reportCsv,reportPdfDefinition} from '../src/lib/businessExport.js';
const [input,out]=process.argv.slice(2);
if (!input || !out) throw Error('Snapshot and output directory required');
const s=JSON.parse((await fs.readFile(input,'utf8')).replace(/^\uFEFF/,''));
await fs.mkdir(out,{recursive:true});
const fonts={NanumGothic:{normal:'src/assets/fonts/NanumGothic-Regular.ttf',bold:'src/assets/fonts/NanumGothic-Bold.ttf',italics:'src/assets/fonts/NanumGothic-Regular.ttf',bolditalics:'src/assets/fonts/NanumGothic-Bold.ttf'}};
const printer=new PdfPrinter(fonts);
const trip=tripReport(s.tripsByDevice['3163'],{device:s.devices.find(d=>d.id===3163),info:s.info,from:'2026-10-01',to:'2026-10-10',filterText:'내보내기 검증용 계정 조회본'});
const reports={contracts:rentalReport(s.rentals),settlements:rentalReport(s.rentals,{settlement:true}),invoice:invoiceReport(s.rentals.find(c=>c.status==='returned')),trips:trip,
 monthly:monthlyReport(s.devices.map(d=>({label:d.display_name,totalKm:(s.tripsByDevice[d.id]||[]).reduce((n,t)=>n+t.distance_m/1000,0),businessKm:(s.tripsByDevice[d.id]||[]).filter(t=>t.annotation?.purpose==='business').reduce((n,t)=>n+t.distance_m/1000,0),personalKm:0})),{month:'2026-10',estimateFuelCost:()=>0,estimateDepreciation:()=>0}),
 multipage:{...trip,title:'[테스트] 다중 페이지 검증',rows:Array.from({length:120},(_,i)=>({...trip.rows[0],note:`검증 ${i+1}: `+'긴 한글 메모, 줄바꿈과 표 경계를 검증합니다. '.repeat(3)}))},
};
for(const [name,report] of Object.entries(reports)) {
  await fs.writeFile(path.join(out,name+'.csv'),reportCsv(report));
  const pdf=printer.createPdfKitDocument(reportPdfDefinition(report));
  const chunks=[];
  const buffer=await new Promise((resolve,reject)=>{pdf.on('data',c=>chunks.push(c));pdf.on('end',()=>resolve(Buffer.concat(chunks)));pdf.on('error',reject);pdf.end();});
  await fs.writeFile(path.join(out,name+'.pdf'),buffer);
  console.log(`${name}: ${report.rows.length} rows, ${buffer.length} PDF bytes`);
}
