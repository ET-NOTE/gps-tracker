// Actual personal mappings/notices panel with local synthetic responses; no production.
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../gps-tracker-web');
const {createServer}=await import(pathToFileURL(path.join(root,'node_modules/vite/dist/node/index.js')));
const {chromium}=await import(pathToFileURL(path.join(process.env.GPS_QA_NODE_MODULES,'playwright/index.mjs')));
const output=process.env.GPS_QA_OUTPUT;await fs.mkdir(output,{recursive:true});
const fixture=`
import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {SubjectMappings,ProvisionNotices} from '/src/components/SubjectProvision.jsx';import {api} from '/src/api.js';import '/src/index.css';import '/src/components/PrivacyRequests.css';
const mode=new URLSearchParams(location.search).get('mode');let failed=false;
const base={revision:3,owner_id:140,vehicle_id:2,device_id:3,owner_name:'기능 검수 회사',vehicle_name:'검수 차량',starts_at:'2026-11-10T00:00:00Z',ends_at:'2026-11-10T01:00:00Z'};
const rows=Array.from({length:207},(_,i)=>({...base,id:207-i,status:i>203?'pending':i>200?'confirmed':'rejected',effective:true}));
const notices=Array.from({length:107},(_,i)=>({id:107-i,owner_id:140,actor_id:141,vehicle_id:2,owner_name:'기능 검수 회사',delivery:i===106?'review':'provider_accepted',outcome:'prepared',range_from:base.starts_at,range_until:base.ends_at,started_at:base.ends_at,read_at:i<7?base.ends_at:null}));
const wait=(signal)=>new Promise((resolve,reject)=>{const timer=setTimeout(resolve,mode==='slow'?2000:100);signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));});});
const result=list=>({items:list.slice(0,50),next_before:list.length>50?list[49].id:null});
api.subjectMappingPage=async(q,signal)=>{await wait(signal);if(mode==='error'&&!failed){failed=true;throw Error('연결 요청을 불러오지 못했습니다. 다시 조회해 주세요.');}return {...result(rows.filter(x=>(!q.before||x.id<q.before)&&(!q.status||x.status===q.status))),enabled:true,consent_version:'fleet-subject-v1',consent_text:'이 차량과 기간의 실제 운전자임을 확인하고, 차량 운영을 위한 회사의 위치 조회에 동의합니다.'};};
api.provisionNoticePage=async(q,signal)=>{await wait(signal);return result(notices.filter(x=>(!q.before||x.id<q.before)&&(!q.read_state||(q.read_state==='read'?!!x.read_at:!x.read_at))));};
api.subjectDecision=async(id,body)=>{window.decision={id,...body};rows.find(x=>x.id===id).status=body.action;return {};};
api.readProvisionNotice=async id=>{notices.find(x=>x.id===id).read_at=base.ends_at;return {};};
api.retryProvisionNotice=async id=>{notices.find(x=>x.id===id).delivery='pending';return {};};
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><main className="rights-panel" style={{maxWidth:1000,margin:'auto',padding:16}}><aside style={{padding:14,background:'#fff4ce',borderRadius:8,marginBottom:16,fontSize:13}}>140차 기능 검수 · 합성 자료 · 운영 적용 증빙이 아닙니다</aside>{mode==='notices'?<ProvisionNotices/>:<SubjectMappings/>}</main></QueryClientProvider>);
`;
const server=await createServer({root,configFile:false,base:'/',esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:8040,strictPort:true},plugins:[{name:'company140-fixture',resolveId(id){if(id==='/@qa140.jsx')return path.join(root,'__qa140.jsx');},load(id){if(id.endsWith('__qa140.jsx'))return fixture;},configureServer(s){s.middlewares.use((req,res,next)=>{if(!req.url.startsWith('/__qa140'))return next();res.setHeader('Content-Type','text/html');res.end('<html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--text:#17283b;--text-2:#4b6075;--surface:#fff;--border:#d8e0ea;--primary:#1465de;--bg:#f3f6fa;--danger:#ae2424}body{margin:0;background:#f3f6fa}</style><div id="root"></div><script type="module" src="/@qa140.jsx"></script></html>');});}}]});
let browser;const errors=[];
try{
 await server.listen();browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.setViewportSize({width:1280,height:1000});await page.goto('http://127.0.0.1:8040/__qa140');
 await page.getByText('1페이지 · 연결 요청 50건',{exact:false}).waitFor();
 for(let n=2;n<=5;n++){await page.getByRole('button',{name:'연결 요청 다음 페이지',exact:true}).click();await page.getByText(n+'페이지 · 연결 요청 '+(n===5?7:50)+'건',{exact:false}).waitFor();}
 assert(await page.getByRole('button',{name:'연결 요청 다음 페이지',exact:true}).isDisabled());
 await page.screenshot({path:path.join(output,'personal-fifth-page-desktop.png')});
 await page.getByRole('button',{name:'연결 요청 이전 페이지',exact:true}).click();await page.getByText('4페이지 · 연결 요청 50건',{exact:false}).waitFor();
 await page.getByLabel('연결 요청 필터').selectOption('pending');await page.getByText('1페이지 · 연결 요청 3건',{exact:true}).waitFor();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'personal-consent-filter-mobile.png'),fullPage:true});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.getByRole('button',{name:'본인 운행 확인 및 동의',exact:true}).first().click();await page.getByText('1페이지 · 연결 요청 2건',{exact:true}).waitFor();
 assert.equal((await page.evaluate(()=>window.decision)).revision,3);
 await page.goto('http://127.0.0.1:8040/__qa140?mode=notices');await page.getByLabel('제공 내역 필터').selectOption('unread');await page.getByText('1페이지 · 제공 내역 50건',{exact:false}).waitFor();
 await page.getByRole('button',{name:'제공 내역 다음 페이지',exact:true}).click();await page.getByText('2페이지 · 제공 내역 50건',{exact:true}).waitFor();
 assert(await page.getByRole('button',{name:'제공 내역 다음 페이지',exact:true}).isDisabled());
 await page.getByRole('button',{name:'내역 확인 완료',exact:true}).first().click();await page.getByText('2페이지 · 제공 내역 49건',{exact:true}).waitFor();
 await page.screenshot({path:path.join(output,'personal-unread-second-page-mobile.png')});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.getByRole('button',{name:'푸시 다시 요청',exact:true}).click();await page.getByText('푸시 발송 대기',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'푸시 다시 요청',exact:true}).count(),0);
 await page.goto('http://127.0.0.1:8040/__qa140?mode=error');await page.getByRole('alert').waitFor();assert.equal(await page.getByText('확인할 연결 요청이 없습니다.',{exact:true}).count(),0);
 await page.screenshot({path:path.join(output,'personal-error-mobile.png'),fullPage:true});
 await page.getByRole('button',{name:'연결 요청 처음 / 새로고침',exact:true}).click();await page.getByText('1페이지 · 연결 요청 50건',{exact:false}).waitFor();
 await page.goto('http://127.0.0.1:8040/__qa140?mode=slow');await page.getByRole('button',{name:'연결 요청 조회 취소',exact:true}).click();await page.getByText('연결 요청 조회를 취소했습니다.',{exact:false}).waitFor();
 await page.screenshot({path:path.join(output,'personal-cancel-mobile.png'),fullPage:true});
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,'ui-validation.json'),JSON.stringify({at:new Date().toISOString(),environment:'actual React panels and React Query; local synthetic API, Edge headless',checks:['207 mappings reached50/50/50/50/7 and back','status filter resets page','390px no document overflow','consent revision3 preserved and pending row disappears','100 unread notices have exact second-page end','mark read removes current page row; retry resets review','error not empty; explicit retry and cancellation'],errors},null,2));
}finally{await browser?.close();await server.close();}
