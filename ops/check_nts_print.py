"""Inspect synthetic PDFs rendered by tests/render-nts-print.mjs. No server access."""
import json,pathlib,re,sys
import pdfplumber

root=pathlib.Path(sys.argv[1]); results={}
for name in ('standard','multipage','missing','empty','long'):
 with pdfplumber.open(root/(name+'.pdf')) as doc:
  texts=[]
  for i,page in enumerate(doc.pages):
   assert abs(page.width-841.89)<1 and abs(page.height-595.28)<1
   assert all(c['x0']>=29 and c['x1']<=813 and c['top']>=29 and c['bottom']<=590 for c in page.chars), (name,i,'clipped text')
   text=page.extract_text();texts.append(text)
   assert f'{i+1} / {len(doc.pages)}' in text, (name,i,'page number')
  all_text='\n'.join(texts)
  assert '업무용승용차 운행기록부' in texts[0]
  assert '11 조회 내역 총주행거리' in all_text and '12 조회 내역 업무용 사용거리' in all_text
  if name=='multipage':
   assert len(doc.pages)>1
   ids=re.findall(r'사용자(\d+)',all_text);assert sorted(map(int,ids))==list(range(1,71)), ids
   for page,text in zip(doc.pages,texts):
    assert '4 사용자' in text and '운행 내역' in text
    # Each two-line date and each driver stay on the same page; footer and
    # query-period header dates are excluded by their positions.
    body=page.crop((29,150 if page.page_number==1 else 29,813,550)).extract_text()
    dates=re.findall(r'2026-10-\d{2}',body)
    days=re.findall(r'\([일월화수목금토]\)',body)
    names=re.findall(r'사용자\d+',body)
    assert len(dates)==len(days)==len(names), (page.page_number,dates,days,names)
   assert '692.45' in all_text and '351.26' in all_text and '341.19' in all_text
  if name=='long':
   assert '상세 비고 1 참조' in texts[0] and '상세 비고' in texts[1]
   assert all_text.count('긴 비고 보존 검증입니다.')==260 and '비고끝' in all_text
  if name=='missing':assert '미계산' in all_text and '합계 제외' in all_text and '필터 적용 내역' in all_text
  if name=='empty':assert '내역이 없습니다.' in all_text and '미계산' in all_text
  results[name]={'pages':len(doc.pages),'characters':sum(map(len,texts))}
(root/'verification.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
print(json.dumps(results))
