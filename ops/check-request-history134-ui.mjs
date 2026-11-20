// Actual history component, local synthetic API, no production access.
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../gps-tracker-web');
const {createServer}=await import(pathToFileURL(path.join(root,'node_modules/vite/dist/node/index.js')));
const {chromium}=await import(pathToFileURL(path.join(process.env.GPS_QA_NODE_MODULES,'playwright/index.mjs')));
const output=process.env.GPS_QA_OUTPUT;await fs.mkdir(output,{recursive:true});
const fixture=`
import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import PersonalRequestHistory from '/src/components/PersonalRequestHistory.jsx';import {api} from '/src/api.js';import '/src/index.css';import '/src/components/PrivacyRequests.css';
const mode=new URLSearchParams(location.search).get('mode');let failed=false;
const states={received:'접수',in_review:'검토 중',needs_information:'추가 확인',rejected:'처리 제한'};
const base={due_at:null,created_at:'2026-11-10T03:00:00Z'};
const simple=[{...base,revision:3,status:'needs_information',message:'요청하신 등록 정보의 대상 기간을 확인해 주세요.',due_at:'2026-11-14T09:00:00Z',created_at:'2026-11-12T02:30:00Z'},{...base,revision:2,status:'in_review',message:'담당자가 요청 내용을 검토하고 있습니다.',due_at:'2026-11-13T09:00:00Z',created_at:'2026-11-11T01:00:00Z'},{...base,revision:1,status:'received',message:''}];
const many=Array.from({length:56},(_,i)=>({...base,revision:56-i,status:'in_review',message:'합성 처리 안내 '+(56-i)}));
api.privacyRequestHistory=async(id,q,signal)=>{await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,200);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));});});if(mode==='error'&&!failed){failed=true;throw Error('처리 이력을 불러오지 못했습니다. 다시 조회해 주세요.');}const rows=(mode==='pages'?many:simple).filter(x=>(!q.before||x.revision<q.before)&&(!q.through||x.revision<=q.through));return {request_id:id,through:q.through||(mode==='pages'?56:3),current_revision:mode==='pages'&&q.through?57:mode==='pages'?56:3,items:rows.slice(0,25),next:rows.length>25?rows[24].revision:null};};
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><main style={{maxWidth:860,margin:'auto',padding:16}}><aside style={{padding:14,background:'#fff4ce',borderRadius:8,marginBottom:16,fontSize:13}}>134차 기능 검수 · 합성 자료 · 운영 적용 증빙이 아닙니다</aside><div className="rights-panel"><section className="rights-card"><h2>요청 내역</h2><article className="rights-request"><div className="rights-heading"><h3>#134 · 정보 정정</h3><span>추가 확인</span></div><p>합성 요청: 등록 정보 확인</p><p className="rights-notice">요청하신 등록 정보의 대상 기간을 확인해 주세요.</p><PersonalRequestHistory requestId={134} statuses={states}/></article></section></div></main></QueryClientProvider>);
`;
const server=await createServer({root,configFile:false,base:'/',esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:8039,strictPort:true},plugins:[{name:'history134-fixture',resolveId(id){if(id==='/@qa134.jsx')return path.join(root,'__qa134.jsx');},load(id){if(id.endsWith('__qa134.jsx'))return fixture;},configureServer(s){s.middlewares.use((req,res,next)=>{if(!req.url.startsWith('/__qa134'))return next();res.setHeader('Content-Type','text/html');res.end('<html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--text:#17283b;--text-2:#4b6075;--surface:#fff;--border:#d8e0ea;--primary:#1465de;--bg:#f3f6fa;--danger:#ae2424}body{margin:0;background:#f3f6fa}</style><div id="root"></div><script type="module" src="/@qa134.jsx"></script></html>');});}}]});
let browser;const errors=[];
try{
 await server.listen();browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.setViewportSize({width:1200,height:1000});await page.goto('http://127.0.0.1:8039/__qa134');
 assert.equal(await page.getByText('1페이지 · 이력 3건',{exact:true}).count(),0);
 await page.getByRole('button',{name:'처리 이력 보기',exact:true}).click();await page.getByText('1페이지 · 이력 3건',{exact:true}).waitFor();
 await page.getByText('당시 처리 기한: 미지정',{exact:true}).waitFor();await page.screenshot({path:path.join(output,'history-public-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'history-public-mobile.png'),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.getByRole('button',{name:'처리 이력 접기',exact:true}).click();assert.equal(await page.getByText('1페이지 · 이력 3건',{exact:true}).count(),0);
 await page.goto('http://127.0.0.1:8039/__qa134?mode=pages');await page.getByRole('button',{name:'처리 이력 보기',exact:true}).click();await page.getByText('1페이지 · 이력 25건',{exact:true}).waitFor();
 await page.getByRole('button',{name:'이력 다음',exact:true}).click();await page.getByText('2페이지 · 이력 25건',{exact:true}).waitFor();
 await page.getByRole('button',{name:'이력 다음',exact:true}).click();await page.getByText('3페이지 · 이력 6건',{exact:true}).waitFor();await page.getByText('새 처리 내용이 있습니다.',{exact:false}).waitFor();
 await page.screenshot({path:path.join(output,'history-third-page-mobile.png'),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.goto('http://127.0.0.1:8039/__qa134?mode=error');await page.getByRole('button',{name:'처리 이력 보기',exact:true}).click();await page.getByRole('alert').waitFor();
 assert.equal(await page.getByText('이 범위에 기록된 처리 이력이 없습니다.',{exact:true}).count(),0);await page.screenshot({path:path.join(output,'history-retry-mobile.png'),fullPage:true});
 await page.getByRole('button',{name:'이력 처음 / 새로고침',exact:true}).click();await page.getByText('1페이지 · 이력 3건',{exact:true}).waitFor();
 await page.getByRole('button',{name:'이력 처음 / 새로고침',exact:true}).click();await page.getByRole('button',{name:'이력 조회 취소',exact:true}).click();await page.getByText('이력 조회를 취소했습니다.',{exact:false}).waitFor();
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,'ui-validation.json'),JSON.stringify({at:new Date().toISOString(),environment:'actual React history component; synthetic local API responses',checks:['lazy expansion and collapse','public status/message/historical deadline display','390px no document overflow','56 revisions25/25/6 and newer-update notice','error distinct from empty and retry succeeds','cancel visible and late results hidden'],errors},null,2));
}finally{await browser?.close();await server.close();}
