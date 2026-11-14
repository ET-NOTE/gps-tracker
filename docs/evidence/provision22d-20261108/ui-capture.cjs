const {chromium}=require(process.env.TEMP+'/gps-admin19-qa/node_modules/playwright');const fs=require('fs'),path=require('path');
(async()=>{const out=path.join(process.cwd(),'docs/evidence/provision22d-20261108');const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const page=await browser.newPage({viewport:{width:1280,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));const rows=[{id:41,revision:2,owner_id:1,subject_id:2,staff_id:10,vehicle_id:3,device_id:4,binding_id:5,starts_at:'2026-11-08T00:00:12.123Z',ends_at:'2026-11-08T01:00:00Z',status:'revoked',effective:false},{id:40,revision:2,owner_id:1,subject_id:2,staff_id:10,vehicle_id:3,device_id:4,binding_id:5,starts_at:'2026-11-07T00:00:00Z',ends_at:'2026-11-07T01:00:00Z',status:'superseded',effective:false,has_successor:true}];
 const pending={...rows[0],id:42,revision:0,status:'pending',replaces_id:41,change_kind:'reconsent',owner_name:'검증 회사',vehicle_name:'검증 차량'};
 let decision=null;
 await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.hostname!=='127.0.0.1')return route.abort();if(!u.pathname.includes('/api/'))return route.continue();let data;
  if(u.pathname.endsWith('/corporate/subject-mappings'))data={enabled:true,items:rows,people:[{staff_id:10,subject_id:2,name:'검증 운전자'}],bindings:[{id:5,vehicle_id:3,device_id:4,starts_at:rows[0].starts_at}]};
  else if(u.pathname.endsWith('/decision')){decision=route.request().postDataJSON();data={status:'confirmed',revision:1};pending.status='confirmed';pending.effective=true;}
  else if(u.pathname.endsWith('/privacy/subject-mappings'))data={enabled:true,items:[pending],consent_version:'fleet-subject-v1',consent_text:'지정된 차량·SIM의 해당 기간 운전자임을 확인하고, 차량 운영 목적으로 이 회사의 권한 있는 사용자에게 위치·운행 기록을 제공하는 데 동의합니다. 철회하면 이후 제공을 중지하며 이미 제공된 자료는 회수되지 않습니다.'};
  else return route.fulfill({status:404,body:'{}'});await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.goto('http://127.0.0.1:8216/gps-tracker/app/qa22d.html');await page.getByRole('button',{name:'재동의 요청',exact:true}).click();await page.screenshot({path:path.join(out,'company-reconsent-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'company-reconsent-mobile.png'),fullPage:true});const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);if(overflow)throw Error('mobile overflow');
 if(!await page.getByLabel('시작',{exact:true}).isDisabled())throw Error('reconsent period not locked');
 await page.goto('http://127.0.0.1:8216/gps-tracker/app/qa22d.html?subject');await page.getByRole('button',{name:'본인 운행 확인 및 동의'}).waitFor();await page.screenshot({path:path.join(out,'subject-reconsent-mobile.png'),fullPage:true});
 await page.getByRole('button',{name:'본인 운행 확인 및 동의'}).click();await page.getByRole('button',{name:'이 연결의 제공 동의 철회'}).waitFor();if(decision.revision!==0||decision.consent_version!=='fleet-subject-v1')throw Error('wrong consent payload');
 if(errors.length)throw Error(JSON.stringify(errors));fs.writeFileSync(path.join(out,'ui-verification.json'),JSON.stringify({actualComponents:['CompanySubjectMappings','SubjectMappings'],syntheticOnly:true,productionEvidence:false,viewports:[1280,390],overflow,errors,exactReconsentPeriodLocked:true,consentRevisionVerified:true,externalRequestsBlocked:true},null,2));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
