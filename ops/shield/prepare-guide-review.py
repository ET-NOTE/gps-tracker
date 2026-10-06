"""Prepare a reviewed, revision-checked content update from a public post snapshot. No network writes."""
import argparse, copy, hashlib, json, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ROOT / 'arduino/shield_examples'
def digest(content):
    return hashlib.sha256(json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    public={x['id']:x for x in json.loads(args.snapshot.read_text(encoding='utf-8'))}
    def content(slug):
        return {k:copy.deepcopy(v) for k,v in public[slug].items() if k not in ('revision','updated_at')}
    start=content('start')
    assert public['start']['revision']==8 and len(start['steps'])==5, 'Re-review current administrator edits first'
    photos={p['after_step']:p for p in start['images']}
    assert set(photos)=={1,2,3,4}
    def photo(step, at, caption=None):
        p=copy.deepcopy(photos[step]);p['after_step']=at
        if caption is not None:p['caption']=caption
        return p
    demo={'id':'@devices-demo','after_step':5,'alt':'내 장치 데모 화면. 체험용 장치의 USIM 잔량 350 / 500 MB와 충전하기 버튼을 보여 줍니다.',
          'caption':'내 장치 · 데모 화면 (실제 단말·잔액 아님)'}
    basic='[Arduino 설치](/examples/arduino-basics-install) · [COM 포트 확인](/examples/arduino-basics-com-port) · [업로드 방법](/examples/arduino-basics-upload)'
    updated={}
    for slug,at in [('shield-uno-connect',2),('shield-uno-dht11',2),('shield-uno-gnss',2),('shield-uno-upload',4),('shield-uno-firebase',4)]:
        p=content(slug)
        p['steps'][at-1]+='\n처음 사용한다면 '+basic+'을 확인하세요.'
        if slug in ('shield-uno-dht11','shield-uno-upload','shield-uno-firebase'):
            p['steps'][at-1]+='\n[DHT 라이브러리 설치 방법](/examples/arduino-basics-libraries)에서 설치 화면을 확인할 수 있습니다.'
        p['images'].append(photo(1,1 if slug!='shield-uno-firebase' else 4,
            '실물 쉴드·안테나·배터리 연결 사진 · DHT11 배선 사진은 별도 준비 중' if slug in ('shield-uno-dht11','shield-uno-upload','shield-uno-firebase') else '실물 쉴드·안테나·배터리 연결 사진'))
        p['images'].append(photo(2,at,'Arduino IDE 설정 안내 · 실제 설치 화면은 본문의 기초 사용법 링크 참조'))
        if slug=='shield-uno-connect':
            p['steps'][0]=p['steps'][0].replace('(이미지) 쉴드 장착 방향, LTE/GNSS 안테나 커넥터, USIM과 전원 연결.','왼쪽 실물 사진에서 쉴드 장착 방향과 안테나·배터리 연결 상태를 확인하세요.')
        if slug=='shield-uno-gnss':
            p['steps'][0]+='\n왼쪽 실물 사진은 쉴드 연결 상태입니다. 안테나의 실외 배치와 수신 화면은 직접 촬영해 추가할 예정입니다.'
        if slug=='shield-uno-upload':
            p['images'].extend([photo(3,1),photo(4,5)])
        updated[slug]=p
    # Keep downloadable GUIDE.md aligned with the reviewed web text. Images remain managed by the CMS.
    articles=json.loads((EXAMPLES/'articles.json').read_text(encoding='utf-8'))
    for article in articles:
        revised=updated[article['content']['id']]
        article['content']={k:v for k,v in revised.items() if k not in ('images','attachments','code')}
    (EXAMPLES/'articles.json').write_text(json.dumps(articles,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    subprocess.run([sys.executable,str(EXAMPLES/'tools/package_examples.py')],check=True)
    packaged={x['content']['id']:x for x in json.loads((EXAMPLES/'dist/publication.json').read_text(encoding='utf-8'))}
    first=copy.deepcopy(packaged['shield-uno-first-upload']['content'])
    first['images']=[photo(1,1),photo(3,1),photo(2,2),{**demo,'after_step':4}]
    updated[first['id']]=first
    start['description']='쉴드를 연결하고 장치를 등록한 뒤, 실제 예제를 업로드하여 서버 수신과 USIM 잔량을 확인하세요.'
    start['minutes']=35
    start['step_titles']=['쉴드 연결','장치 등록','예제 업로드','서버 데이터 전송 확인','USIM 데이터 확인']
    original=start['steps']
    start['steps']=[
        original[0].strip()+'\nUNO R3용 예제입니다. 배선과 장착 방향을 확인한 뒤 제품 안내에 따라 전원을 켜고 USB를 PC에 연결합니다. [첫 연결 점검](/examples/shield-uno-connect)을 참고하세요.',
        '[내 장치](/devices)에서 제품과 함께 받은 일회용 등록 코드로 장치를 먼저 등록합니다.\n전송 코드에 사용할 본인 장치 UID와 단말 키도 준비합니다. 단말 키는 소문자 16진수 64자이며 로그인 비밀번호·USIM 번호·일회용 등록 코드와 다릅니다. 키를 받지 못했다면 발급 자료를 요청하세요.\n등록 전에 서버로 보내면 409 응답이 발생합니다. 장치가 아직 없다면 [내 장치 데모](/devices?demo=1)에서 화면을 둘러볼 수 있습니다.',
        'Arduino IDE에서 Arduino AVR Boards와 Arduino Uno, 실제 연결 포트를 선택합니다. '+basic+'을 참고하세요.\n아래 첨부한 첫 서버 전송 ZIP을 풀고 config.example.h를 config.h로 복사합니다. SHIELD_APN·SHIELD_UID·SHIELD_KEY의 YOUR_*를 본인 값으로 바꿉니다. 1NCE APN은 iot.1nce.net입니다.\n최초 한 번은 ZIP에 포함된 01_connection 스케치를 올린 뒤 README의 HTTPS 인증서 설치 절차를 완료합니다. 이후 06_first_upload.ino를 업로드하세요. [설정·인증서·전송 상세 설명](/examples/shield-uno-first-upload)에 순서를 정리했습니다.\n115200 baud 시리얼 모니터에서 [HTTP] 200과 오류 여부를 확인합니다. 이 예제는 센서 없이 실제 LTE 상태만 보내며, 설정이 placeholder이면 [STOP]으로 중단됩니다.',
        original[3].split('본 사이트의 내 데이터')[0].strip()+'\n[내 장치](/devices)에서 해당 장치를 선택하고 마지막 수신 시각·LTE·최근 데이터를 확인합니다.\n첫 전송 코드는 온습도나 GPS 좌표를 보내지 않습니다. 센서 그래프와 지도에 값이 없어도 정상입니다. [DHT11 측정](/examples/shield-uno-dht11) 후 [온습도 서버 전송](/examples/shield-uno-upload)을 진행하면 [내 데이터](/data)에서 실제 센서 값을 볼 수 있습니다.\n[GNSS 확인](/examples/shield-uno-gnss)은 하늘이 보이는 곳에서 좌표를 시리얼로 읽는 별도 예제입니다. 이 예제 자체는 지도용 좌표를 서버에 보내지 않습니다.\n왼쪽 내 데이터 화면은 기능 안내를 위한 데모이며 첫 전송 예제의 실제 수신 결과가 아닙니다.',
        original[4].strip()+'\n[내 장치](/devices)의 USIM 및 사용 정보에서 잔량·상태·마지막 조회 시각을 확인합니다.\nUSIM 충전하기는 [내 장치](/devices)와 [요금 안내](/pricing) 양쪽에서 사용할 수 있습니다. 본인 장치와 판매 중인 상품을 선택하고 차감 포인트를 확인하세요.\n왼쪽 화면과 [내 장치 데모](/devices?demo=1)의 350 / 500 MB는 체험용 예시입니다. 데모에서는 결제나 실제 충전이 실행되지 않습니다.'
    ]
    start['images']=[{**p,'after_step':{2:3,3:2}.get(p['after_step'],p['after_step'])} for p in start['images']]+[demo]
    # The guide exposes the actual sketch/ZIP at the upload step; full source lives in its linked lesson.
    start['code']=''
    updated['start']=start
    def attachments(slug,at):
        return [{'id':a['sha256'],'title':a['title'],'after_step':at} for a in packaged[slug]['assets']]
    assets={}
    for slug,p in updated.items():
        target='shield-uno-first-upload' if slug=='start' else slug
        p['attachments']=attachments(target,3 if slug=='start' else 0)
        for a in packaged[target]['assets']:assets[a['sha256']]=a
    plan=[]
    for slug,p in updated.items():
        old=content(slug) if slug in public else None
        plan.append({'content':p,'revision':public[slug]['revision'] if old else 0,'before_sha256':digest(old) if old else None})
        assert all(len(s)<=2000 for s in p['steps']) and len(p['images'])<=20
    args.output.mkdir(parents=True,exist_ok=True)
    import shutil
    for a in assets.values():
        dest=args.output/a['path'];dest.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(EXAMPLES/'dist'/a['path'],dest)
    (args.output/'review-plan.json').write_text(json.dumps({'posts':plan,'assets':list(assets.values())},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'posts':len(plan),'attachments':len(assets),'output':str(args.output)}))

if __name__=='__main__':main()
