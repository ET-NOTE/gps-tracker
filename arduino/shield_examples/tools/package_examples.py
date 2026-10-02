"""Build self-contained sketch ZIPs and publishable lesson JSON from reviewed sources only."""
import hashlib,json,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def build():
    dist=ROOT/'dist';dist.mkdir(exist_ok=True)
    posts=json.loads((ROOT/'articles.json').read_text(encoding='utf-8'))
    manifest=[]
    for item in posts:
        folder=item['folder'];files={}
        def add(path,relative):
            data=path.read_bytes().replace(b'\r\n',b'\n')
            files[f'{folder}/{relative}']=data
        add(ROOT/folder/(folder+'.ino'),folder+'.ino')
        if (ROOT/folder/'config.example.h').exists():add(ROOT/folder/'config.example.h','config.example.h')
        if folder!='02_dht11':
            for name in ['ShieldModem.h','ShieldModem.cpp','ShieldParsing.h']:add(ROOT/'common'/name,'src/'+name)
        for name in ['fetch_ca.py','install_ca.py']:add(ROOT/'tools'/name,'tools/'+name)
        add(ROOT/'README.md','README.md')
        if folder=='05_firebase':
            for name in ['README.md','firebase.json','firestore.rules','firestore.indexes.json',
                         'functions/package.json','functions/package-lock.json','functions/index.js',
                         'functions/handler.js','functions/test/handler.test.js']:
                add(ROOT/'firebase'/name,'firebase/'+name)
        files[f'{folder}/.gitignore']=b'config.h\n*.pem\n*.manifest.json\n**/node_modules/\n**/.secret*\n**/.env*\n**/.firebase/\n**/*-debug.log\n'
        article=item['content']
        guide='# '+article['title']+'\n\n'+article['description']+'\n\n'
        for title,text in zip(article['step_titles'],article['steps']):guide+='## '+title+'\n\n'+text+'\n\n'
        files[f'{folder}/GUIDE.md']=guide.encode('utf-8')
        for name,data in files.items():
            dest=dist/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data)
        zpath=dist/(folder+'.zip')
        with zipfile.ZipFile(zpath,'w',zipfile.ZIP_DEFLATED) as z:
            for name,data in sorted(files.items()):
                info=zipfile.ZipInfo(name,(2026,10,2,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;z.writestr(info,data)
        article['code']=(ROOT/folder/(folder+'.ino')).read_text(encoding='utf-8')
        article['attachments']=[];article['images']=[]
        assets=[(zpath,'전체 예제 ZIP · 압축 해제 후 .ino 열기'),
                (dist/folder/(folder+'.ino'),'스케치 코드 · src는 ZIP에 포함'),
                (dist/folder/'GUIDE.md','단계별 따라 하기 안내')]
        manifest.append({'content':article,'assets':[{'path':str(p.relative_to(dist)).replace('\\','/'),'title':t,
                           'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p,t in assets]})
    (dist/'publication.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'lessons':len(manifest),'output':str(dist),'zip_bytes':sum(p.stat().st_size for p in dist.glob('*.zip'))}))
if __name__=='__main__':build()
