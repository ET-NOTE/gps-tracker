import React, { useState } from 'react';
import { BusinessButton } from './BusinessWorkspace';
import { downloadReport } from '../../lib/downloadReport';

export default function ExportButtons({ report, disabled = false, pdfOnly = false }) {
  const [busy,setBusy] = useState(null), [error,setError] = useState('');
  async function run(format) {
    setBusy(format); setError('');
    try { await downloadReport(report,format); }
    catch(e) { setError(e.message || '파일을 생성하지 못했습니다. 다시 시도해 주세요.'); }
    finally { setBusy(null); }
  }
  return <div className="business-export no-print">
    {!pdfOnly && <BusinessButton icon="download" disabled={disabled || !!busy || !report} onClick={()=>run('csv')}>CSV 다운로드</BusinessButton>}
    <BusinessButton icon="download" disabled={disabled || !!busy || !report} onClick={()=>run('pdf')}>{busy==='pdf'?'PDF 생성 중…':'PDF 다운로드'}</BusinessButton>
    {error && <span role="alert" className="business-export-error">{error}</span>}
  </div>;
}
