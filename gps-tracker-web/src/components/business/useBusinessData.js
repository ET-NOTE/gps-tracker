import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRentals, qk } from '../../state';
import { api } from '../../api';
import { businessPeriod } from '../../lib/business';

export function useBusinessClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  return now;
}
export function useRentalOperations(now) {
  const { from, to } = businessPeriod(now);
  return useRentals({ view: 'operations', from, to }, { refetchInterval: 60_000 });
}
export function useBusinessSubscription(kind) {
  return useQuery({ queryKey: qk.businessSubscription(kind), queryFn: () => kind === 'rentcar' ? api.getRentcarSubscription() : api.getCorporateSubscription() });
}
