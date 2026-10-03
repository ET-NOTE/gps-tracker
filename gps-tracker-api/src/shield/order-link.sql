-- A provider order can settle at most one local request.
CREATE UNIQUE INDEX sim_requests_provider_order_idx
ON sim_requests(provider_order_id) WHERE provider_order_id IS NOT NULL;
