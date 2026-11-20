// Actual React components, synthetic UI fixture only. No production access.
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../gps-tracker-web');
const {createServer}=await import(pathToFileURL(path.join(root,'node_modules/vite/dist/node/index.js')));
const {chromium}=await import(pathToFileURL(path.join(process.env.GPS_QA_NODE_MODULES,'playwright/index.mjs')));
const output=process.env.GPS_QA_OUTPUT;await fs.mkdir(output,{recursive:true});
const fixture=`
import React from 'react';import {createRoot} from 'react-dom/client';import {AdminSecurityGate,AdminSecurityPanel} from '/src/components/AdminSecurity.jsx';import {api} from '/src/api.js';import '/src/index.css';
const mode=new URLSearchParams(location.search).get('mode');
api.adminSecurity=async()=>({enforced:true,enrolled:true,verified:mode!=='gate',role:'officer',ip:'203.0.113.10'});
api.adminPrincipals=async()=>[{user_id:101,name:'검증 책임자',email:'officer@example.invalid',role:'officer',allowed_cidrs:['203.0.113.10/32'],subject_ids:[],mfa_enrolled:true,enabled:true},{user_id:102,name:'검증 관리자',email:'operator@example.invalid',role:'operator',allowed_cidrs:['203.0.113.10/32'],subject_ids:[],mfa_enrolled:true,enabled:true},{user_id:103,name:'검증 취급자',email:'handler@example.invalid',role:'handler',allowed_cidrs:['203.0.113.10/32'],subject_ids:[501],mfa_enrolled:false,enabled:true}];
let approved=false;
api.adminApprovals=async()=>[{id:19,requester_id:102,approver_id:approved?101:null,status:approved?'approved':'pending',reason:'검증 담당 계정 범위 변경',method:'PATCH',path:'/admin/security/principals/103',payload:{role:'handler',enabled:true,allowed_cidrs:['203.0.113.10/32'],subject_ids:[501]},expires_at:new Date(Date.now()+1800000).toISOString()}];
api.adminSecurityEvents=async()=>[{id:1,actor_id:102,ip:'203.0.113.10',action:'propose',route:'/admin/security/approvals',outcome:'pending',created_at:new Date().toISOString()}];
api.adminDecide=async()=>{approved=true;};api.adminMfaVerify=async()=>{throw Error('검증: 인증 코드가 올바르지 않습니다.');};
createRoot(document.getElementById('root')).render(<main style={{maxWidth:1120,margin:'auto',padding:16}}><div style={{background:'#fff4ce',padding:16,marginBottom:16}}>19차 검증 후보 · ${new Date().toISOString()} · 격리 UI 검수 · 합성 계정/지정 IP 예시 · 운영 적용 증빙이 아닙니다</div><AdminSecurityGate><AdminSecurityPanel/></AdminSecurityGate></main>);
`;
const server=await createServer({root,configFile:false,base:'/',esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:8039,strictPort:true},plugins:[{name:'admin19-fixture',resolveId(id){if(id==='/@qa19.jsx')return path.join(root,'__qa19.jsx');},load(id){if(id.endsWith('__qa19.jsx'))return fixture;},configureServer(s){s.middlewares.use((req,res,next)=>{if(!req.url.startsWith('/__qa19'))return next();res.setHeader('Content-Type','text/html');res.end('<html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/@qa19.jsx"></script></html>');});}}]});
let browser;const errors=[];
try{await server.listen();browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});page.on('console',m=>{if(m.type()==='error')console.error(m.text());});
 await page.setViewportSize({width:1440,height:1000});await page.goto('http://127.0.0.1:8039/__qa19');await page.getByText('검증 책임자',{exact:false}).waitFor();
 await page.getByRole('button',{name:'대상·내용 확인'}).click();await page.screenshot({path:path.join(output,'admin-permissions-approval-desktop.png'),fullPage:true});
 await page.getByRole('button',{name:'승인',exact:true}).click();await page.getByText('#19 · 승인됨',{exact:true}).waitFor();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'admin-permissions-mobile.png'),fullPage:true});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.goto('http://127.0.0.1:8039/__qa19?mode=gate');await page.getByRole('heading',{name:'관리자 추가 인증'}).waitFor();
 await page.getByLabel('현재 비밀번호').fill('Synthetic-only-123!');await page.getByLabel('인증 코드').fill('000000');await page.getByRole('button',{name:'인증',exact:true}).click();await page.getByRole('alert').waitFor();
 await page.getByLabel('현재 비밀번호').clear();await page.getByLabel('인증 코드').clear();await page.screenshot({path:path.join(output,'admin-mfa-mobile.png'),fullPage:true});
 assert.equal(await page.getByRole('heading',{name:'관리자 보안',exact:true}).count(),0);assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(output,'ui-validation.json'),JSON.stringify({environment:'local_actual_components_synthetic_data',at:new Date().toISOString(),checks:['desktop permissions and approval details','approval button updates status','390px no document overflow','MFA denial never renders protected content'],errors},null,2));
}finally{await browser?.close();await server.close();}
