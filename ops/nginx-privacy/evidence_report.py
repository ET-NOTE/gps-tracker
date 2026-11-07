"""Build a labelled evidence viewer from saved test JSON, not a simulated administrator UI."""
import hashlib,html,json,pathlib
root=pathlib.Path(__file__).resolve().parents[2]/'docs/operations/evidence/location-business-round18a-20261107'
def read(name):return json.loads((root/name).read_text(encoding='utf-8'))
live=read('live-verification.json');v=read('validation.json');n=read('nginx-validation.json');m=read('manifest.json')
def esc(x):return html.escape(str(x))
def row(label,value):return f'<tr><th>{esc(label)}</th><td>{esc(value)}</td></tr>'
def source(name):
    digest=hashlib.sha256((root/name).read_bytes()).hexdigest()
    return f'<div class="source">원본: {esc(name)}<br>SHA-256 {digest}</div>'
page='''<!doctype html><html lang="ko"><meta charset="utf-8"><title>GPS 18A 실제 검증 보고서</title>
<style>body{margin:0;background:#f1f5f9;color:#11243a;font:18px/1.5 "Malgun Gothic",sans-serif}main{max-width:1100px;margin:auto;padding:32px}section{background:white;padding:30px;margin:0 0 28px;border:1px solid #dce4ed;border-radius:16px;min-height:760px;box-sizing:border-box}h1{font-size:28px;margin:8px 0}h2{font-size:24px}p{margin:12px 0}.tag{color:#047857;font-weight:bold}.note{background:#fff7df;padding:16px;font-size:16px;border-left:4px solid #eab308}table{border-collapse:collapse;width:100%;margin:20px 0}td,th{padding:12px;text-align:left;border-bottom:1px solid #e2e8f0}th{width:35%;font-weight:600}code,.source{font-family:Consolas,monospace;overflow-wrap:anywhere}.source{color:#52647a;font-size:13px;margin-top:16px}a{color:#0369a1}small{font-size:14px}</style><main>
<section id="production"><div class="tag">운영 확인 · gps.serial.kr</div><h1>18A 로그 보호 패치 — 실제 검증 보고서</h1>
<p>실제 실행 결과 JSON을 표시한 보고서입니다. 관리자 설정 화면이나 전체 보안 적합성 증명은 아닙니다.</p>'''
page+=f'<small>검증 시각(UTC): {esc(live["checked_at"])} · 2026-11-07 17:17 KST</small><table>'
page+=row('운영 릴리스',live['health']['release'])+row('API / DB health','정상' if live['health']['ok'] and live['health']['db'] else '실패')
page+=row('스키마 / 웹 / PDF','99 유지 / 기존 웹 유지 / 처리기 유지')
page+=row('접근·오류 로그의 가짜 토큰','노출 없음' if live['access_secret_absent'] and live['error_secret_absent'] else '실패')
page+=row('기존 공용 로그 중복 기록','없음' if live['global_log_copy_absent'] else '실패')
page+=row('API 로그 가짜 토큰 / 오류 분류기','노출 없음 / '+live['logger'])+'</table>'
page+='<p class="note">범위: 합성 요청과 오류 소켓 시험. 실제 계정·위치·결제를 변경하지 않았습니다. 과거 로그는 삭제하지 않았고, 조회 취급대장·MFA·위치 저장 암호화는 완료 증빙에 포함하지 않습니다.</p>'
page+=source('live-verification.json')+source('apply-result.json')+'<p><a href="#isolated">격리 검증 결과 ↓</a></p></section>'
page+='<section id="isolated"><div class="tag">격리 검증 · 빌드 호스트</div><h1>정상 동작·비밀값 차단·복구 시험</h1><p>합성 데이터로 수행한 실제 시험입니다. 운영 사용자 자료를 사용하지 않았습니다.</p><table>'
page+=row('Rust fmt / Clippy','통과')+row('운영 패치 단위 시험',f'{v["rust_passed"]} 통과 · 기존 {v["rust_ignored"]} 제외')
page+=row('기존 열람 기능 통합 시험',f'{v["facts_groups"]}개 묶음 통과 · 스키마 {v["schema"]}')
page+=row('배포·복구 제어 시험',f'{v["release_control_tests"]}개 통과')
page+=row('Nginx 요청·오류 분류',f'{n["requests"]}개 요청 / {len(n["classified_error_categories"])}개 오류 유형')
page+=row('비밀값 제외 / 로그 회전','통과 / 통과')+row('보관기간 문구','1년 자동 파기 단정 제거 · 실제 제공 응답 확인')+'</table>'
page+='<p class="note">다음 18B: 조회 시점의 귀속 고정, 건별 기록·내구성, 철회 삭제 경로, 경로 누락 검증. 기존 조회 기록 기능은 운영 미배포·OFF입니다.</p>'
page+=source('validation.json')+source('nginx-validation.json')+f'<div class="source">API SHA-256: {esc(m["api_sha256"])}</div></section></main></html>'
(root/'report.html').write_text(page,encoding='utf-8',newline='\n')
(root/'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n' for p in sorted(root.iterdir()) if p.is_file() and p.name!='SHA256SUMS'),encoding='utf-8',newline='\n')
print(root/'report.html')
