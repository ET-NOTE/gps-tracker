import React, { useState } from 'react';
import { BusinessButton } from './BusinessWorkspace';
import { downloadReport } from '../../lib/downloadReport';
import { Modal } from '../ui';

export default function ExportButtons({ report, csvReport, pdfReport, csvLabel = 'CSV 다운로드', disabled = false, pdfOnly = false }) {
  const [busy,setBusy] = useState(null), [error,setError] = useState(''), [status,setStatus] = useState('');
  const [review,setReview] = useState(null);
  async function run(format, selected = format === 'csv' ? csvReport || report : pdfReport || report) {
    setReview(null);
    setBusy(format); setError(''); setStatus('');
    try {
      const result = await downloadReport(selected,format);
      setStatus(({saved:'파일을 저장했습니다.',share_opened:'공유할 앱을 선택해 주세요.',cancelled:'내보내기를 취소했습니다.',browser_started:'다운로드를 시작했습니다.'})[result?.status] || '');
    }
    catch(e) { setError(e.message || '파일을 생성하지 못했습니다. 다시 시도해 주세요.'); }
    finally { setBusy(null); }
  }
  return <div className="business-export no-print">
    {!pdfOnly && <BusinessButton icon="download" disabled={disabled || !!busy || !(csvReport || report)} onClick={()=>{ const selected = csvReport || report; selected.warnings?.length ? setReview({report:selected,format:'csv'}) : run('csv',selected); }}>{csvLabel}</BusinessButton>}
    <BusinessButton icon="download" disabled={disabled || !!busy || !report} onClick={()=>{const selected=pdfReport||report;selected.warnings?.length?setReview({report:selected,format:'pdf'}):run('pdf',selected);}}>{busy==='pdf'?'PDF 생성 중…':'PDF 다운로드'}</BusinessButton>
    {status && <span role="status" style={{fontSize:12,color:'var(--text-2)'}}>{status}</span>}
    {error && <span role="alert" className="business-export-error">{error}</span>}
    {review && <Modal open title="운행기록부 다운로드" onClose={()=>setReview(null)}><div className="business-export-review"><p>{review.report.summary}</p><ul>{review.report.warnings.map(w=><li key={w}>{w}</li>)}</ul><p>{review.format==='csv'?'국세청 서식의 항목 순서로 CSV를 만듭니다. 빈 항목은 내려받은 파일에서 보완할 수 있습니다.':'국세청 서식 항목을 담은 인쇄용 PDF입니다. 미입력 항목을 확인해 주세요.'}</p><div className="business-export-review-actions"><BusinessButton onClick={()=>setReview(null)}>돌아가기</BusinessButton><BusinessButton primary onClick={()=>run(review.format,review.report)}>빈 항목을 포함해 다운로드</BusinessButton></div></div></Modal>}
  </div>;
}
