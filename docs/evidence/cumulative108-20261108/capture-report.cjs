// Captures verified JSON results, not a production application screen.
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/msb/AppData/Local/Temp/gps-admin19-qa/node_modules/playwright');
const read = n => JSON.parse(fs.readFileSync(path.join(__dirname, n), 'utf8'));
const main = read('cumulative108.json');
const mapping = read('mapping-history108.json');
const restore = read('protected-restore108.json');
const owner = read('file-owner108.json');
const production = read('production-after.json');
const regressions = read('business-regressions.json');
const provenance = read('code-provenance.json');
if (!main.runtime_ready_for_regressions || !restore.old_consent_not_revived || !owner.api_identity_can_read || regressions.some(x => x.exit)) throw Error('verification incomplete');
const esc = v => String(v).replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const checks = [
  ['누적 마이그레이션', '실제 99 바이너리 → 108 · 100~108 실패 주입 및 재개'],
  ['암호화·파일 접근', '13만 위치 행 · 파일 3개 · 다른 OS 계정의 읽기 확인'],
  ['보호 복원', '전체 DB·파일 복원 · 최신 checkpoint로 중지·철회·파기 재적용'],
  ['업무·권한 회귀', '기존 업무 8시험군 · 매핑·재동의 경계 · 비소유 runtime'],
  ['매핑 이력 부하', `${mapping.synthetic_rows.toLocaleString()}행 / ${mapping.independent_chains}개 연결 이력 / 깊이 ${mapping.max_depth}`],
];
const rows = checks.map(([a,b],i) => `<tr><td><span class="pass" style="${i===4?'background:#fce7e7;color:#9a2424':''}">${i===4?'기준 초과':'통과'}</span></td><th>${a}</th><td>${esc(b)}${i===4?' · 전체 조회 '+Math.max(...mapping.owner_count_seconds).toFixed(2)+'초 (기준 5초)':''}</td></tr>`).join('');
const html = `<!doctype html><meta charset="utf-8"><title>99→108 격리 검증</title><style>
*{box-sizing:border-box}body{margin:0;background:#edf2f7;color:#182b43;font-family:'Malgun Gothic',sans-serif;font-size:16px;line-height:1.7}main{max-width:1200px;margin:36px auto;padding:0 30px 24px}.badge{display:inline-block;background:#fff0cc;color:#785100;border:1px solid #edce80;border-radius:6px;padding:4px 13px;font-weight:700}h1{font-size:36px;margin:12px 0 4px}p{margin:6px 0;color:#51657d}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:24px 0}.card,section{background:white;border:1px solid #d6e0eb;border-radius:12px;padding:22px}.card strong{display:block;font-size:28px;color:#075c78}.card span{font-size:14px;color:#51657d}section{margin-top:18px}h2{margin:0 0 14px;font-size:21px}table{width:100%;border-collapse:collapse}th,td{padding:14px 8px;border-top:1px solid #e4ebf3;text-align:left}th{white-space:nowrap;font-size:16px}td{font-size:14px}.pass{background:#e3f7ed;color:#14714a;padding:3px 10px;border-radius:20px;white-space:nowrap}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.metrics strong{font-size:23px;display:block}.warning{border-color:#e7c582;background:#fffbf2}ul{margin:8px 0;padding-left:24px}li{margin:5px 0}.foot{font-size:12px;margin-top:20px;word-break:break-all;color:#66788c}
</style><main><span class="badge">격리·합성 데이터 검증 보고서 — 운영 배포·운영 화면 증빙 아님</span>
<h1>누적 99 → 108 전환 리허설</h1><p>2026-11-08 · 도구 소스 ${esc(provenance.source_commit.slice(0,7))} · 운영 현황은 읽기 전용 확인 · 외부 메시지 0건</p>
<div class="cards"><div class="card"><span>검증한 후보</span><strong>스키마 108</strong><span>API·웹·migration은 22D와 동일</span></div><div class="card"><span>현재 운영</span><strong>스키마 ${production.schema}</strong><span>API·웹·서비스 PID 유지</span></div><div class="card"><span>합성 위치 표본</span><strong>130,000행</strong><span>623,000 원시 표본 / 실제 자료 복제 없음</span></div></div>
<section><h2>실행 결과</h2><table>${rows}</table></section>
<section><h2>성능 측정 — 운영 SSD 성능을 보장하지 않음</h2><div class="metrics"><div>첫 DB 암호화<strong>${main.timings.initial_db_conversion_seconds.toFixed(2)}초</strong></div><div>전체 월 이력 count<strong>${main.timings.history_points_count_seconds.toFixed(2)}초</strong></div><div>매핑 단건 조회<strong>${mapping.point_query_execution_ms.toFixed(2)}ms</strong></div></div><p>내부 Docker · DB 2CPU / 1,500MiB · tmpfs. 실제 운영 부하·동시 요청은 별도 검증.</p></section>
<section><h2>이번에 보완한 전환 도구</h2><ul><li>암호화 파일 교체 시 기존 소유자·그룹 및 0600 접근 권한 보존</li><li>구 Timescale 자동 삭제 작업이 예약·실행 중이면 전환 차단</li><li>운영에는 현재 구 자동 삭제 작업 0개. 새 DB 구성·복원 시 재확인 필요</li></ul></section>
<section class="warning"><h2>운영 전환 보류 — 매핑 전체 조회 성능 기준 초과</h2><p>매핑 이력 조회 보완 후 재검증 필요. 바인드 로그 보호 · 실제 키/백업/checkpoint 보관과 복원 · 운영 조회 성능/유지보수 시간 · 정책/동의 · 관리자 PC/IP/MFA · 실제 FCM 및 대기열 경보 · 실물 TLS/절전 인수도 남아 있습니다.</p></section>
<div class="foot">검증 API SHA-256: ${esc(main.candidate_sha256)}<br>원본 JSON·로그·SHA256SUMS는 이 보고서와 같은 evidence 폴더에 보관합니다.</div></main>`;
fs.writeFileSync(path.join(__dirname, 'verification-report.html'), html);
(async () => { const browser = await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome'}); try {const page=await browser.newPage({viewport:{width:1280,height:1100},deviceScaleFactor:1});await page.setContent(html);await page.screenshot({path:path.join(__dirname,'verification-report.png'),fullPage:true});} finally {await browser.close();} })();
