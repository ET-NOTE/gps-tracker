import { useEffect, useState } from 'react';
import { api } from '../api';

const messages = {
  delivery_paused: '통보 발송이 꺼져 있습니다.',
  provider_unconfigured: '푸시 발송 설정이 없습니다.',
  worker_stale: '처리 워커가 60초 이상 응답하지 않았습니다.',
  backlog_critical: '15분 이상 대기 중인 통보가 있습니다.',
  backlog_warning: '5분 이상 대기 중인 통보가 있습니다.',
  manual_review: '자동 재시도가 끝난 통보를 확인해 주세요.',
  lease_expired: '중단된 처리의 재시도를 기다리고 있습니다.',
  intent_unresolved: '제공 여부를 확정하지 못한 기록이 있습니다.',
  provider_cooldown: '발송 서비스 오류로 잠시 기다리고 있습니다.',
  failure_ratio: '최근 5분간 실패 비율이 높습니다.',
};
export default function NoticeQueuePanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true, loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const value = await api.adminNoticeQueue();
        if (alive) { setData(value); setError(''); }
      } catch (_) {
        if (alive) { setData(null); setError('통보 처리 상태를 불러오지 못했습니다. 다시 확인해 주세요.'); }
      } finally { loading = false; }
    }
    load();
    const timer = setInterval(load, 30000);
    return () => { alive = false; clearInterval(timer); };
  }, [refresh]);
  const on = data?.expected_running && data?.enabled && data?.push_enabled;
  return <section style={{ background: 'var(--surface,white)', border: '1px solid var(--border,#ddd)', borderRadius: 12, padding: 20, margin: '16px 0' }} aria-label="제공 통보 처리 상태">
    <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
      <h3 style={{ margin: 0 }}>제공 통보 처리 상태</h3>
      <button type="button" style={{ minHeight: 44, padding: "8px 12px", border: "1px solid var(--border,#ddd)", borderRadius: 8, background: "var(--surface,white)", color: "inherit", font: "inherit", cursor: "pointer" }} onClick={() => setRefresh(x => x + 1)}>상태 새로고침</button>
    </div>
    {error ? <p role="alert">{error}</p> : !data ? <p role="status">상태 확인 중…</p> : <>
      <p role="status" style={{ color: data.severity === 'critical' ? '#b42318' : 'inherit' }}>
        {!on ? '발송 꺼짐' : data.severity === 'ok' ? '정상 처리 중' : data.severity === 'critical' ? '조치 필요' : '확인할 항목 있음'}
        {' · '}{new Date(data.checked_at).toLocaleString('ko-KR')} 기준
      </p>
      <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 16, margin: '16px 0' }}>
        {[
          ['대기', data.pending], ['처리 중', data.inflight], ['검토 대기', data.review],
          ['최근 5분 발송 접수', data.accepted_5m], ['최근 5분 실패', data.failed_5m],
          ['가장 오래된 대기', `${Math.floor(data.oldest_pending_seconds / 60)}분`],
        ].map(([label, value]) => <div key={label}><dt style={{ color: 'var(--text-secondary,#667085)' }}>{label}</dt><dd style={{ margin: '4px 0 0', fontSize: 24, fontWeight: 700 }}>{value}</dd></div>)}
      </dl>
      {!!data.alerts.length && <ul style={{ paddingLeft: 20, margin: "16px 0" }}>{data.alerts.map(code => <li key={code}>{messages[code] || '통보 상태를 확인해 주세요.'}</li>)}</ul>}
      <p style={{ color: 'var(--text-secondary,#667085)', marginBottom: 0 }}>발송 접수는 푸시 서비스의 접수 결과이며, 휴대폰 도착·읽음 여부와 다릅니다. 상태는 30초마다 갱신됩니다.</p>
    </>}
  </section>;
}
