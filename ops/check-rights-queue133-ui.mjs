// Actual rights-request components and hook; synthetic fixtures, no production.
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../gps-tracker-web');
const {createServer}=await import(pathToFileURL(path.join(root,'node_modules/vite/dist/node/index.js')));
const {chromium}=await import(pathToFileURL(path.join(process.env.GPS_QA_NODE_MODULES,'playwright/index.mjs')));
const output=process.env.GPS_QA_OUTPUT;await fs.mkdir(output,{recursive:true});
const fixture=`
import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import PrivacyRequests,{AdminPrivacyRequests} from '/src/components/PrivacyRequests.jsx';import {api} from '/src/api.js';import '/src/index.css';
const mode=new URLSearchParams(location.search).get('mode');
const now='2026-11-15T00:00:00Z';
const all=Array.from({length:110},(_,i)=>({id:110-i,user_id:133,kind:'rectification',scope:'합성 요청: 등록 정보 확인',status:'cancelled',revision:1,assigned_to:null,due_at:null,result_message:'요청자가 취소했습니다.',created_at:'2026-11-10T01:00:00Z',updated_at:'2026-11-10T01:00:00Z'}));
const adminRows=[{...all[0],id:13303,status:'in_review',assigned_to:133,due_at:'2026-11-14T03:00:00Z'},{...all[1],id:13302,status:'needs_information',assigned_to:null,due_at:null},{...all[2],id:13301,status:'received',assigned_to:134,due_at:'2026-11-14T04:00:00Z'}];
const wait=signal=>new Promise((resolve,reject)=>{const timer=setTimeout(resolve,250);signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));});});
api.privacyRequestPage=async(q,signal)=>{await wait(signal);const rows=all.filter(r=>(!q.before||r.id<q.before)&&(!q.status||r.status===q.status)&&(!q.kind||r.kind===q.kind));return {items:rows.slice(0,50),next:rows.length>50?rows[49].id:null,as_of:q.as_of||now};};
api.adminPrivacyRequests=async(q,signal)=>{await wait(signal);const rows=adminRows.filter(r=>(!q.status||r.status===q.status)&&(!q.kind||r.kind===q.kind)&&(!q.due||(q.due==='overdue'?r.due_at&&r.due_at<now:r.due_at===null))&&(!q.assignment||(q.assignment==='mine'?r.assigned_to===133:r.assigned_to===null)));return {items:rows,next:null,as_of:q.as_of||now};};
api.collectionControl=async()=>({items:[]});api.processingControl=async()=>({control:{use_paused:false,provision_paused:false},retention:null,retention_enabled:false});api.subjectMappings=async()=>({items:[]});api.provisionNotices=async()=>({items:[]});api.companyTasks=async()=>({items:[]});api.personalCompanyReviews=async()=>[];api.companyReviews=async()=>[];
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><main style={{maxWidth:1100,margin:'auto',padding:16}}><aside style={{padding:14,background:'#fff4ce',borderRadius:8,marginBottom:16}}>133차 실제 컴포넌트 기능 검수 · 합성 요청 · 운영 적용 증빙이 아닙니다</aside>{mode==='personal'?<PrivacyRequests/>:<AdminPrivacyRequests/>}</main></QueryClientProvider>);
`;
const server=await createServer({root,configFile:false,base:'/',esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:8039,strictPort:true},plugins:[{name:'rights133-fixture',resolveId(id){if(id==='/@qa133.jsx')return path.join(root,'__qa133.jsx');},load(id){if(id.endsWith('__qa133.jsx'))return fixture;},configureServer(s){s.middlewares.use((req,res,next)=>{if(!req.url.startsWith('/__qa133'))return next();res.setHeader('Content-Type','text/html');res.end('<html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--text:#17283b;--text-2:#4b6075;--surface:#fff;--border:#d8e0ea;--primary:#1465de;--bg:#f3f6fa;--danger:#ae2424}</style><div id="root"></div><script type="module" src="/@qa133.jsx"></script></html>');});}}]});
let browser;const errors=[];
try{
 await server.listen();browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.setViewportSize({width:1360,height:900});await page.goto('http://127.0.0.1:8039/__qa133');
 await page.getByText('1페이지 · 이번 페이지 1건',{exact:true}).waitFor();
 await page.getByLabel('처리 기한 필터').selectOption('overdue');await page.getByText('1페이지 · 이번 페이지 2건',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('목록 처리 상태').inputValue(),'');
 await page.getByLabel('담당자 필터').selectOption('mine');await page.getByText('1페이지 · 이번 페이지 1건',{exact:true}).waitFor();
 await page.screenshot({path:path.join(output,'rights-overdue-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'rights-overdue-mobile.png'),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.getByLabel('목록 요청 종류').selectOption('erasure');await page.getByText('선택한 조건에 해당하는 요청이 없습니다.',{exact:true}).waitFor();
 await page.screenshot({path:path.join(output,'rights-filter-empty-mobile.png'),fullPage:true});
 await page.getByRole('button',{name:'처음 / 새로고침',exact:true}).click();await page.getByRole('button',{name:'목록 조회 취소'}).click();await page.getByText('목록 조회를 취소했습니다.',{exact:false}).waitFor();
 await page.goto('http://127.0.0.1:8039/__qa133?mode=personal');await page.getByText('1페이지 · 이번 페이지 50건',{exact:false}).waitFor();
 await page.getByRole('button',{name:'다음 페이지',exact:true}).click();await page.getByText('2페이지 · 이번 페이지 50건',{exact:false}).waitFor();
 await page.getByRole('button',{name:'다음 페이지',exact:true}).click();await page.getByText('3페이지 · 이번 페이지 10건',{exact:true}).waitFor();
 await page.getByRole('heading',{name:'#10 · 정보 정정',exact:true}).waitFor();
 await page.getByRole('heading',{name:'요청 내역',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'rights-personal-third-page-mobile.png')});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(output,'ui-validation.json'),JSON.stringify({at:new Date().toISOString(),environment:'actual React components; synthetic local API responses',checks:['overdue clears initial received-only filter','mine combines with overdue','390px document no overflow','empty filtered response distinct','cancel visible and aborts request','personal110 reaches50/50/10 third page'],errors},null,2));
}finally{await browser?.close();await server.close();}
