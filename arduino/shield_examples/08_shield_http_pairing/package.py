"""Package only this new HTTP lesson; never regenerate or replace examples 01-07."""
import argparse
import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    folder = ROOT.name
    names = [folder + '.ino', 'config.example.h', 'README.md', 'src/ShieldHttp.h',
             'src/ShieldHttp.cpp']
    files = {name: (ROOT / name).read_bytes().replace(b'\r\n', b'\n') for name in names}
    files['.gitignore'] = b'config.h\n'
    post = json.loads((ROOT / 'article.json').read_text(encoding='utf-8'))
    guide = '# ' + post['title'] + '\n\n' + post['description'] + '\n\n'
    for title, body in zip(post['step_titles'], post['steps']):
        guide += '## ' + title + '\n\n' + body + '\n\n'
    files['GUIDE.md'] = guide.encode('utf-8')
    for name, content in files.items():
        target = out / folder / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    archive = out / (folder + '.zip')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, content in sorted(files.items()):
            info = zipfile.ZipInfo(folder + '/' + name, (2026, 10, 6, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, content)
    assets = []
    for path, title in [(archive, '간편 HTTP 전체 ZIP · 이 파일로 시작'),
                        (out / folder / (folder + '.ino'), '스케치 코드 · src는 전체 ZIP에 포함'),
                        (out / folder / 'GUIDE.md', '단계별 따라 하기 안내')]:
        assets.append({'path': str(path.relative_to(out)).replace('\\', '/'), 'title': title,
                       'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    post.update(code=files[folder + '.ino'].decode(), images=[], attachments=[])
    (out / 'publication.json').write_text(json.dumps({'content': post, 'assets': assets}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'folder': str(out / folder), 'zip': str(archive), 'bytes': archive.stat().st_size}))


if __name__ == '__main__':
    main()
