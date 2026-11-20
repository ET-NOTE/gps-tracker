// Actual product component; synthetic metadata only; never production evidence.
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../gps-tracker-web');
const {createServer}=await import(pathToFileURL(path.join(root,'node_modules/vite/dist/node/index.js')));
const {chromium}=await import(pathToFileURL(path.join(process.env.GPS_QA_NODE_MODULES,'playwright/index.mjs')));
const output=process.env.GPS_QA_OUTPUT;await fs.mkdir(output,{recursive:true});
const fixture=`
import React from 'react';import {createRoot} from 'react-dom/client';import UnattributedInventory from '/src/components/UnattributedInventory.jsx';import {api} from '/src/api.js';import '/src/index.css';
const rows=[{day:'2026-11-10',device_id:13201,category:'l80',records:24,current_link:'linked'},{day:'2026-11-10',device_id:13202,category:'lte_gnss',records:8,current_link:'unlinked'},{day:'2026-11-09',device_id:13203,category:'other',records:2,current_link:'linked'}];
api.adminUnattributed=async(q,signal)=>{await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,250);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));});});return {items:q.device_id?[]:rows,next_cursor:null,notice:'발생 원인과 실제 정보주체는 별도 확인이 필요합니다.'};};
createRoot(document.getElementById('root')).render(<main style={{maxWidth:1100,margin:'auto',padding:16}}><aside style={{padding:14,background:'#fff4ce',color:'#5d4600',borderRadius:8}}>132차 기능 검증 · 합성 자료 · 운영 화면의 실자료 증빙이 아닙니다</aside><h2 style={{marginTop:20}}>관리자 보안 · 귀속 미상 자료</h2><UnattributedInventory/></main>);
`;
const server=await createServer({root,configFile:false,base:'/',esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:8039,strictPort:true},plugins:[{name:'inventory132-fixture',resolveId(id){if(id==='/@qa132.jsx')return path.join(root,'__qa132.jsx');},load(id){if(id.endsWith('__qa132.jsx'))return fixture;},configureServer(s){s.middlewares.use((req,res,next)=>{if(!req.url.startsWith('/__qa132'))return next();res.setHeader('Content-Type','text/html');res.end('<html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--text:#17283b;--text-2:#4b6075;--surface:#fff;--border:#d8e0ea;--primary:#1465de;--bg:#f3f6fa}body{background:#f3f6fa}</style><div id="root"></div><script type="module" src="/@qa132.jsx"></script></html>');});}}]});
let browser;const errors=[];
try{
  await server.listen();browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:1440,height:950});await page.goto('http://127.0.0.1:8039/__qa132');
  assert.equal(await page.getByRole('table').count(),0);
  await page.getByLabel('시작일').fill('2026-11-01');await page.getByLabel('종료일').fill('2026-11-15');
  await page.getByRole('button',{name:'처음부터 조회'}).click();await page.getByRole('cell',{name:'13201',exact:true}).waitFor();
  await page.screenshot({path:path.join(output,'unattributed-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'unattributed-mobile.png'),fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.getByLabel('장치 번호 (선택)').fill('999');assert.equal(await page.getByRole('table').count(),0);
  await page.getByRole('button',{name:'처음부터 조회'}).click();await page.getByText('선택한 조건에 귀속 미상 자료가 없습니다.',{exact:false}).waitFor();
  await page.screenshot({path:path.join(output,'unattributed-empty-mobile.png'),fullPage:true});
  await page.getByRole('button',{name:'처음부터 조회'}).click();await page.getByRole('button',{name:'조회 취소'}).click();
  await page.waitForTimeout(400);assert.equal(await page.getByRole('table').count(),0);assert.equal(await page.getByRole('alert').count(),0);
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(output,'ui-validation.json'),JSON.stringify({at:new Date().toISOString(),environment:'actual component; local synthetic responses; no production access',checks:['no automatic metadata query','desktop real component render','390px document has no overflow','filter change clears prior rows','empty result bounded to selected scope','cancel does not surface stale result/error'],errors},null,2));
}finally{await browser?.close();await server.close();}
