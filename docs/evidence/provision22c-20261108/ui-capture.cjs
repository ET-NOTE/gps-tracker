const {chromium}=require(process.env.TEMP+'/gps-admin19-qa/node_modules/playwright');
const fs=require('fs'),path=require('path');
(async()=>{const out=path.join(process.cwd(),'docs/evidence/provision22c-20261108');const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));let state='critical';
 const healthy={expected_running:true,enabled:true,push_enabled:true,severity:'ok',pending:0,inflight:0,review:0,accepted_5m:1200,failed_5m:0,oldest_pending_seconds:0,alerts:[],checked_at:'2026-11-08T00:00:00Z'};
 await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.hostname!=='127.0.0.1')return route.abort();if(!u.pathname.endsWith('/admin/security/notice-queue'))return route.continue();
  if(state==='failed')return route.fulfill({status:503,contentType:'application/json',body:'{"error":"synthetic"}'});
  const data=state==='critical'?{...healthy,severity:'critical',pending:127,review:3,accepted_5m:1073,failed_5m:24,oldest_pending_seconds:960,alerts:['backlog_critical','manual_review','worker_stale']}:healthy;
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.goto('http://127.0.0.1:8215/gps-tracker/app/qa22c.html');await page.getByText('조치 필요',{exact:false}).waitFor();
 await page.screenshot({path:path.join(out,'queue-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'queue-mobile.png'),fullPage:true});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);if(overflow)throw Error('mobile overflow');
 state='healthy';await page.getByRole('button',{name:'상태 새로고침'}).click();await page.getByText('정상 처리 중',{exact:false}).waitFor();await page.screenshot({path:path.join(out,'queue-recovered.png'),fullPage:true});
 state='failed';await page.getByRole('button',{name:'상태 새로고침'}).click();await page.getByRole('alert').waitFor();if(await page.getByText('정상 처리 중',{exact:false}).count())throw Error('stale healthy status shown');await page.screenshot({path:path.join(out,'queue-unavailable.png'),fullPage:true});
 if(errors.length)throw Error(JSON.stringify(errors));fs.writeFileSync(path.join(out,'ui-verification.json'),JSON.stringify({actualComponent:'NoticeQueuePanel',syntheticOnly:true,productionEvidence:false,viewports:[1280,390],overflow,errors,criticalRecoveryAndFailure:true,externalRequestsBlocked:true},null,2));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
