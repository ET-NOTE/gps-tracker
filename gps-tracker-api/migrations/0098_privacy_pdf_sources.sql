-- Stored PDF receipts join the reviewed source scope. One page at a time is drawn by the isolated
-- renderer, so a read proof and a delivery name the page they refer to. Additive: earlier rows
-- stay NULL, and an image source never carries a page.
CREATE OR REPLACE FUNCTION privacy_receipt_in_scope(review bigint, receipt bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM privacy_company_reviews c
 JOIN fleet_expenses e ON e.owner_id=c.company_owner_id AND e.staff_id=c.staff_id
 JOIN fleet_expense_receipts f ON f.owner_id=e.owner_id AND f.expense_id=e.id
 WHERE c.id=review AND f.id=receipt AND c.identity='confirmed' AND c.staff_id IS NOT NULL
 AND c.category IN ('expenses','files') AND c.status NOT IN ('excluded','restricted')
 AND e.status<>'cancelled' AND f.removed_at IS NULL AND f.mime IN ('image/png','image/jpeg','application/pdf')
 AND e.spent_on>=(c.from_at AT TIME ZONE 'Asia/Seoul')::date
 AND e.spent_on<(c.until_at AT TIME ZONE 'Asia/Seoul')::date)
$$;
ALTER TABLE privacy_receipt_reads
 ADD COLUMN page INTEGER CHECK(page BETWEEN 1 AND 200);
ALTER TABLE privacy_image_deliveries
 ADD COLUMN source_page INTEGER CHECK(source_page IS NULL OR (source_page BETWEEN 1 AND 200 AND receipt_id IS NOT NULL));
