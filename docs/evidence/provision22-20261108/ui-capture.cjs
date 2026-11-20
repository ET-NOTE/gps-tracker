const {chromium}=require(process.env.TEMP+'/gps-admin19-qa/node_modules/playwright');const fs=require('fs'),path=require('path');
(async()=>{
 const out=path.join(process.cwd(),'docs/evidence/provision22-20261108');fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let row={id:7,revision:0,status:'pending',owner_name:"시리얼링크 시험 회사",vehicle_name:"업무 차량",owner_id:10,subject_id:12,vehicle_id:21,device_id:520211,starts_at:'2026-11-08T00:00:00Z',ends_at:'2026-11-08T01:00:00Z'};
 let notice={...row,id:8,range_from:row.starts_at,range_until:row.ends_at,actor_id:10,outcome:'response_ready',delivery:'provider_accepted',started_at:'2026-11-08T01:05:00Z',read_at:null};
 await page.route('**/gps-tracker/api/v1/**',async route=>{
  const req=route.request(),u=new URL(req.url());let data={};
  if(u.pathname.endsWith('/decision')){const a=req.postDataJSON();row={...row,status:a.action,revision:row.revision+1};data={ok:true};}
  else if(u.pathname.endsWith('/privacy/subject-mappings'))data={enabled:true,items:[row],consent_version:'fleet-subject-v1',consent_text:'지정된 차량·SIM의 해당 기간 운전자임을 확인하고, 차량 운영 목적으로 회사의 권한 있는 사용자에게 위치·운행 기록을 제공하는 데 동의합니다. 철회하면 이후 제공이 중지됩니다.'};
  else if(u.pathname.endsWith('/corporate/subject-mappings'))data={enabled:true,items:[row],people:[{staff_id:4,subject_id:12,name:'시험 운전자'}],bindings:[{id:1,vehicle_id:21,device_id:520211,starts_at:row.starts_at}]};
  else if(u.pathname.endsWith('/provision-notices'))data={items:[notice]};
  else if(u.pathname.endsWith('/read')){notice.read_at='2026-11-08T01:06:00Z';data={ok:true};}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.setViewportSize({width:1280,height:1440});await page.goto('http://127.0.0.1:8214/qa22.html');await page.getByRole('button',{name:'본인 운행 확인 및 동의'}).waitFor();
 await page.screenshot({path:path.join(out,'subject-desktop.png'),fullPage:true});
 await page.getByRole('button',{name:'본인 운행 확인 및 동의'}).click();await page.getByRole('button',{name:'이 연결의 제공 동의 철회'}).waitFor();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'subject-mobile.png'),fullPage:true});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);if(overflow||errors.length)throw Error(JSON.stringify({overflow,errors}));
 await page.getByRole('button',{name:'내역 확인 완료'}).click();await page.getByText('본인 확인:',{exact:false}).waitFor();
 await page.getByRole('button',{name:'이 연결의 제공 동의 철회'}).click();await page.getByText('철회됨').first().waitFor();
 fs.writeFileSync(path.join(out,'ui-verification.json'),JSON.stringify({environment:'isolated actual React with synthetic API; not production',desktop:1280,mobile:390,overflow,errors,confirmation:true,revocation:true,manualAcknowledgement:true,apiMocked:true},null,2)+'\n');await browser.close();
})();
