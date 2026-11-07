"""Encrypted variants of the tiny two-page test document, printed as base64 for the integration test."""
import base64, pathlib, subprocess, sys, zlib
work = pathlib.Path(sys.argv[1]); work.mkdir(exist_ok=True)
def pdf(objects):
    data = b'%PDF-1.5\n'; offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(data)); data += f'{number} 0 obj\n{body}\nendobj\n'.encode()
    xref = len(data)
    data += f'xref\n0 {len(objects) + 1}\n0000000000 65535 f \n'.encode() + b''.join(f'{o:010} 00000 n \n'.encode() for o in offsets)
    return data + f'trailer\n<</Size {len(objects) + 1}/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF\n'.encode()
def stream(content): return f'<</Length {len(content)}>>\nstream\n{content}\nendstream'
base = pdf(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R 5 0 R]/Count 2>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R>>', stream('1 0 0 rg 0 0 100 100 re f'), '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]/Contents 6 0 R>>', stream('0 0 1 rg 60 60 90 90 re f')])
(work / 'base.pdf').write_bytes(base)
for name, arguments in [('user', ['user-secret', 'owner-secret', '256']), ('owner_only', ['', 'owner-secret', '256'])]:
    subprocess.run(['qpdf', '--encrypt', *arguments, '--', str(work / 'base.pdf'), str(work / f'{name}.pdf')], check=True)
    data = (work / f'{name}.pdf').read_bytes()
    print(name, len(data), base64.b64encode(zlib.compress(data, 9)).decode())
