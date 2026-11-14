// Only uses the isolated fixture; return mutations are in-memory stubs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_PATH));
const base = process.env.PREVIEW_URL || 'http://127.0.0.1:8025', output = process.env.QA_OUTPUT;
if (output) await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
const errors=[],checks=[];
async function capture(page,name) {
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,name);
  const dialog=page.getByRole('dialog');
  if(await dialog.count()) {
    assert.equal(await dialog.evaluate(el=>el.scrollWidth>el.clientWidth+1),false,`${name} dialog overflow`);
    if (await dialog.evaluate(el=>el.classList.contains('gps-modal'))) {
      const button=await dialog.getByRole('button').last().boundingBox();
      assert.ok(button && button.y+button.height<=page.viewportSize().height+1,`${name} footer visible`);
    }
  }
  if(output) await page.screenshot({path:path.join(output,`${name}.png`)});
  checks.push(name);
}
try {
  for (const width of [1440,390,320]) {
    const context=await browser.newContext({viewport:{width,height:width===320?568:900},timezoneId:width===390?'America/Los_Angeles':'Asia/Seoul'});
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>r.request().url().startsWith(base)||r.request().url().startsWith('blob:')?r.continue():r.abort());
    await page.goto(`${base}/tests/business-preview.html?attention=1${width===320?'&dark=1':''}`);
    await page.getByRole('button',{name:'통신 1',exact:true}).click();
    assert.notEqual(await page.locator('.business-task-filter[aria-pressed=true]').evaluate(el=>getComputedStyle(el).backgroundColor),await page.locator('.business-task-filter[aria-pressed=false]').first().evaluate(el=>getComputedStyle(el).backgroundColor));
    assert.equal(await page.locator('.business-task').count(),1);
    await page.getByRole('button',{name:'차량 확인',exact:true}).click();
    await page.getByRole('dialog').waitFor();await capture(page,`attention-detail-${width}`);await page.keyboard.press('Escape');
    await page.getByRole('button',{name:/^반납 \d+$/,exact:true}).click();
    await capture(page,`attention-tasks-${width}`);
    await page.getByRole('button',{name:'반납 처리',exact:true}).first().click();
    const dialog=page.getByRole('dialog');await dialog.waitFor();
    await dialog.getByLabel('반납 오도미터 (km)',{exact:true}).fill('1.5');
    await dialog.getByRole('button',{name:'다음 단계',exact:true}).click();
    await dialog.getByRole('alert').waitFor();
    assert.equal(await page.evaluate(()=>window.__returnCalls.length),0);
    await dialog.getByLabel('반납 오도미터 (km)',{exact:true}).fill('10300');
    await dialog.getByLabel('반납 장소 (선택)',{exact:true}).fill('테스트 반납 장소');
    await dialog.getByLabel('메모 (선택)',{exact:true}).fill('사진 확인 후 처리');
    await capture(page,`return-information-${width}`);
    await dialog.getByRole('button',{name:'다음 단계',exact:true}).click();
    await dialog.getByLabel('기타 금액 (원)',{exact:true}).fill('3000');
    await dialog.getByRole('button',{name:'다음 단계',exact:true}).click();
    await dialog.getByRole('alert').waitFor();
    await dialog.getByLabel('기타 요금 사유 (세차·파손·연료 등)',{exact:true}).fill('세차비');
    await dialog.getByText('인수·반납 사진 확인 및 추가',{exact:true}).click();
    await dialog.locator('.business-history-photo').first().scrollIntoViewIfNeeded();
    await dialog.locator('img').first().waitFor();
    assert.equal(await dialog.locator('img').count(),2);
    await capture(page,`return-charges-${width}`);
    await dialog.getByRole('button',{name:'다음 단계',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.__returnCalls.length),0);
    await capture(page,`return-confirm-${width}`);
    await dialog.getByRole('button',{name:'이전',exact:true}).click();
    assert.equal(await dialog.getByLabel('기타 금액 (원)',{exact:true}).inputValue(),'3000');
    await dialog.getByRole('button',{name:'다음 단계',exact:true}).click();
    await dialog.getByRole('button',{name:'확인 후 반납·정산 완료',exact:true}).click();
    await dialog.getByRole('alert').waitFor();
    const calls=await page.evaluate(()=>window.__returnCalls);
    assert.equal(calls.length,1);assert.equal(calls[0].body.return_odometer_km,10300);assert.equal(calls[0].body.extra_fee_krw,3000);
    assert.ok(Math.abs(Date.parse(calls[0].body.returned_at)-Date.now())<180000,'local time converted to instant');
    await capture(page,`return-failure-${width}`);
    await context.close();
  }
  const page=await browser.newPage({viewport:{width:390,height:844}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/tests/business-preview.html?return-success=1`);
  await page.getByRole('button',{name:'반납 처리',exact:true}).first().click();
  await page.getByRole('button',{name:'다음 단계',exact:true}).click();await page.getByRole('button',{name:'다음 단계',exact:true}).click();
  await page.getByRole('button',{name:'확인 후 반납·정산 완료',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>window.__returnCalls.length),1);checks.push('return-success');
  await page.goto(`${base}/tests/business-preview.html?kind=corporate&next-reservation=1`);
  await page.getByText('다음 예약',{exact:true}).waitFor();
  assert.ok((await page.locator('.business-empty.is-compact').boundingBox()).height<140);
  await capture(page,'corporate-next-reservation');
  await page.getByRole('button',{name:'예약 확인',exact:true}).click();await page.getByRole('dialog').waitFor();checks.push('next-reservation-open');
  await page.goto(`${base}/tests/business-preview.html?photo-error=1`);
  await page.getByRole('button',{name:'반납 처리',exact:true}).first().click();await page.getByRole('button',{name:'다음 단계',exact:true}).click();
  await page.getByText('인수·반납 사진 확인 및 추가',{exact:true}).click();
  await page.getByRole('dialog').locator('.business-history-photo').first().scrollIntoViewIfNeeded();
  await page.getByRole('dialog').getByRole('alert').first().waitFor();await capture(page,'return-photo-error');
  assert.deepEqual(errors,[]);
  const result={checks,errors};console.log(JSON.stringify(result));if(output)await fs.writeFile(path.join(output,'operations-verification.json'),JSON.stringify(result,null,2));
}finally{await browser.close();}
