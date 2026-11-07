from pathlib import Path
from pypdf import PdfReader
import json
root = Path(__file__).resolve().parent
reader = PdfReader(root / "revoked-export.pdf")
text = "\n".join(page.extract_text() for page in reader.pages)
assert "검증 출발지" not in text and "시험 운전자" not in text
assert "정보주체" in text
report = json.loads((root / "ui-verification.json").read_text(encoding="utf-8"))
report.update(pdfExcludedOldTrip=True, pdfScopeNotePresent=True, pdfPages=len(reader.pages))
(root / "ui-verification.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("PDF: excluded old trip; scope notice retained")
