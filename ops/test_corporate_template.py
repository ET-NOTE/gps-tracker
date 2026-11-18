"""Verify generated XLSX cells and tenant filters with synthetic data in the private clone."""
import base64,datetime,hashlib,hmac,io,json,pathlib,sys,time,urllib.request,urllib.parse,uuid,zipfile,xml.etree.ElementTree as ET
import psycopg2
envpath,base=sys.argv[1:3]
assert base=='http://127.0.0.1:3042'
c={k:v.strip().strip('"').strip("'") for k,v in (l.split('=',1) for l in pathlib.Path(envpath).read_text().splitlines() if '=' in l and not l.startswith('#'))}
assert urllib.parse.urlsplit(c['DATABASE_URL']).path=='/gps_tracker_dev_prodreview_20261020'
db=psycopg2.connect(c['DATABASE_URL']);db.autocommit=True;cur=db.cursor();users=[];devices=[];run=uuid.uuid4().hex
def sql(q,args=()):
 cur.execute(q,args);return cur.fetchone()[0] if cur.description else None
def jwt(user):
 enc=lambda v:base64.urlsafe_b64encode(json.dumps(v).encode()).rstrip(b'=')
 raw=enc({'alg':'HS256','typ':'JWT'})+b'.'+enc({'sub':str(user),'typ':'access','iat':int(time.time()),'exp':int(time.time())+900})
 return (raw+b'.'+base64.urlsafe_b64encode(hmac.new(c['JWT_SECRET'].encode(),raw,hashlib.sha256).digest()).rstrip(b'=')).decode()
def get(user,route,params):
 request=urllib.request.Request(base+'/gps-tracker/api/v1/corporate/'+route+'?'+urllib.parse.urlencode(params),headers={'Authorization':'Bearer '+jwt(user)})
 with urllib.request.urlopen(request,timeout=60) as r:return r.read()
def sheet(blob):
 with zipfile.ZipFile(io.BytesIO(blob)) as z:
  ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
  strings=[''.join(si.itertext()) for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('s:si',ns)]
  cells={}
  for cell in ET.fromstring(z.read('xl/worksheets/sheet1.xml')).findall('.//s:sheetData/s:row/s:c',ns):
   val=cell.find('s:v',ns)
   if val is not None:cells[cell.attrib['r']]=strings[int(val.text)] if cell.attrib.get('t')=='s' else float(val.text)
  return cells

def summary(cells,prefix):
 # Summary labels occupy three merged columns; the value is below the label.
 key=next(k for k,v in cells.items() if isinstance(v,str) and v.startswith(prefix))
 col=key.rstrip('0123456789');row=int(key[len(col):])
 return cells.get(f'{col}{row+1}','')

def template_layout(blob):
 cells=sheet(blob)
 header=int(next(k for k,v in cells.items() if isinstance(v,str) and v.startswith('③사용'))[1:])
 expected={f'A{header}':'③사용일자\n(요일)',f'B{header}':'④사용자',f'D{header}':'운 행 내 역',
  f'B{header+1}':'부서',f'C{header+1}':'성명',f'D{header+1}':'⑤주행 전\n계기판 거리(㎞)',
  f'E{header+1}':'⑥주행 후\n계기판 거리(㎞)',f'F{header+1}':'⑦주행거리\n(㎞)',
  f'G{header+1}':'업무용 사용거리(㎞)',f'G{header+2}':'⑧출·퇴근용',f'H{header+2}':'⑨일반 업무용',f'I{header+1}':'⑩비고'}
 assert {key:cells.get(key) for key in expected}==expected
 assert '1. 기본정보' in cells.values() and '2. 업무용 사용비율 계산' in cells.values()
 with zipfile.ZipFile(io.BytesIO(blob)) as z:
  ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
  root=ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
  merges={node.attrib['ref'] for node in root.findall('s:mergeCells/s:mergeCell',ns)}
  assert {f'A{header}:A{header+2}',f'B{header}:C{header}',f'D{header}:I{header}',f'G{header+1}:H{header+1}'}<=merges
  page=root.find('s:pageSetup',ns)
  assert page is not None and page.attrib['orientation']=='landscape' and page.attrib['paperSize']=='9'
  assert page.attrib.get('fitToWidth','1')=='1' and page.attrib.get('fitToHeight')=='0'
  defined=ET.fromstring(z.read('xl/workbook.xml')).findall('s:definedNames/s:definedName',ns)
  repeat=next(node.text for node in defined if node.attrib['name']=='_xlnm.Print_Titles' and node.attrib.get('localSheetId')=='0')
  assert repeat.endswith(f'!${header}:${header+2}')
 return header+3
try:
 for label in ('a','b'):
  user=sql("INSERT INTO users(email,password_hash,display_name,phone) VALUES(%s,'test-only','Template review','01000000000') RETURNING id",(f'template-{run}-{label}@example.invalid',));users.append(user)
  sql("INSERT INTO subscriptions(user_id,kind,expires_at) VALUES(%s,'corporate_report',now()+interval '1 day')",(user,))
  sql("INSERT INTO corporate_info(user_id,company_name,business_number) VALUES(%s,%s,'000-00-00000')",(user,'Company '+label))
  devices.append(sql("INSERT INTO devices(device_uid,owner_id,api_key_hash,license_plate,car_model,department) VALUES(%s,%s,'',%s,%s,'VEHICLE_DEPARTMENT_NOT_STAFF') RETURNING id",('template-'+run+label,user,'PLATE_'+label,'MODEL_'+label)))
 a,b=users;dev=devices[0]
 staff=sql("INSERT INTO staff(user_id,name) VALUES(%s,'Driver A') RETURNING id",(a,))
 for n,purpose in enumerate(('commute','business','other','business')):
  start=datetime.datetime(2026,10,8,1+2*n,tzinfo=datetime.timezone.utc);end=start+datetime.timedelta(minutes=10)
  sql("INSERT INTO events(device_id,user_id,kind,occurred_at) VALUES(%s,%s,'wake',%s)",(dev,a,start))
  if n<3:sql("INSERT INTO events(device_id,user_id,kind,occurred_at) VALUES(%s,%s,'sleep_enter',%s)",(dev,a,end))
  for step in range(3):sql("INSERT INTO location_records(device_id,user_id,source,fix,lat,lng,recorded_at) VALUES(%s,%s,'l80',true,%s,127,%s)",(dev,a,35+(0 if n==2 else step*.001),start+datetime.timedelta(minutes=step*5)))
  sql("INSERT INTO trip_annotations(device_id,user_id,trip_started_at,purpose,driver_staff_id) VALUES(%s,%s,%s,%s,%s)",(dev,a,start,purpose,staff))
 blob=get(a,'report.xlsx',{'type':'nts','month':'2026-10','device_ids':dev})
 cells=sheet(blob);first=template_layout(blob)
 values=list(cells.values());assert 'MODEL_a' in values and 'PLATE_a' in values and 'MODEL_b' not in values
 for row in range(first,first+4):
  assert cells.get(f'B{row}','')==cells.get(f'D{row}','')==cells.get(f'E{row}','')==''
  assert cells[f'C{row}']=='Driver A'
 assert cells[f'G{first}']>0 and cells[f'H{first}']==0
 assert cells[f'H{first+1}']>0 and cells[f'G{first+1}']==0
 assert cells[f'F{first+2}']==0
 assert '합계 제외' in cells[f'I{first+3}']
 assert abs(summary(cells,'⑪')-(cells[f'F{first}']+cells[f'F{first+1}']))<.001
 assert summary(cells,'⑬')==''
 filtered=sheet(get(a,'report.xlsx',{'type':'nts','month':'2026-10','device_ids':dev,'purposes':'commute'}))
 assert summary(filtered,'⑬')==1
 assert any(isinstance(value,str) and '목적: 출퇴근' in value and '필터 적용' in value for value in filtered.values())
 foreign=sheet(get(b,'report.xlsx',{'type':'nts','month':'2026-10'}));assert 'PLATE_a' not in foreign.values() and 'PLATE_b' in foreign.values()
 for dep in ('VEHICLE_DEPARTMENT_NOT_STAFF','(부서없음)'):
  blob=get(a,'report.xlsx',{'type':'nts','month':'2026-10','departments':dep});assert blob[:2]==b'PK'
 ours=get(a,'report.xlsx',{'type':'ours','month':'2026-10'});assert ours[:2]==b'PK'
 print('PASS XLSX template order, vehicle metadata, blank odometer/staff department, separate commute/business, zero, open-trip exclusion, ratio, filters, tenant isolation, legacy ours workbook')
finally:
 if devices:sql('DELETE FROM location_records WHERE device_id=ANY(%s)',(devices,));sql('DELETE FROM devices WHERE id=ANY(%s)',(devices,))
 if users:sql('DELETE FROM users WHERE id=ANY(%s)',(users,))
 db.close()
