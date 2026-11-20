// Actual company mapping panel with local synthetic responses; no production.
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../gps-tracker-web');
const {createServer}=await import(pathToFileURL(path.join(root,'node_modules/vite/dist/node/index.js')));
const {chromium}=await import(pathToFileURL(path.join(process.env.GPS_QA_NODE_MODULES,'playwright/index.mjs')));
const output=process.env.GPS_QA_OUTPUT;await fs.mkdir(output,{recursive:true});
const fixture=`
import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {CompanySubjectMappings} from '/src/components/SubjectProvision.jsx';import {api} from '/src/api.js';import '/src/index.css';import '/src/components/PrivacyRequests.css';
const mode=new URLSearchParams(location.search).get('mode');let failed=false;
const base={revision:2,owner_id:135,subject_id:136,staff_id:1,binding_id:1,vehicle_id:2,device_id:3,starts_at:'2026-11-10T00:00:12.123Z',ends_at:'2026-11-10T01:00:12.123Z',has_successor:false};
const rows=Array.from({length:207},(_,i)=>({...base,id:207-i,status:i===206?'confirmed':i===205?'revoked':'rejected',effective:i===206}));
const wait=(signal,ms=150)=>new Promise((resolve,reject)=>{const timer=setTimeout(resolve,ms);signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));});});
api.companySubjectMappings=async(q,signal)=>{await wait(signal);if(mode==='error'&&!failed){failed=true;throw Error('연결 목록을 불러오지 못했습니다. 다시 조회해 주세요.');}const list=rows.filter(x=>(!q.before||x.id<q.before)&&(!q.status||x.status===q.status));return {enabled:true,items:list.slice(0,q.limit),next_before:list.length>q.limit?list[q.limit-1].id:null,people:[{staff_id:1,subject_id:136,name:'합성 운전자'}],bindings:[{id:206,vehicle_id:2,device_id:4,starts_at:'2026-11-12T00:00:00Z'},...(list.some(x=>x.binding_id===1)?[{id:1,vehicle_id:2,device_id:3,starts_at:'2026-10-01T00:00:00Z'}]:[])]};};
api.subjectLocations=async(id,signal)=>{await wait(signal,600);return {items:[{recorded_at:base.starts_at,lat:37.135987,lng:127.135987}],more:false};};
api.proposeSubjectMapping=async body=>{window.sentBody=body;const old=rows.find(r=>r.id===body.replaces_id);old.has_successor=true;if(body.change_kind==='correction'){old.status='superseded';old.effective=false;}rows.unshift({...old,id:208,has_successor:false,status:'pending',effective:false,replaces_id:old.id});return{id:208};};
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><main style={{maxWidth:1000,margin:'auto',padding:16}}><aside style={{padding:14,background:'#fff4ce',borderRadius:8,marginBottom:16,fontSize:13}}>135차 기능 검수 · 합성 자료 · 운영 적용 증빙이 아닙니다</aside><CompanySubjectMappings/></main></QueryClientProvider>);
`;
const server=await createServer({root,configFile:false,base:'/',esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:8039,strictPort:true},plugins:[{name:'company135-fixture',resolveId(id){if(id==='/@qa135.jsx')return path.join(root,'__qa135.jsx');},load(id){if(id.endsWith('__qa135.jsx'))return fixture;},configureServer(s){s.middlewares.use((req,res,next)=>{if(!req.url.startsWith('/__qa135'))return next();res.setHeader('Content-Type','text/html');res.end('<html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--text:#17283b;--text-2:#4b6075;--surface:#fff;--border:#d8e0ea;--primary:#1465de;--bg:#f3f6fa;--danger:#ae2424}body{margin:0;background:#f3f6fa}</style><div id="root"></div><script type="module" src="/@qa135.jsx"></script></html>');});}}]});
let browser;const errors=[];
try{
 await server.listen();browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.setViewportSize({width:1280,height:1000});await page.goto('http://127.0.0.1:8039/__qa135');await page.getByText('1페이지 · 연결 50건',{exact:false}).waitFor();
 for(let n=2;n<=5;n++){await page.getByRole('button',{name:'연결 다음 페이지',exact:true}).click();await page.getByText(n+'페이지 · 연결 '+(n===5?7:50)+'건',{exact:false}).waitFor();}
 await page.getByRole('heading',{name:'연결 #1 · 차량 #2 · 사용자 #136',exact:true}).waitFor();await page.screenshot({path:path.join(output,'company-fifth-page-desktop.png'),fullPage:true});
 await page.getByLabel('연결 상태 필터').selectOption('confirmed');await page.getByText('1페이지 · 연결 1건',{exact:true}).waitFor();
 await page.getByRole('button',{name:'연결 정정',exact:true}).click();assert.equal(await page.getByLabel('차량·SIM 연결').inputValue(),'1');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'company-old-correction-mobile.png'),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.getByRole('button',{name:'확인된 기간 위치 조회',exact:true}).click();await page.getByText('확인된 기간 위치를 불러오는 중…',{exact:true}).waitFor();
 await page.getByLabel('연결 상태 필터').selectOption('revoked');await page.getByText('1페이지 · 연결 1건',{exact:true}).waitFor();assert.equal(await page.getByText('37.135987',{exact:false}).count(),0);
 await page.getByRole('button',{name:'재동의 요청',exact:true}).click();assert(await page.getByLabel('운전자 계정').isDisabled());assert(await page.getByLabel('시작',{exact:true}).isDisabled());
 await page.screenshot({path:path.join(output,'company-reconsent-mobile.png'),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.locator('form').getByRole('button',{name:'재동의 요청',exact:true}).click();await page.getByText('요청했습니다.',{exact:false}).waitFor();
 const sent=await page.evaluate(()=>window.sentBody);assert.equal(sent.replaces_id,2);assert.equal(sent.replaces_revision,2);assert.equal(sent.change_kind,'reconsent');assert.equal(sent.starts_at,'2026-11-10T00:00:12.123Z');
 await page.getByLabel('연결 상태 필터').selectOption('confirmed');await page.getByText('1페이지 · 연결 1건',{exact:true}).waitFor();await page.getByRole('button',{name:'연결 정정',exact:true}).click();await page.getByRole('button',{name:'기존 연결 중지 및 정정 요청',exact:true}).click();await page.getByText('선택한 상태에 해당하는 연결이 없습니다.',{exact:true}).waitFor();
 await page.goto('http://127.0.0.1:8039/__qa135?mode=error');await page.getByRole('alert').waitFor();assert.equal(await page.getByText('선택한 상태에 해당하는 연결이 없습니다.',{exact:true}).count(),0);await page.screenshot({path:path.join(output,'company-retry-mobile.png'),fullPage:true});
 await page.getByRole('button',{name:'연결 처음 / 새로고침',exact:true}).click();await page.getByText('1페이지 · 연결 50건',{exact:false}).waitFor();
 await page.getByRole('button',{name:'연결 처음 / 새로고침',exact:true}).click();await page.getByRole('button',{name:'연결 목록 조회 취소',exact:true}).click();await page.getByText('연결 목록 조회를 취소했습니다.',{exact:false}).waitFor();
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,'ui-validation.json'),JSON.stringify({at:new Date().toISOString(),environment:'actual React company panel/queue; synthetic local API responses',checks:['207 mappings reached50/50/50/50/7','filter resets page and old binding remains selectable','390px no document overflow','filter change clears correction and aborts pending location response','reconsent locks identity and preserves exact timestamp/revision','correction and reconsent return to newest filtered list','error distinct from empty; explicit retry and cancel'],errors},null,2));
}finally{await browser?.close();await server.close();}
