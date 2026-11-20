"""Synthetic PDF corpus for evaluating the page renderer (build-host tools container only).

Adds to the pdfmake documents already in the directory: non-embedded fonts, rotated/cropped
pages, scans (JPEG and CCITT G4), encrypted files, damaged files and oversized/hostile files.
"""
import pathlib, subprocess, sys, zlib
from PIL import Image

out = pathlib.Path(sys.argv[1])


def pdf(objects, extra_trailer=''):
    data = b'%PDF-1.5\n%\xe2\xe3\xcf\xd3\n'
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(data))
        data += f'{number} 0 obj\n'.encode() + (body if isinstance(body, bytes) else body.encode()) + b'\nendobj\n'
    xref = len(data)
    data += f'xref\n0 {len(objects) + 1}\n0000000000 65535 f \n'.encode()
    data += b''.join(f'{offset:010} 00000 n \n'.encode() for offset in offsets)
    return data + f'trailer\n<</Size {len(objects) + 1}/Root 1 0 R{extra_trailer}>>\nstartxref\n{xref}\n%%EOF\n'.encode()


def stream(content, dictionary=''):
    content = content if isinstance(content, bytes) else content.encode()
    return f'<</Length {len(content)}{dictionary}>>\nstream\n'.encode() + content + b'\nendstream'


def save(name, data):
    (out / name).write_bytes(data)


def utf16(text):
    return '<' + text.encode('utf-16-be').hex().upper() + '>'


# Korean text in a CID font that is named but not embedded (common in older Korean documents).
lines = ['한글 미내장 글꼴 표본', '거래처: 모의주유소 강남점', '금액: 1,234,567원 (부가세 포함)', '가나다라마바사아자차카타파하 0123456789 ABC abc']
text = 'BT /F1 22 Tf 60 760 Td 30 TL ' + ' '.join(f'{utf16(line)} Tj T*' for line in lines) + ' ET'
save('korean-not-embedded.pdf', pdf([
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>',
    stream(text),
    '<</Type/Font/Subtype/Type0/BaseFont/Gulim/Encoding/UniKS-UTF16-H/DescendantFonts[6 0 R]>>',
    '<</Type/Font/Subtype/CIDFontType2/BaseFont/Gulim/CIDSystemInfo<</Registry(Adobe)/Ordering(Korea1)/Supplement 2>>/FontDescriptor 7 0 R/DW 1000>>',
    '<</Type/FontDescriptor/FontName/Gulim/Flags 4/FontBBox[0 -200 1000 900]/ItalicAngle 0/Ascent 880/Descent -120/CapHeight 700/StemV 80>>',
]))

# Standard 14 fonts, a rotated page with a crop box, and vector drawing.
latin = 'BT /F1 18 Tf 60 720 Td (Standard fonts: Helvetica 18pt - The quick brown fox 0123456789) Tj ET BT /F2 12 Tf 60 690 Td (Times-Roman 12pt: receipts, tables and totals 1,234.56) Tj ET BT /F3 9 Tf 60 670 Td (Courier 9pt: INV-2026-0001  QTY 12  AMOUNT 345.00) Tj ET 0.2 0.4 0.9 rg 60 560 200 80 re f 0.7 0.1 0.1 RG 2 w 300 560 200 80 re S 0 0 0 RG 0.5 w 60 540 m 500 540 l S'
fonts = '<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>/F2<</Type/Font/Subtype/Type1/BaseFont/Times-Roman>>/F3<</Type/Font/Subtype/Type1/BaseFont/Courier>>>>>>'
save('latin-standard-fonts.pdf', pdf(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', f'<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources{fonts}/Contents 4 0 R>>', stream(latin)]))
save('rotated-cropped.pdf', pdf(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', f'<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/CropBox[40 500 560 780]/Rotate 90/Resources{fonts}/Contents 4 0 R>>', stream(latin)]))

# Scans: the Korean receipt rasterized by the reference renderer, then stored as an image-only page.
subprocess.run(['pdftoppm', '-r', '150', '-f', '1', '-l', '1', '-png', str(out / 'korean-receipt.pdf'), str(out / 'scan-source')], check=True)
source = next(out.glob('scan-source*.png'))
image = Image.open(source).convert('RGB').rotate(1.2, expand=False, fillcolor='white')
jpeg = out / 'scan.jpg'
image.save(jpeg, quality=70)
w, h = image.size
page = f'<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</XObject<</Im1 5 0 R>>>>/Contents 4 0 R>>'
save('scan-jpeg.pdf', pdf(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', page, stream('q 595 0 0 842 0 0 cm /Im1 Do Q'),
                           stream(jpeg.read_bytes(), f'/Type/XObject/Subtype/Image/Width {w}/Height {h}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode')]))
gray = image.convert('L')
save('scan-gray-flate.pdf', pdf(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', page, stream('q 595 0 0 842 0 0 cm /Im1 Do Q'),
                                 stream(zlib.compress(gray.tobytes()), f'/Type/XObject/Subtype/Image/Width {w}/Height {h}/ColorSpace/DeviceGray/BitsPerComponent 8/Filter/FlateDecode')]))
tiff = out / 'scan-g4.tif'
gray.point(lambda v: 255 if v > 160 else 0).convert('1').save(tiff, compression='group4', dpi=(150, 150))
subprocess.run(['tiff2pdf', '-o', str(out / 'scan-ccitt-g4.pdf'), str(tiff)], check=True)
for leftover in (source, jpeg, tiff):
    leftover.unlink()

# Encrypted: user password, owner password only (opens with an empty password), legacy RC4.
for name, arguments in [('encrypted-user-aes256.pdf', ['user-secret', 'owner-secret', '256']), ('encrypted-owner-only-aes256.pdf', ['', 'owner-secret', '256']), ('encrypted-user-rc4.pdf', ['user-secret', 'owner-secret', '128'])]:
    subprocess.run(['qpdf', '--allow-weak-crypto', '--encrypt', *arguments, '--', str(out / 'korean-receipt.pdf'), str(out / name)], check=True)

# Damaged.
good = (out / 'korean-receipt.pdf').read_bytes()
save('damaged-truncated.pdf', good[:len(good) // 2])
save('damaged-header-only.pdf', b'%PDF-1.7\n%%EOF\n')
save('damaged-garbage.pdf', b'%PDF-1.7\n' + bytes(range(256)) * 200)
save('damaged-no-pages.pdf', pdf(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[]/Count 0>>']))
save('damaged-xref-repairable.pdf', good.replace(b'startxref', b'startxrex'))

# Oversized or hostile.
kids = ' '.join(f'{3 + i} 0 R' for i in range(201))
save('oversized-201-pages.pdf', pdf(['<</Type/Catalog/Pages 2 0 R>>', f'<</Type/Pages/Kids[{kids}]/Count 201>>'] + ['<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>'] * 201))
kids = ' '.join(f'{3 + i} 0 R' for i in range(200))
save('limit-200-pages.pdf', pdf(['<</Type/Catalog/Pages 2 0 R>>', f'<</Type/Pages/Kids[{kids}]/Count 200>>'] + ['<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>'] * 200))
save('oversized-page.pdf', pdf(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 20000 20000]>>']))
side = 30000  # 900 megapixels of zeros behind a tiny compressed stream
bomb = zlib.compress(bytes(side * side // 8), 9)
save('hostile-image-bomb.pdf', pdf(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</XObject<</Im1 5 0 R>>>>/Contents 4 0 R>>', stream('q 595 0 0 842 0 0 cm /Im1 Do Q'),
                                    stream(bomb, f'/Type/XObject/Subtype/Image/Width {side}/Height {side}/ColorSpace/DeviceGray/BitsPerComponent 1/Filter/FlateDecode')]))
save('hostile-recursive-form.pdf', pdf(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</XObject<</Fm1 5 0 R>>>>/Contents 4 0 R>>', stream('/Fm1 Do'),
                                        stream('0 0 1 rg 0 0 10 10 re f /Fm1 Do', '/Type/XObject/Subtype/Form/BBox[0 0 595 842]/Resources<</XObject<</Fm1 5 0 R>>>>')]))
loop = 'q ' + '0.5 0 0 0.5 1 1 cm 0 0 1 rg 0 0 500 500 re f ' * 200000 + 'Q'
save('hostile-long-content.pdf', pdf(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R>>', stream(zlib.compress(loop.encode(), 9), '/Filter/FlateDecode')]))
print('\n'.join(f'{p.name} {p.stat().st_size}' for p in sorted(out.glob('*.pdf'))))
