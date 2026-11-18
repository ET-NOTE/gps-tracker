// Local visual-preview assets only. Nothing here is imported by the production app.
async function receiptImage(expense, copy = 0) {
  const canvas = document.createElement('canvas');
  canvas.width = 440;
  canvas.height = 640;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw Error('미리보기 영수증을 생성할 수 없습니다.');

  ctx.fillStyle = copy ? '#ece9df' : '#f5f2e9';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#252a31';
  ctx.textAlign = 'center';
  ctx.font = 'bold 27px sans-serif';
  ctx.fillText('미리보기 영수증', 220, 65);
  ctx.font = '16px sans-serif';
  ctx.fillText(copy ? '추가 첨부 샘플' : '시리얼링크 테스트 매장', 220, 97);
  ctx.font = '13px sans-serif';
  ctx.fillText('등록번호 000-00-00000', 220, 124);

  const rule = y => {
    ctx.strokeStyle = '#aaa79e';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(35, y); ctx.lineTo(405, y); ctx.stroke();
    ctx.setLineDash([]);
  };
  const line = (label, value, y, bold = false) => {
    ctx.fillStyle = '#34383e';
    ctx.font = `${bold ? 'bold ' : ''}17px sans-serif`;
    ctx.textAlign = 'left'; ctx.fillText(label, 38, y);
    ctx.textAlign = 'right'; ctx.fillText(value, 402, y);
  };

  rule(149);
  line('거래일자', expense.spent_on, 180);
  line('사용자', expense.staff_name, 214);
  line('지출 항목', expense.category_name, 248);
  rule(274);
  const amount = Number(expense.amount_krw).toLocaleString('ko-KR');
  line('결제 금액', `${amount} 원`, 318, true);
  line('결제 수단', expense.payment_method === 'personal_card' ? '개인카드' : '법인카드', 359);
  line('카드 번호', '0000-****-****-0000', 393);
  rule(424);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#8b3c3c';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText('샘플 · 실제 증빙 아님', 220, 470);
  ctx.fillStyle = '#62635d';
  ctx.font = '14px sans-serif';
  ctx.fillText('화면 미리보기를 위해 생성한 이미지입니다.', 220, 500);
  ctx.fillText(`SAMPLE-${String(expense.id).padStart(4, '0')}-${copy + 1}`, 220, 536);
  // A decorative barcode made solely from sample identifiers.
  ctx.fillStyle = '#55564f';
  for (let x = 94, i = 0; x < 346; i += 1) {
    const width = 1 + ((i + expense.id + copy) % 3);
    ctx.fillRect(x, 558, width, 35);
    x += width + 2 + (i % 2);
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(Error('미리보기 영수증 이미지 생성 실패')), 'image/png');
  });
}

export function sampleReceiptPdf() {
  // Small valid, downloadable PDF for exercising the non-image attachment state.
  // ASCII keeps the byte offsets exact without requiring an embedded font.
  const content = 'BT /F1 20 Tf 56 750 Td (PREVIEW RECEIPT) Tj 0 -36 Td /F1 12 Tf (Sample only - not a valid receipt.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([pdf], { type: 'application/pdf' });
}

export async function createPreviewExpenseReceipts(expenses) {
  const result = new Map();
  await Promise.all(expenses.filter(expense => expense.id <= 7).map(async expense => {
    const pdfOnly = expense.id === 7;
    const files = pdfOnly ? [sampleReceiptPdf()] : [await receiptImage(expense)];
    if (expense.id === 2) files.push(await receiptImage(expense, 1));
    result.set(expense.id, files.map((file, index) => ({
      id: expense.id * 100 + index + 1,
      expense_id: expense.id,
      filename: `미리보기_영수증_${expense.id}_${index + 1}.${file.type === 'application/pdf' ? 'pdf' : 'png'}`,
      mime: file.type,
      size_bytes: file.size,
      created_at: expense.created_at,
      file,
    })));
  }));
  return result;
}
