// Synthetic Korean documents with embedded fonts (pdfmake + NanumGothic), for renderer evaluation.
const fs = require('fs');
const path = require('path');
const [web, out] = process.argv.slice(2).map(p => path.resolve(p));
const PdfPrinter = require(path.join(web, 'node_modules/pdfmake'));
const font = n => path.join(web, 'src/assets/fonts', n);
const printer = new PdfPrinter({ NanumGothic: { normal: font('NanumGothic-Regular.ttf'), bold: font('NanumGothic-Bold.ttf'), italics: font('NanumGothic-Regular.ttf'), bolditalics: font('NanumGothic-Bold.ttf') } });
function write(name, definition) {
  return new Promise(resolve => {
    const doc = printer.createPdfKitDocument({ defaultStyle: { font: 'NanumGothic', fontSize: 10 }, ...definition });
    const stream = fs.createWriteStream(path.join(out, name));
    doc.pipe(stream); doc.end(); stream.on('finish', resolve);
  });
}
const won = n => n.toLocaleString('ko-KR') + '원';
const rows = Array.from({ length: 12 }, (_, i) => [String(i + 1), ['휘발유', '경유', '세차', '주차', '통행료', '엔진오일'][i % 6], `${20 + i}.5 L`, won(1689 + i * 7), won((20 + i) * 1689)]);
(async () => {
  fs.mkdirSync(out, { recursive: true });
  await write('korean-receipt.pdf', {
    pageSize: 'A4', pageMargins: [50, 50, 50, 50],
    content: [
      { text: '주유 영수증 (합성 표본)', fontSize: 20, bold: true, alignment: 'center', margin: [0, 0, 0, 12] },
      { columns: [{ text: '상호: 모의주유소 강남점\n사업자번호: 000-00-00000\n대표: 홍길동', lineHeight: 1.3 }, { text: '거래일시: 2026-01-01 09:12:33\n승인번호: 12345678\n카드: 9999-****-****-0000', alignment: 'right', lineHeight: 1.3 }] },
      { text: ' ' },
      { table: { headerRows: 1, widths: [30, '*', 70, 80, 90], body: [[{ text: '번호', bold: true }, { text: '품목', bold: true }, { text: '수량', bold: true }, { text: '단가', bold: true }, { text: '금액', bold: true }], ...rows.map(r => r.map((c, i) => ({ text: c, alignment: i >= 2 ? 'right' : 'left' })))] } },
      { text: `합계 ${won(rows.reduce((s, r, i) => s + (20 + i) * 1689, 0))}`, bold: true, fontSize: 14, alignment: 'right', margin: [0, 10, 0, 0] },
      { text: '작은 글씨 6pt: 본 영수증은 화면 검수용 합성 자료이며 실제 거래가 아닙니다. 가나다라마바사아자차카타파하 0123456789', fontSize: 6, margin: [0, 16, 0, 0] },
      { text: '작은 글씨 8pt: 부가세 포함 · 현금영수증 발행 · 문의 02-000-0000 · 한글 표 렌더링 확인', fontSize: 8 },
      { canvas: [{ type: 'rect', x: 0, y: 12, w: 120, h: 40, color: '#1465f4' }, { type: 'ellipse', x: 200, y: 32, r1: 40, r2: 20, lineColor: '#b12828', lineWidth: 2 }, { type: 'line', x1: 280, y1: 12, x2: 480, y2: 52, lineWidth: 0.5 }] },
    ],
  });
  await write('korean-statement.pdf', {
    pageSize: 'A4', pageOrientation: 'landscape', pageMargins: [30, 30, 30, 30],
    header: (page, pages) => ({ text: `지출 명세서 ${page}/${pages}`, alignment: 'right', margin: [0, 10, 30, 0], fontSize: 8 }),
    content: [
      { text: '월간 지출 명세서 (합성 표본)', fontSize: 16, bold: true, margin: [0, 0, 0, 8] },
      { table: { headerRows: 1, widths: [60, 70, '*', 60, 80, 80], body: [['일자', '분류', '내용', '담당', '공급가액', '합계'].map(t => ({ text: t, bold: true, fillColor: '#e8eefc' })), ...Array.from({ length: 95 }, (_, i) => [`2026-01-${String(1 + i % 28).padStart(2, '0')}`, ['유류비', '정비', '보험', '통행료'][i % 4], `모의 거래처 ${i + 1}호점 · 차량 ${10 + i % 7}가 ${1000 + i}`, ['김담당', '이담당', '박담당'][i % 3], { text: won(10000 + i * 137), alignment: 'right' }, { text: won(11000 + i * 151), alignment: 'right' }])] }, layout: 'lightHorizontalLines' },
    ],
  });
  console.log(fs.readdirSync(out).map(f => `${f} ${fs.statSync(path.join(out, f)).size}`).join('\n'));
})();
