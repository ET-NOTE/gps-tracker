-- Page selection must not expand a whole month before applying LIMIT. Keep each
-- sample timestamp in exactly one window, with all overlapping transmissions
-- still visible to the existing duplicate/source precedence rules. STABLE keeps
-- every window in the caller's snapshot; no persistent plaintext cache is used.
CREATE FUNCTION location_page_sample_keys(
 wanted_device bigint, wanted_user bigint, from_time timestamptz, to_time timestamptz,
 wanted_source text, wanted_fix boolean, before_time timestamptz, before_source text,
 wanted_count integer)
RETURNS TABLE(recorded_at timestamptz, source text)
LANGUAGE plpgsql STABLE PARALLEL RESTRICTED
SET search_path=pg_catalog,public AS $$
DECLARE
 upper_time timestamptz;
 lower_time timestamptz;
 span interval := interval '6 hours';
 first_window boolean := true;
 remaining integer := wanted_count;
 emitted integer;
 latest_time timestamptz;
BEGIN
 IF from_time IS NULL OR to_time IS NULL OR NOT isfinite(from_time) OR NOT isfinite(to_time)
    OR to_time<=from_time OR to_time-from_time>interval '31 days'
    OR wanted_count IS NULL OR wanted_count<1 OR wanted_count>5001
    OR (before_time IS NOT NULL AND (NOT isfinite(before_time) OR before_source IS NULL)) THEN
  RAISE EXCEPTION 'invalid location page bounds' USING ERRCODE='22023';
 END IF;
 -- Skip the empty tail of offline periods using110's authenticated time index.
 latest_time := location_latest_sample_at(wanted_device,wanted_user);
 IF latest_time IS NULL THEN RETURN; END IF;
 upper_time := LEAST(to_time,COALESCE(before_time,to_time),latest_time);
 IF upper_time<from_time THEN RETURN; END IF;
 LOOP
  lower_time := GREATEST(from_time,upper_time-span);
  RETURN QUERY
   SELECT k.recorded_at,k.source
   FROM location_sample_keys_between(wanted_device,wanted_user,lower_time,upper_time) k
   WHERE k.recorded_at<to_time
    AND (first_window OR k.recorded_at<upper_time)
    AND (wanted_source IS NULL OR k.source=wanted_source)
    AND (wanted_fix IS NULL OR k.fix=wanted_fix)
    AND (before_time IS NULL OR (k.recorded_at,k.source)<(before_time,before_source))
   ORDER BY k.recorded_at DESC,k.source DESC LIMIT remaining;
  GET DIAGNOSTICS emitted=ROW_COUNT;
  remaining := remaining-emitted;
  EXIT WHEN remaining=0 OR lower_time=from_time;
  upper_time := lower_time;
  first_window := false;
  -- Sparse/offline periods need few probes; dense periods stop after one window.
  span := LEAST(span*2,interval '7 days');
 END LOOP;
END $$;
