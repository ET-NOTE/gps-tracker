// Isolated memory fixture only. Never writes people, restrictions or purchases to production.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_PATH));
const base=process.env.PREVIEW_URL || 'http://127.0.0.1:8025', output=process.env.QA_OUTPUT;
if(output) await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
const errors=[],checks=[];
async function open(page,kind='corporate',extra='') {
  await page.goto(`${base}/tests/business-preview.html?people=1&kind=${kind}&${extra}`);
  await page.getByRole('heading',{name:kind==='corporate'?'법인차 운영':'렌트카 운영',exact:true}).waitFor();
}
async function tab(page,label) {
  if(page.viewportSize().width<1024) { await page.getByRole('button',{name:'더보기',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:label,exact:true}).click(); }
  else await page.locator('.business-nav').getByRole('button',{name:label,exact:true}).click();
  await page.getByRole('heading',{name:label,exact:true}).waitFor();
}
async function capture(page,name) {
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${name} page overflow`);
  const dialog=page.getByRole('dialog');
  if(await dialog.count()) {
    assert.equal(await dialog.evaluate(el=>el.scrollWidth>el.clientWidth+1),false,`${name} dialog overflow`);
    const footer=await dialog.locator('.gps-modal-body + div').boundingBox();
    if(footer)assert.ok(footer.y+footer.height<=page.viewportSize().height+1,`${name} footer visible`);
  }
  if(output)await page.screenshot({path:path.join(output,`${name}.png`)});checks.push(name);
}
try {
  for(const width of [1440,390,320]) {
    const page=await browser.newPage({viewport:{width,height:width===320?568:960}});page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>r.request().url().startsWith(base)||r.request().url().startsWith('blob:')?r.continue():r.abort());
    const mode=`support-write=1&support-write-error=1${width===320?'&dark=1':''}`;
    await open(page,'corporate',mode);await tab(page,'운전자');
    await page.locator('.business-person-card').first().waitFor();assert.equal(await page.locator('.business-person-card').count(),3);
    assert.notEqual(await page.locator('.business-task-filter[aria-pressed=true]').evaluate(el=>getComputedStyle(el).backgroundColor),await page.locator('.business-task-filter[aria-pressed=false]').first().evaluate(el=>getComputedStyle(el).backgroundColor));
    await capture(page,`staff-${width}`);
    await page.getByLabel('운전자 검색',{exact:true}).fill('없는 운전자');await page.getByText('검색 조건에 맞는 운전자가 없습니다.',{exact:true}).waitFor();
    await capture(page,`staff-search-empty-${width}`);await page.getByLabel('운전자 검색',{exact:true}).fill('');
    await page.getByRole('button',{name:'비활성 1',exact:true}).click();assert.equal(await page.locator('.business-person-card').count(),1);
    await page.getByRole('button',{name:'전체 3',exact:true}).click();
    await page.getByRole('button',{name:'운전자 추가',exact:true}).click();
    const dialog=page.getByRole('dialog');
    await dialog.getByRole('button',{name:'운전자 저장',exact:true}).click();await dialog.getByText('운전자 이름을 입력해 주세요.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__supportCalls.length),0);
    await dialog.getByLabel('이름 (필수)',{exact:true}).fill('검증 운전자');await dialog.getByLabel('연락처 (선택)',{exact:true}).fill('010-2222-3333');
    await capture(page,`staff-add-${width}`);await dialog.getByRole('button',{name:'운전자 저장',exact:true}).click();
    await dialog.getByText(/운전자를 저장하지 못했습니다/).waitFor();assert.equal(await dialog.getByLabel('이름 (필수)',{exact:true}).inputValue(),'검증 운전자');
    await page.evaluate(()=>{window.__supportFailure=false;});await dialog.getByRole('button',{name:'운전자 저장',exact:true}).evaluate(el=>{el.click();el.click();});
    await dialog.waitFor({state:'detached'});await page.getByRole('button',{name:'전체 4',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__supportCalls.filter(c=>c.action==='staff-create').length),2);
    await page.getByRole('button',{name:'검증 운전자 비활성화',exact:true}).click();await dialog.getByRole('button',{name:'취소',exact:true}).click();assert.equal(await page.evaluate(()=>window.__supportCalls.filter(c=>c.action==='staff-disable').length),0);
    await page.getByRole('button',{name:'검증 운전자 비활성화',exact:true}).click();await capture(page,`staff-status-${width}`);await dialog.getByRole('button',{name:'비활성화 확인',exact:true}).click();
    await page.getByRole('button',{name:'검증 운전자 활성화',exact:true}).waitFor();await page.getByRole('button',{name:'검증 운전자 활성화',exact:true}).click();await dialog.getByRole('button',{name:'활성화 확인',exact:true}).click();await page.getByRole('button',{name:'검증 운전자 비활성화',exact:true}).waitFor();
    const updated=await page.evaluate(()=>window.__supportCalls.find(c=>c.action==='staff-update').body);assert.equal(updated.phone,'010-2222-3333');assert.equal(updated.active,true);
    await tab(page,'설정');await page.getByLabel('상호 (회사명)',{exact:true}).waitFor();
    await capture(page,`company-${width}`);
    await page.getByLabel('상호 (회사명)',{exact:true}).fill('변경 검증 회사');await page.evaluate(()=>{window.__supportFailure=true;});await page.getByRole('button',{name:'회사 정보 저장',exact:true}).click();
    await page.getByText(/회사 정보를 저장하지 못했습니다/).waitFor();assert.equal(await page.getByLabel('상호 (회사명)',{exact:true}).inputValue(),'변경 검증 회사');
    await page.evaluate(()=>{window.__supportFailure=false;});await page.getByRole('button',{name:'회사 정보 저장',exact:true}).evaluate(el=>{el.click();el.click();});await page.getByText('회사 정보를 저장했습니다.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__supportCalls.filter(c=>c.action==='company-save').length),2);
    await page.getByRole('button',{name:'이용권 관리',exact:true}).click();await capture(page,`corporate-subscription-${width}`);
    await page.getByRole('button',{name:'30일 연장',exact:true}).click();await capture(page,`subscription-confirm-${width}`);await dialog.getByRole('button',{name:'취소',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.__supportCalls.filter(c=>c.action.endsWith('-buy')).length),0);
    await open(page,'rental',mode);await tab(page,'임차인');await page.locator('.business-person-card').first().waitFor();
    await capture(page,`renters-${width}`);await page.getByLabel('임차인 검색',{exact:true}).fill('없는 고객');await page.getByText('검색 조건에 맞는 임차인이 없습니다.',{exact:true}).waitFor();await page.getByLabel('임차인 검색',{exact:true}).fill('');
    await page.getByRole('button',{name:'경고·차단 2',exact:true}).click();assert.equal(await page.locator('.business-person-card').count(),2);await page.getByRole('button',{name:'전체 3',exact:true}).click();
    await page.getByRole('button',{name:'미리보기 고객 이용 이력',exact:true}).click();await dialog.getByText('미정산',{exact:true}).first().waitFor();await capture(page,`renter-detail-${width}`);await dialog.getByRole('button',{name:'닫기',exact:true}).last().click();
    await page.getByRole('button',{name:'미리보기 고객 유의사항 관리',exact:true}).click();await dialog.getByRole('button',{name:'유의사항 저장',exact:true}).click();await dialog.getByText('유의사항 사유를 입력해 주세요.',{exact:true}).waitFor();
    await dialog.getByLabel('사유 (필수)',{exact:true}).fill('정산 확인 후 계약');await dialog.getByRole('radio',{name:/신규 계약 차단/}).check();await capture(page,`renter-notice-${width}`);
    await dialog.getByRole('button',{name:'유의사항 저장',exact:true}).click();await dialog.getByText(/유의사항을 저장하지 못했습니다/).waitFor();
    assert.equal(await dialog.getByLabel('사유 (필수)',{exact:true}).inputValue(),'정산 확인 후 계약');await page.evaluate(()=>{window.__supportFailure=false;});await dialog.getByRole('button',{name:'유의사항 저장',exact:true}).evaluate(el=>{el.click();el.click();});
    await dialog.waitFor({state:'detached'});await page.getByRole('button',{name:'경고·차단 3',exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__supportCalls.filter(c=>c.action==='notice-save').length),2);
    await page.getByRole('button',{name:'미리보기 고객 이용 이력',exact:true}).click();await dialog.getByText('정산 확인 후 계약',{exact:true}).waitFor();await dialog.getByRole('button',{name:'닫기',exact:true}).last().click();
    await page.getByRole('button',{name:'미리보기 고객 유의사항 관리',exact:true}).click();await dialog.getByRole('button',{name:'경고·차단 해제',exact:true}).click();assert.equal(await page.evaluate(()=>window.__supportCalls.filter(c=>c.action==='notice-remove').length),0);
    await capture(page,`renter-remove-${width}`);await dialog.getByRole('button',{name:'해제 확인',exact:true}).click();await page.getByRole('button',{name:'경고·차단 2',exact:true}).waitFor();
    await tab(page,'설정');await page.getByRole('button',{name:'30일 이용 시작',exact:true}).waitFor();await capture(page,`rental-subscription-${width}`);
    await page.getByRole('button',{name:'30일 이용 시작',exact:true}).click();assert.equal(await page.evaluate(()=>window.__supportCalls.filter(c=>c.action.endsWith('-buy')).length),0);
    await page.evaluate(()=>{window.__supportFailure=true;});await dialog.getByRole('button',{name:'포인트로 결제',exact:true}).click();await dialog.getByRole('alert').waitFor();
    await page.evaluate(()=>{window.__supportFailure=false;});await dialog.getByRole('button',{name:'포인트로 결제',exact:true}).evaluate(el=>{el.click();el.click();});await dialog.waitFor({state:'detached'});await page.getByRole('button',{name:'30일 연장',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__supportCalls.filter(c=>c.action==='rentcar-buy').length),2);
    await page.close();
  }
  const page=await browser.newPage({viewport:{width:390,height:844}});page.on('pageerror',e=>errors.push(e.message));
  for(const kind of ['corporate','rental']) {
    for(const state of ['empty=1','support-error=1']) {
      await open(page,kind,state);await tab(page,kind==='corporate'?'운전자':'임차인');
      if(state.startsWith('empty'))await page.getByText(kind==='corporate'?'등록된 운전자가 없습니다.':'등록된 임차인이 없습니다.',{exact:true}).waitFor();
      else { await page.getByRole('alert').waitFor();assert.ok((await page.locator('.business-metrics').textContent()).includes('—')); }
      await capture(page,`${kind}-${state.split('=')[0]}`);
      if(state.startsWith('support')) { await page.evaluate(()=>{window.__supportReadError=false;});await page.getByRole('button',{name:'다시 시도',exact:true}).click();await page.locator('.business-person-card').first().waitFor(); }
    }
  }
  assert.deepEqual(errors,[]);const result={checks,errors};console.log(JSON.stringify(result));if(output)await fs.writeFile(path.join(output,'support-verification.json'),JSON.stringify(result,null,2));
}finally{await browser.close();}
