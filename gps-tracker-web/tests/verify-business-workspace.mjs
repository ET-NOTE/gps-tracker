// UI regression checks against the isolated fixture. No real API writes.
// Run a Vite server (VITE_BASE=/), then set PLAYWRIGHT_PATH and optionally CHROME_PATH.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_PATH));
const base = process.env.PREVIEW_URL || 'http://127.0.0.1:8025';
const output = process.env.QA_OUTPUT;
if (output) await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
const errors = [], checks = [];
async function capture(page, name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name}: page must not scroll horizontally`);
  if (output) await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: false });
  checks.push(name);
}
try {
  for (const width of [1440, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: width > 700 ? 960 : 844 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(base) || route.request().url().startsWith('blob:') ? route.continue() : route.abort());
    await page.goto(`${base}/tests/business-preview.html`);
    await page.getByRole('heading', { name: '렌트카 운영', exact: true }).waitFor();
    await capture(page, `rental-${width}`);
    await page.getByRole('button', { name: '123가 4567 차량 상세', exact: true }).click();
    const drawer = page.getByRole('dialog');
    await drawer.waitFor();
    assert.equal(await drawer.evaluate(el => el.contains(document.activeElement)), true);
    await page.getByRole('button', { name: '계약·사진 이력' }).click();
    await drawer.locator('.business-history-photo').first().scrollIntoViewIfNeeded();
    await drawer.locator('img').first().waitFor();
    assert.equal(await drawer.locator('img').count(), 2);
    await capture(page, `photos-${width}`);
    await page.keyboard.press('Escape');
    assert.equal(await drawer.count(), 0);
    assert.equal(await page.getByRole('button', { name: '123가 4567 차량 상세', exact: true }).evaluate(el => el === document.activeElement), true);
    if (width < 1024) await page.getByRole('button', { name: '배차표', exact: true }).click();
    else await page.getByRole('button', { name: '배차·반납 일정', exact: true }).click();
    await page.getByRole('button', { name: '차량별 배차표', exact: true }).waitFor();
    await page.locator('.business-board').getByText('미리보기 고객 2', { exact: true }).first().waitFor({ state: 'attached' });
    await capture(page, `board-${width}`);
    if (width > 700) {
      assert.equal(await page.getByRole('button', { name: /234나 8901 .* 반납 확인 필요/ }).first().isDisabled(), true);
      await page.getByRole('button', { name: /345다 6789 .* 새 계약/ }).first().click();
      await page.getByRole('dialog').waitFor();
      assert.equal(await page.getByRole('dialog').locator('select').first().inputValue(), '3');
      await capture(page, `contract-${width}`);
      await page.keyboard.press('Escape');
    } else {
      await page.locator('.business-day-strip button').nth(1).click();
      assert.equal(await page.locator('.business-agenda-vehicle').filter({ has: page.getByRole('heading', { name: '234나 8901', exact: true }) }).getByRole('button', { name: '반납 확인 후 배차 가능', exact: true }).isDisabled(), true);
      await page.getByRole('button', { name: '이 날짜에 새 계약', exact: true }).first().click();
      await page.getByRole('dialog').waitFor();
      await capture(page, `contract-${width}`);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '더보기', exact: true }).click();
      await capture(page, `menu-${width}`);
      await page.getByRole('dialog').getByRole('button', { name: '계약 관리', exact: true }).click();
      assert.equal(await page.getByRole('dialog').count(), 0);
    }
    await page.goto(`${base}/tests/business-preview.html?kind=corporate`);
    await page.getByRole('heading', { name: '법인차 운영', exact: true }).waitFor();
    await capture(page, `corporate-${width}`);
    if (width < 1024) {
      await page.getByRole('button', { name: '더보기', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: '운행 리포트', exact: true }).click();
    } else await page.getByRole('navigation', { name: '법인차 운영 메뉴' }).getByRole('button', { name: '운행 리포트', exact: true }).click();
    await page.getByRole('button', { name: '용무 미지정만 보기', exact: true }).click();
    assert.equal(await page.locator('.business-report-progress .business-metric strong').first().textContent(), '50%');
    assert.equal(await page.getByLabel('용무 필터', { exact: true }).inputValue(), 'unspecified');
    assert.equal(await page.locator('.report-area tbody').last().locator('tr').count(), 1);
    await capture(page, `report-${width}`);
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', error => errors.push(error.message));
  for (const state of ['empty', 'error']) {
    await page.goto(`${base}/tests/business-preview.html?${state}=1`);
    await page.getByRole('heading', { name: '렌트카 운영', exact: true }).waitFor();
    await capture(page, `rental-${state}`);
    await page.getByRole('button', { name: '배차표', exact: true }).click();
    if (state === 'error') {
      await page.getByRole('alert').waitFor();
      assert.equal(await page.locator('.business-board-empty').count(), 0, 'failed lookup cannot offer empty slots');
    }
    await capture(page, `board-${state}`);
  }
  await page.goto(`${base}/tests/business-preview.html?photo-error=1`);
  await page.getByRole('button', { name: '123가 4567 차량 상세', exact: true }).click();
  await page.getByRole('button', { name: '계약·사진 이력' }).click();
  await page.getByRole('dialog').locator('.business-history-photo').first().scrollIntoViewIfNeeded();
  await page.getByRole('dialog').getByRole('alert').first().waitFor();
  await capture(page, 'photo-error');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }));
  if (output) await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify({ checks, errors }, null, 2));
} finally { await browser.close(); }
