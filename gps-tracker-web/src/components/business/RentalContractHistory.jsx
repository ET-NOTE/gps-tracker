import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { authScope } from '../../authSession';
import { kstDateTime } from '../../lib/businessExport';
import { BusinessError } from './BusinessWorkspace';
import './rental-history.css';

export default function RentalContractHistory({ contractId }) {
  const history = useQuery({
    queryKey: ['rental-contract-history', authScope(), contractId],
    queryFn: () => api.rentalHistory(contractId),
    gcTime: 0,
    retry: false,
  });

  if (history.isPending) return <p role="status">처리 이력을 불러오는 중…</p>;
  if (history.error) return <BusinessError onRetry={history.refetch}>처리 이력을 불러오지 못했습니다.</BusinessError>;
  if (!history.data.length) return <p>등록된 처리 이력이 없습니다.</p>;
  return <ol className="rental-milestones" aria-label="계약 처리 이력">
    {history.data.map(event => <li key={event.id}>
      <span>{event.summary}</span>
      <time dateTime={event.occurred_at}>{kstDateTime(event.occurred_at)}</time>
    </li>)}
  </ol>;
}
