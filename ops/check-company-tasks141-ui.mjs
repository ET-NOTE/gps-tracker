// Actual company task inbox/proof review panel with local synthetic responses; no production.
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../gps-tracker-web');
const {createServer}=await import(pathToFileURL(path.join(root,'node_modules/vite/dist/node/index.js')));
const {chromium}=await import(pathToFileURL(path.join(process.env.GPS_QA_NODE_MODULES,'playwright/index.mjs')));
const output=process.env.GPS_QA_OUTPUT;await fs.mkdir(output,{recursive:true});
const fixture=`
import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {CompanyTaskInbox,CompanyTaskDecision} from '/src/components/PrivacyCompanyTask.jsx';import {api} from '/src/api.js';import '/src/index.css';import '/src/components/PrivacyRequests.css';
const mode=new URLSearchParams(location.search).get('mode');let failed=false;
const rows=Array.from({length:107},(_,i)=>({id:i+1,revision:3,status:i===98?'changes_requested':i<100?'requested':'submitted',category:i===98?'files':i%2?'trips':'staff',kind:'access',staff_id:141,from_at:'2026-11-10T00:00:00Z',until_at:'2026-11-11T00:00:00Z',expires_at:'2026-11-25T00:00:00Z',instructions:'확인된 회사 자료의 해당 기간 처리 결과만 제출해 주세요.',feedback:i===98?'첨부된 보고서의 처리 건수와 근거를 보완해 주세요.':''}));
const wait=signal=>new Promise((resolve,reject)=>{const timer=setTimeout(resolve,mode==='slow'?2000:100);signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));});});
api.companyTaskPage=async(p,signal)=>{await wait(signal);if(mode==='error'&&!failed){failed=true;throw Error('회사 요청을 불러오지 못했습니다. 다시 조회해 주세요.');}const list=rows.filter(x=>x.id>p.after&&(!p.status||x.status===p.status)&&(!p.category||x.category===p.category));return {items:list.slice(0,50),next:list.length>50?list[49].id:null};};
api.companyTask=async(id,signal)=>{await wait(signal);return {task:rows.find(x=>x.id===id),submissions:[]};};
const proof={id:141,sha256:'a'.repeat(64),mime:'application/pdf',size:70,filename:'processing-evidence.pdf',created_at:'2026-11-17T00:00:00Z',executed_at:'2026-11-16T00:00:00Z',outcome:'provided',affected_count:3,summary:'합성 자료3건의 범위별 처리 보고서입니다.',evidence_reference:'QA-141'};
api.companyProof=async()=>new Blob(['%PDF-1.4 synthetic review fixture'],{type:'application/pdf'});
window.GpsFiles={version:2,maxBytes:8388608,mimeTypes:['application/pdf'],exportReport:async()=>({ok:true,status:'cancelled'})};
const task={...rows[106],id:141,status:'submitted'};
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><main className="rights-panel" style={{maxWidth:1000,margin:'auto',padding:16}}><aside style={{padding:14,background:'#fff4ce',borderRadius:8,marginBottom:16,fontSize:13}}>141차 기능 검수 · 합성 자료·저장 결과 · 운영 적용 증빙이 아닙니다</aside>{mode==='proof'?<section className="rights-card"><h2>회사 증빙 검토</h2><CompanyTaskDecision item={{task,submissions:[proof]}} row={{id:1,revision:3}} request={{revision:2,status:'in_review'}} refresh={async()=>{}}/></section>:<CompanyTaskInbox/>}</main></QueryClientProvider>);
`;
const server=await createServer({root,configFile:false,base:'/',esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:8041,strictPort:true},plugins:[{name:'company141-fixture',resolveId(id){if(id==='/@qa141.jsx')return path.join(root,'__qa141.jsx');},load(id){if(id.endsWith('__qa141.jsx'))return fixture;},configureServer(s){s.middlewares.use((req,res,next)=>{if(!req.url.startsWith('/__qa141'))return next();res.setHeader('Content-Type','text/html');res.end('<html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--text:#17283b;--text-2:#4b6075;--surface:#fff;--border:#d8e0ea;--primary:#1465de;--bg:#f3f6fa;--danger:#ae2424}body{margin:0;background:#f3f6fa}</style><div id="root"></div><script type="module" src="/@qa141.jsx"></script></html>');});}}]});
let browser;const errors=[];
try{
 await server.listen();browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.setViewportSize({width:1280,height:1000});await page.goto('http://127.0.0.1:8041/__qa141');await page.getByText('1페이지 · 회사 요청 50건',{exact:false}).waitFor();
 for(let n=2;n<=3;n++){await page.getByRole('button',{name:'회사 요청 다음 페이지',exact:true}).click();await page.getByText(n+'페이지 · 회사 요청 '+(n===3?7:50)+'건',{exact:false}).waitFor();}
 assert(await page.getByRole('button',{name:'회사 요청 다음 페이지',exact:true}).isDisabled());await page.screenshot({path:path.join(output,'company-tasks-third-page-desktop.png')});
 await page.getByRole('button',{name:'회사 요청 이전 페이지',exact:true}).click();await page.getByText('2페이지 · 회사 요청 50건',{exact:false}).waitFor();
 await page.getByLabel('회사 요청 상태').selectOption('changes_requested');await page.getByText('1페이지 · 회사 요청 1건',{exact:true}).waitFor();await page.getByLabel('회사 자료 종류').selectOption('files');await page.getByText('1페이지 · 회사 요청 1건',{exact:true}).waitFor();
 await page.getByRole('button',{name:'#99 · 첨부자료 · 보완 요청',exact:true}).click();await page.getByText('첨부된 보고서의 처리 건수와 근거를 보완해 주세요.',{exact:false}).waitFor();
 await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,'company-task-correction-mobile.png'),fullPage:true});
 await page.getByLabel('회사 요청 상태').selectOption('accepted');await page.getByText('선택한 조건에 해당하는 유효한 요청이 없습니다.',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'처리 보고서 제출',exact:true}).count(),0);
 await page.goto('http://127.0.0.1:8041/__qa141?mode=error');await page.getByRole('alert').waitFor();assert.equal(await page.getByText('선택한 조건에 해당하는 유효한 요청이 없습니다.',{exact:true}).count(),0);await page.screenshot({path:path.join(output,'company-tasks-error-mobile.png'),fullPage:true});
 await page.getByRole('button',{name:'회사 요청 처음 / 새로고침',exact:true}).click();await page.getByText('1페이지 · 회사 요청 50건',{exact:false}).waitFor();
 await page.goto('http://127.0.0.1:8041/__qa141?mode=slow');await page.getByRole('button',{name:'회사 요청 조회 취소',exact:true}).click();await page.getByText('회사 요청 조회를 취소했습니다.',{exact:false}).waitFor();await page.screenshot({path:path.join(output,'company-tasks-cancel-mobile.png'),fullPage:true});
 await page.goto('http://127.0.0.1:8041/__qa141?mode=proof');await page.getByRole('button',{name:'증빙 내려받기',exact:true}).click();await page.getByText('파일 저장·공유를 취소했습니다.',{exact:true}).waitFor();
 assert(await page.getByRole('checkbox').isDisabled());assert(await page.getByRole('button',{name:'검토 결과 대장에 반영',exact:true}).isDisabled());assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,'company-proof-save-cancel-mobile.png'),fullPage:true});
 await page.evaluate(()=>{window.GpsFiles.exportReport=async()=>({ok:true,status:'share_opened'});});await page.getByRole('button',{name:'증빙 내려받기',exact:true}).click();await page.getByText('공유 화면을 열었습니다.',{exact:false}).waitFor();
 assert(!(await page.getByRole('checkbox').isDisabled()));assert(!(await page.getByRole('checkbox').isChecked()));assert(await page.getByRole('button',{name:'검토 결과 대장에 반영',exact:true}).isDisabled());
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,'ui-validation.json'),JSON.stringify({at:new Date().toISOString(),environment:'actual React/React Query and Edge; synthetic local API and native file result',checks:['107 tasks50/50/7 and back','two filters reset page and lazy correction detail opens','390px no overflow; filter hides previous form','error distinct from empty and explicit retry','cancel hides late rows','native cancelled does not enable proof attestation','share_opened reports only picker and still needs explicit attestation'],errors},null,2));
}finally{await browser?.close();await server.close();}
