// Offline rendering of the actual production PDF definition with synthetic data.
// Run from gps-tracker-web: node tests/render-nts-print.mjs OUTPUT_DIRECTORY
import fs from 'node:fs/promises';
import path from 'node:path';
import PdfPrinter from 'pdfmake';
import {ntsTripReport} from '../src/lib/ntsReport.js';
import {reportPdfDefinition,reportCsv} from '../src/lib/businessExport.js';
const out=process.argv[2];if(!out)throw Error('Output directory required');
await fs.mkdir(out,{recursive:true});
const font='src/assets/fonts/NanumGothic-';
const printer=new PdfPrinter({NanumGothic:{normal:font+'Regular.ttf',bold:font+'Bold.ttf',italics:font+'Regular.ttf',bolditalics:font+'Bold.ttf'}});
const context={device:{id:1,car_model:'아반떼',car_plate:'12가3456'},info:{company_name:'서식 검증용 모의 회사',business_number:'000-00-00000'},from:'2026-10-01',to:'2026-10-31'};
const trip=i=>({started_at:`2026-10-${String(1+i%28).padStart(2,'0')}T00:00:00Z`,ended_at:`2026-10-${String(1+i%28).padStart(2,'0')}T01:00:00Z`,distance_m:i===0?0:10000+i,annotation:{purpose:i%2?'commute':'business',driver_name:`사용자${i+1}`,driver_department:'영업부',note:`비고${i+1}`}});
const long=trip(2);long.annotation.note='긴 비고 보존 검증입니다. '.repeat(260)+'비고끝';long.annotation.driver_department='전국 영업 지원 및 차량 운영 관리 담당 부서';
const cases={standard:ntsTripReport([trip(0),trip(1),trip(2)],context),multipage:ntsTripReport(Array.from({length:70},(_,i)=>trip(i)),context),
 missing:ntsTripReport([{...trip(0),ended_at:null},{...trip(1),annotation:null}],{...context,info:{},device:{},filtered:true}),
 empty:ntsTripReport([],{...context,info:{},device:{}}),long:ntsTripReport([long],context)};
for(const [name,report] of Object.entries(cases)){
 const doc=printer.createPdfKitDocument(reportPdfDefinition(report)),chunks=[];
 const bytes=await new Promise((resolve,reject)=>{doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);doc.end();});
 await fs.writeFile(path.join(out,name+'.pdf'),bytes);await fs.writeFile(path.join(out,name+'.csv'),reportCsv(report));
 console.log(name,report.rows.length,bytes.length);
}
