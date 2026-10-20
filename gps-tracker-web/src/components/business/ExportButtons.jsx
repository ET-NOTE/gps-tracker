import React, { useState } from 'react';
import { BusinessButton } from './BusinessWorkspace';
import { downloadReport } from '../../lib/downloadReport';

export default function ExportButtons({ report, disabled = false, pdfOnly = false }) {
  const [busy,setBusy] = useState(null), [error,setError] = useState(''), [status,setStatus] = useState('');
  async function run(format) {
    setBusy(format); setError(''); setStatus('');
    try {
      const result = await downloadReport(report,format);
      setStatus(({saved:'파일을 저장했습니다.',share_opened:'공유할 앱을 선택해 주세요.',cancelled:'내보내기를 취소했습니다.',browser_started:'다운로드를 시작했습니다.'})[result?.status] || '');
    }
    catch(e) { setError(e.message || '파일을 생성하지 못했습니다. 다시 시도해 주세요.'); }
    finally { setBusy(null); }
  }
  return <div className="business-export no-print">
    {!pdfOnly && <BusinessButton icon="download" disabled={disabled || !!busy || !report} onClick={()=>run('csv')}>CSV 다운로드</BusinessButton>}
    <BusinessButton icon="download" disabled={disabled || !!busy || !report} onClick={()=>run('pdf')}>{busy==='pdf'?'PDF 생성 중…':'PDF 다운로드'}</BusinessButton>
    {status && <span role="status" style={{fontSize:12,color:'var(--text-2)'}}>{status}</span>}
    {error && <span role="alert" className="business-export-error">{error}</span>}
  </div>;
}
