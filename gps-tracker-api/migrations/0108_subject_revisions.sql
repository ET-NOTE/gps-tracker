-- 22D: declarations are replaced, never rewritten. Consent does not follow a SIM.
SET LOCAL lock_timeout='5s';
ALTER TABLE location_subject_mappings
 ADD COLUMN replaces_id bigint REFERENCES location_subject_mappings(id),
 ADD COLUMN replaces_revision bigint,
 ADD COLUMN change_kind text,
 ADD CONSTRAINT subject_revision_shape CHECK (
  (replaces_id IS NULL AND replaces_revision IS NULL AND change_kind IS NULL) OR
  (replaces_id IS NOT NULL AND replaces_id<id AND replaces_revision IS NOT NULL AND replaces_revision>=0 AND change_kind IS NOT NULL AND change_kind IN ('correction','reconsent'))),
 ADD CONSTRAINT subject_one_successor UNIQUE(replaces_id);
ALTER TABLE location_subject_mappings DROP CONSTRAINT location_subject_mappings_status_check;
ALTER TABLE location_subject_mappings ADD CONSTRAINT location_subject_mappings_status_check
 CHECK(status IN ('pending','confirmed','rejected','revoked','superseded'));
ALTER TABLE location_subject_actions DROP CONSTRAINT location_subject_actions_action_check;
ALTER TABLE location_subject_actions ADD CONSTRAINT location_subject_actions_action_check
 CHECK(action IN ('proposed','confirmed','rejected','revoked','superseded'));

-- A later withdrawal must invalidate even a previously confirmed replacement.
-- Only an explicit reconsent to that exact withdrawal revision can lift it.
CREATE VIEW location_subject_effective AS
 WITH RECURSIVE ancestry(child,parent,parent_revision,kind,subject_id) AS (
  SELECT id,replaces_id,replaces_revision,change_kind,subject_id
  FROM location_subject_mappings WHERE replaces_id IS NOT NULL
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

-- Runtime cannot silently change who/what/when was agreed to, including lineage.
CREATE FUNCTION protect_subject_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['status','revision','decided_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','revision','decided_at']) THEN
  RAISE EXCEPTION 'subject identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER subject_identity_immutable BEFORE UPDATE ON location_subject_mappings
 FOR EACH ROW EXECUTE FUNCTION protect_subject_identity();
