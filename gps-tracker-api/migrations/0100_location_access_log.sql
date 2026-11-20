-- 위치정보 이용·제공사실 확인자료(취급대장).
-- 누가 받았는지, 어떤 경로와 방법으로, 언제였는지만 남긴다. 위치정보 자체는 남기지 않는다:
-- 좌표, 주소, 응답 내용, 공유 링크 토큰은 이 표에 없다.
-- 같은 시간대(1시간)의 같은 대상·같은 받는 자·같은 방법은 한 행으로 모으고 횟수와 처음·마지막 시각을 남긴다.
-- 과거의 조회는 소급해 만들지 않는다. 기록기가 돌던 구간은 location_access_coverage 에 있다.
CREATE TABLE location_access_log (
 id BIGSERIAL PRIMARY KEY,
 bucket TIMESTAMPTZ NOT NULL,
 first_at TIMESTAMPTZ NOT NULL,
 last_at TIMESTAMPTZ NOT NULL,
 hits INTEGER NOT NULL CHECK (hits > 0),
 -- 대상: 정보주체 계정(단말기를 가진 계정). 전체 목록 조회는 all_subjects.
 subject_user_id BIGINT,
 all_subjects BOOLEAN NOT NULL DEFAULT false,
 device_id BIGINT,
 vehicle_id BIGINT,
 share_id BIGINT,
 -- 제공받는 자
 recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('self','company','admin','share_link','processor')),
 recipient_user_id BIGINT,
 recipient_name TEXT CHECK (recipient_name IS NULL OR recipient_name ~ '^[a-z0-9_]{1,32}$'),
 -- 취득경로와 이용·제공 방법
 path TEXT NOT NULL CHECK (path IN ('api','share_link','realtime','impersonation','server')),
 method TEXT NOT NULL CHECK (method IN ('position','track','trips','stats','events','analysis','file','geocode','push')),
 -- 요청한 자료의 기간(요청에 있을 때). 위치가 아니라 조회 범위다.
 range_from TIMESTAMPTZ,
 range_until TIMESTAMPTZ,
 bucket_key TEXT NOT NULL UNIQUE,
 CHECK (last_at >= first_at AND first_at >= bucket AND last_at < bucket + interval '1 hour'),
 CHECK ((recipient_kind IN ('self','company','admin')) = (recipient_user_id IS NOT NULL)),
 CHECK ((recipient_kind = 'processor') = (recipient_name IS NOT NULL)),
 CHECK (NOT all_subjects OR subject_user_id IS NULL)
);
CREATE INDEX location_access_log_subject ON location_access_log(subject_user_id, bucket);
CREATE INDEX location_access_log_bucket ON location_access_log(bucket);

-- 고칠 수 없다. 같은 시간대의 같은 사실이 반복될 때 횟수·마지막 시각·조회 범위만 늘어난다.
-- 지울 수 있는 것은 최소 보관 기간(위치정보의 관리적·기술적 보호조치 기준 제6조: 6개월)이 지난 행뿐이다.
CREATE FUNCTION location_access_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN
  IF ROW(NEW.id, NEW.bucket, NEW.first_at, NEW.subject_user_id, NEW.all_subjects, NEW.device_id, NEW.vehicle_id, NEW.share_id,
         NEW.recipient_kind, NEW.recipient_user_id, NEW.recipient_name, NEW.path, NEW.method, NEW.bucket_key)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.bucket, OLD.first_at, OLD.subject_user_id, OLD.all_subjects, OLD.device_id, OLD.vehicle_id, OLD.share_id,
         OLD.recipient_kind, OLD.recipient_user_id, OLD.recipient_name, OLD.path, OLD.method, OLD.bucket_key)
     OR NEW.hits < OLD.hits OR NEW.last_at < OLD.last_at
     OR (OLD.range_from IS NOT NULL AND (NEW.range_from IS NULL OR NEW.range_from > OLD.range_from))
     OR (OLD.range_until IS NOT NULL AND (NEW.range_until IS NULL OR NEW.range_until < OLD.range_until)) THEN
   RAISE EXCEPTION 'location access records cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.bucket > now() - interval '6 months' THEN
  RAISE EXCEPTION 'location access records are kept for at least six months' USING ERRCODE = '23514';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER location_access_log_guard BEFORE UPDATE OR DELETE ON location_access_log
 FOR EACH ROW EXECUTE FUNCTION location_access_log_guard();

-- 기록기가 돌던 구간. 한 번의 실행이 한 행이다.
-- started_at~alive_at 은 기록이 내려쓰인 구간이고, stopped_at 이 없으면 정상 종료가 아니어서
-- alive_at 뒤 몇 초의 조회는 빠졌을 수 있다. dropped 는 대기열이 가득 차 남기지 못한 건수다.
-- 이 표의 어느 행에도 들지 않는 시간의 조회는 기록되지 않았다.
CREATE TABLE location_access_coverage (
 id BIGSERIAL PRIMARY KEY,
 started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 alive_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 stopped_at TIMESTAMPTZ,
 release TEXT NOT NULL,
 scope_version INTEGER NOT NULL CHECK (scope_version > 0),
 dropped BIGINT NOT NULL DEFAULT 0 CHECK (dropped >= 0),
 CHECK (alive_at >= started_at AND (stopped_at IS NULL OR stopped_at >= alive_at))
);
CREATE FUNCTION location_access_coverage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN
  IF ROW(NEW.id, NEW.started_at, NEW.release, NEW.scope_version) IS DISTINCT FROM ROW(OLD.id, OLD.started_at, OLD.release, OLD.scope_version)
     OR NEW.alive_at < OLD.alive_at OR NEW.dropped < OLD.dropped OR OLD.stopped_at IS NOT NULL THEN
   RAISE EXCEPTION 'location access coverage cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.alive_at > now() - interval '6 months' THEN
  RAISE EXCEPTION 'location access coverage is kept for at least six months' USING ERRCODE = '23514';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER location_access_coverage_guard BEFORE UPDATE OR DELETE ON location_access_coverage
 FOR EACH ROW EXECUTE FUNCTION location_access_coverage_guard();

CREATE FUNCTION location_access_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'location access records cannot be emptied' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER location_access_log_truncate BEFORE TRUNCATE ON location_access_log
 FOR EACH STATEMENT EXECUTE FUNCTION location_access_no_truncate();
CREATE TRIGGER location_access_coverage_truncate BEFORE TRUNCATE ON location_access_coverage
 FOR EACH STATEMENT EXECUTE FUNCTION location_access_no_truncate();
