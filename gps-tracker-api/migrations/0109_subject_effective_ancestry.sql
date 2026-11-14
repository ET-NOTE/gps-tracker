-- Only confirmed candidates can be returned by the effective view. Seeding
-- ancestry for superseded/pending history makes work grow quadratically with
-- correction depth. Keep EVERY ancestor of a confirmed seed: revoked parents
-- and their exact reconsent revisions must still invalidate later descendants.
-- CREATE OR REPLACE preserves the view's identity, owner and runtime grants.
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE VIEW location_subject_effective AS
 WITH RECURSIVE ancestry(child,parent,parent_revision,kind,subject_id) AS (
  SELECT id,replaces_id,replaces_revision,change_kind,subject_id
  FROM location_subject_mappings WHERE replaces_id IS NOT NULL AND status='confirmed'
  UNION ALL
  SELECT a.child,m.replaces_id,m.replaces_revision,m.change_kind,m.subject_id
  FROM ancestry a JOIN location_subject_mappings m ON m.id=a.parent
  WHERE m.replaces_id IS NOT NULL
 )
 SELECT m.* FROM location_subject_mappings m
 WHERE m.status='confirmed'
 AND EXISTS(SELECT 1 FROM fleet_staff_accounts a JOIN staff s ON s.id=a.staff_id AND s.user_id=a.owner_id
   WHERE a.owner_id=m.owner_id AND a.staff_id=m.staff_id AND a.account_id=m.subject_id AND s.active)
 AND NOT EXISTS (
  SELECT 1 FROM location_subject_mappings r
  WHERE r.owner_id=m.owner_id AND r.device_id=m.device_id AND r.status='revoked'
    AND r.starts_at<m.ends_at AND r.ends_at>m.starts_at
    AND NOT EXISTS(SELECT 1 FROM ancestry a WHERE a.child=m.id AND a.parent=r.id
      AND a.kind='reconsent' AND a.parent_revision=r.revision
      AND a.subject_id=r.subject_id AND m.subject_id=r.subject_id)
 );
