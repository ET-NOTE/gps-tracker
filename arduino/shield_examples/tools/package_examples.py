"""Build all eight self-contained classroom ZIPs from reviewed sources."""
import argparse
import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUTO = {'04_shield_upload', '06_first_upload', '07_easy_https'}


def build(out=None, only=None):
    dist = Path(out or ROOT / 'dist').resolve()
    dist.mkdir(parents=True, exist_ok=True)
    posts = json.loads((ROOT / 'articles.json').read_text(encoding='utf-8'))
    posts.append(json.loads((ROOT / '06_first_upload/article.json').read_text(encoding='utf-8')))
    for folder in ['07_easy_https', '08_shield_http_pairing']:
        posts.append({'folder': folder, 'content': json.loads((ROOT / folder / 'article.json').read_text(encoding='utf-8'))})
    manifest = []
    for item in posts:
        folder = item['folder']
        if only and folder != only:
            continue
        files = {}
        def add(path, relative):
            files[relative] = path.read_bytes().replace(b'\r\n', b'\n')
        add(ROOT / folder / (folder + '.ino'), folder + '.ino')
        add(ROOT / 'README.md', 'README.md')
        if folder in AUTO:
            for path in sorted((ROOT / 'common/auto').iterdir()):
                add(path, 'HTTPS.md' if path.name == 'README.md' else 'src/' + path.name)
        elif folder == '08_shield_http_pairing':
            for path in sorted((ROOT / folder / 'src').iterdir()):
                add(path, 'src/' + path.name)
        elif folder != '02_dht11':
            for name in ['ShieldModem.h', 'ShieldModem.cpp', 'ShieldParsing.h']:
                add(ROOT / 'common' / name, 'src/' + name)
        if folder in ['01_connection', '05_firebase']:
            for name in ['fetch_ca.py', 'install_ca.py']:
                add(ROOT / 'tools' / name, 'tools/' + name)
        if folder == '05_firebase':
            add(ROOT / folder / 'config.example.h', 'config.example.h')
            add(ROOT / '01_connection/01_connection.ino', '01_connection/01_connection.ino')
            for name in ['ShieldModem.h', 'ShieldModem.cpp', 'ShieldParsing.h']:
                add(ROOT / 'common' / name, '01_connection/src/' + name)
            for name in ['README.md', 'firebase.json', 'firestore.rules', 'firestore.indexes.json',
                         'functions/package.json', 'functions/package-lock.json', 'functions/index.js',
                         'functions/handler.js', 'functions/test/handler.test.js']:
                add(ROOT / 'firebase' / name, 'firebase/' + name)
        files['.gitignore'] = b'config.h\n*.pem\n*.manifest.json\n**/node_modules/\n**/.secret*\n**/.env*\n**/.firebase/\n**/*-debug.log\n'
        article = item['content']
        guide = '# ' + article['title'] + '\n\n' + article['description'] + '\n\n'
        for title, body in zip(article['step_titles'], article['steps']):
            guide += '## ' + title + '\n\n' + body + '\n\n'
        files['GUIDE.md'] = guide.encode('utf-8')
        for name, data in files.items():
            dest = dist / folder / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        zpath = dist / (folder + '_v3.zip')
        with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED) as z:
            for name, data in sorted(files.items()):
                info = zipfile.ZipInfo(folder + '/' + name, (2026, 10, 6, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(info, data)
        gpath = dist / (folder + '_GUIDE_v3.md')
        gpath.write_bytes(files['GUIDE.md'])
        article['code'] = files[folder + '.ino'].decode('utf-8')
        article['attachments'] = []; article['images'] = []
        assets = [(zpath, 'v3 전체 예제 ZIP · 이 파일로 시작'),
                  (dist / folder / (folder + '.ino'), '스케치 코드 · src는 전체 ZIP에 포함'),
                  (gpath, 'v3 단계별 따라 하기 안내')]
        manifest.append({'folder': folder, 'content': article, 'assets': [
            {'path': path.relative_to(dist).as_posix(), 'title': title,
             'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path, title in assets]})
    (dist / 'publication.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'lessons': len(manifest), 'output': str(dist)}))
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--only')
    args = parser.parse_args()
    build(args.out, args.only)
