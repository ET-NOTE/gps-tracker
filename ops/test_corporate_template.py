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
 cells=sheet(get(a,'report.xlsx',{'type':'nts','month':'2026-10','device_ids':dev}))
 values=list(cells.values());assert 'MODEL_a' in values and 'PLATE_a' in values and 'MODEL_b' not in values
 header=int(next(k for k,v in cells.items() if isinstance(v,str) and v.startswith('③사용'))[1:])
 assert [cells[f'{col}{header}'] for col in 'ABCDEFGHI']==['③사용일자 (요일)','④사용자 부서','④사용자 성명','⑤주행 전 계기판 거리(㎞)','⑥주행 후 계기판 거리(㎞)','⑦주행거리(㎞)','⑧출·퇴근용(㎞)','⑨일반 업무용(㎞)','⑩비고']
 for row in range(header+1,header+5):
  assert cells.get(f'B{row}','')==cells.get(f'D{row}','')==cells.get(f'E{row}','')==''
  assert cells[f'C{row}']=='Driver A'
 assert cells[f'G{header+1}']>0 and cells[f'H{header+1}']==0
 assert cells[f'H{header+2}']>0 and cells[f'G{header+2}']==0
 assert cells[f'F{header+3}']==0
 assert '합계 제외' in cells[f'I{header+4}']
 def summary(prefix):
  key=next(k for k,v in cells.items() if isinstance(v,str) and v.startswith(prefix));return cells.get('E'+key[1:],'')
 assert abs(summary('⑪')-(cells[f'F{header+1}']+cells[f'F{header+2}']))<.001
 assert summary('⑬')==''
 filtered=sheet(get(a,'report.xlsx',{'type':'nts','month':'2026-10','device_ids':dev,'purposes':'commute'}))
 ratio_key=next(k for k,v in filtered.items() if isinstance(v,str) and v.startswith('⑬'))
 assert filtered['E'+ratio_key[1:]]==1
 foreign=sheet(get(b,'report.xlsx',{'type':'nts','month':'2026-10'}));assert 'PLATE_a' not in foreign.values() and 'PLATE_b' in foreign.values()
 for dep in ('VEHICLE_DEPARTMENT_NOT_STAFF','(부서없음)'):
  blob=get(a,'report.xlsx',{'type':'nts','month':'2026-10','departments':dep});assert blob[:2]==b'PK'
 ours=get(a,'report.xlsx',{'type':'ours','month':'2026-10'});assert ours[:2]==b'PK'
 print('PASS XLSX template order, vehicle metadata, blank odometer/staff department, separate commute/business, zero, open-trip exclusion, ratio, filters, tenant isolation, legacy ours workbook')
finally:
 if devices:sql('DELETE FROM location_records WHERE device_id=ANY(%s)',(devices,));sql('DELETE FROM devices WHERE id=ANY(%s)',(devices,))
 if users:sql('DELETE FROM users WHERE id=ANY(%s)',(users,))
 db.close()
