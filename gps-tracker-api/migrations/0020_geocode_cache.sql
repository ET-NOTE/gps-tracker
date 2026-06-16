-- 카카오 Local 역지오코딩 영구 캐시.
-- 같은 좌표(약 10m 그리드) 의 결과는 사실상 변하지 않으므로 30일 이상 재사용 가능.
-- AI 분석/법인 운행일지가 같은 도로/건물 좌표를 반복 조회 → 1회 호출 후 무한 hit.
--
-- 무료 한도 보호: 일 100k REST 호출 → 캐시 도입 시 캐시 hit 비율 90%+ 기대.
--
-- 좌표 양자화: lat_q = round(lat * 10000), lng_q = round(lng * 10000)
-- = 0.0001도 ≈ 한국 위도에서 약 11m 동서, 11m 남북. 같은 건물/같은 도로면 동일 셀.

CREATE TABLE IF NOT EXISTS geocode_cache (
    lat_q       INT  NOT NULL,
    lng_q       INT  NOT NULL,
    road        TEXT,
    jibun       TEXT,
    region      TEXT NOT NULL DEFAULT '',
    building    TEXT,
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (lat_q, lng_q)
);
CREATE INDEX IF NOT EXISTS idx_geocode_cache_age ON geocode_cache(fetched_at);
