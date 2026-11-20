// Local-only UI fixtures. All mutations are mocked; no live accounts or payments.
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../gps-tracker-web');
const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')));
const { chromium } = await import(pathToFileURL(path.join(process.env.GPS_QA_NODE_MODULES, 'playwright/index.mjs')));
const output = process.env.GPS_QA_OUTPUT;
await fs.mkdir(output, { recursive: true });
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import Vehicle from '/src/components/VehicleCarePanel.jsx';
import Share from '/src/components/ShareLinkPanel.jsx';
import Notifications from '/src/components/NotificationSettings.jsx';
import DialogHost from '/src/components/Dialog.jsx';
import {ToastHost} from '/src/components/ui/Toast.jsx';
import {applyTheme} from '/src/theme.js';
import {api} from '/src/api.js';
import '/src/index.css';
window.qa = {writes:[],shares:0,fail:false};
const device={id:1,display_name:'테스트 차량',car_plate:'123가 4567',car_model:'아반떼'};
api.updateDevice=async(id,body)=>{if(window.qa.fail)throw Error('저장할 수 없습니다.');window.qa.writes.push(body);return {...device,...body};};
api.uploadCarImage=async()=>({url:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="teal"/></svg>'});
api.listShares=async()=>[];
api.createShare=async(id,body)=>{window.qa.shares++;return {id:2,token:'fixture-token',note:body.note,expires_at:new Date(Date.now()+3600000).toISOString(),view_count:0};};
api.getNotificationSettings=async()=>({signal_loss_minutes:5,offline_minutes:30,low_batt_threshold_mv:3500,reservation_alert:true,rental_alert:true});
api.updateNotificationSettings=async body=>({...await api.getNotificationSettings(),...body});
applyTheme(new URLSearchParams(location.search).get('theme')||'light',{syncServer:false,persist:false});
createRoot(document.getElementById('root')).render(<main className="gps-user-panel qa-shell">
  <section><h2>차량 정보</h2><Vehicle device={device}/></section>
  <section><h2>위치 공유</h2><Share deviceId={1}/></section>
  <section><h2>알림 설정</h2><Notifications/></section><DialogHost/><ToastHost/>
</main>);
`;
const server = await createServer({ root, configFile: false, base: '/', esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 8036, strictPort: true }, plugins: [{ name: 'isolated-ui-fixture',
    resolveId(id) { if (id === '/@qa.jsx') return path.join(root, '__qa_fixture__.jsx'); },
    load(id) { if (id.endsWith('/__qa_fixture__.jsx') || id.endsWith('\\__qa_fixture__.jsx')) return fixture; },
    configureServer(s) { s.middlewares.use((req,res,next)=>{if(!req.url.startsWith('/__qa'))return next();
      res.setHeader('Content-Type','text/html');res.end('<html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>.qa-shell{max-width:840px;margin:auto;padding:16px;display:grid;gap:24px}.qa-shell>section{padding:20px;border:1px solid var(--border);border-radius:14px;min-width:0}.qa-shell h2{font-size:18px;margin-bottom:18px}@media(max-width:400px){.qa-shell{padding:10px}.qa-shell>section{padding:14px}}</style><div id="root"></div><script type="module" src="/@vite/client"></script><script type="module" src="/@qa.jsx"></script></html>');
    }); },
  }] });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route => new URL(route.request().url()).hostname==='127.0.0.1' || route.request().url().startsWith('data:') ? route.continue() : route.abort());
  for(const width of [320,390,768,1280]) for(const theme of ['light','dark']) {
    await page.setViewportSize({width,height:900});
    await page.goto('http://127.0.0.1:8036/__qa?theme='+theme);
    await page.getByRole('button',{name:'차량 정보 저장'}).waitFor();
    await page.getByRole('switch',{name:'차량 반납 알림',exact:true}).waitFor();
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), 'page overflow '+width);
    const bounds=await page.locator('.vehicle-care input:not([hidden])').evaluateAll(xs=>xs.map(x=>({width:x.getBoundingClientRect().width,height:x.getBoundingClientRect().height})));
    assert(bounds.every(x=>x.width>0&&x.height>=44));
    await page.screenshot({path:path.join(output,'app-'+width+'-'+theme+'.png'),fullPage:true});
  }
  await page.getByLabel('차량 번호',{exact:true}).fill('456나 7890');
  await page.getByLabel('다음 정비 주행거리',{exact:true}).fill('50000');
  await page.getByRole('button',{name:'차량 정보 저장'}).click();
  await page.getByText('차량 정보를 저장했습니다.').waitFor();
  assert.deepEqual(await page.evaluate(()=>window.qa.writes[0]),{car_plate:'456나 7890',car_model:'아반떼',next_service_date:null,next_service_km:50000,insurance_expiry:null,inspection_expiry:null});
  await page.evaluate(()=>window.qa.fail=true);
  await page.getByRole('button',{name:'차량 정보 저장'}).click();
  await page.getByRole('alert').filter({hasText:'저장할 수 없습니다.'}).waitFor();
  await page.getByRole('button',{name:'새 공유 링크 만들기'}).click();
  await page.getByRole('button',{name:'만들고 복사하기'}).click();
  await page.getByRole('button',{name:'취소',exact:true}).last().click();
  assert.equal(await page.evaluate(()=>window.qa.shares),0,'cancel must not purchase');
  await page.getByRole('button',{name:'만들고 복사하기'}).click();
  await page.getByRole('button',{name:'만들기',exact:true}).click();
  await page.getByRole('button',{name:'링크 복사',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.qa.shares),1);
  assert.deepEqual(errors,[]);
  console.log('PASS: 8 viewport/theme renders; no overflow; accessible inputs; vehicle save/error; share cancel/purchase.');
} finally { await browser?.close(); await server.close(); }
