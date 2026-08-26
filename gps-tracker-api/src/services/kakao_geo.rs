// 카카오 Local API — coord2address 래퍼.
// AI 분석 / 법인 운행일지 등에서 좌표를 도로명/지번/건물명으로 해석.
//
// 환경변수 KAKAO_REST_API_KEY 필요.
// 무료 한도: 일 100,000건, 초당 10회 → DB 영구 캐시로 보호.
//
// 캐시 동작:
//   - 좌표를 0.0001도 그리드로 양자화 (≈11m). 같은 셀 → 동일 row.
//   - 30일 이상 된 row 는 stale 로 보고 재조회.
//   - reverse_many_cached 가 우선 캐시 일괄 조회 후, miss 만 Kakao API 호출.

use futures_util::StreamExt;
use reqwest::Client;
use serde::Deserialize;
use sqlx::{FromRow, PgPool};
use std::time::Duration;

const CACHE_TTL_DAYS: i64 = 30;
const QUANT: f64 = 10000.0;   // 4 decimal places
// [2026-08-14] Kakao 초당 10회 제한 대응 — 무제한 join_all 대신 동시성 상한. 대량 좌표(운행일지/AI)
//   전달 시 429 폭주 + 미적재 재호출 반복을 방지.
const KAKAO_MAX_CONCURRENCY: usize = 8;

fn quantize(lat: f64, lng: f64) -> (i32, i32) {
    ((lat * QUANT).round() as i32, (lng * QUANT).round() as i32)
}

const URL: &str = "https://dapi.kakao.com/v2/local/geo/coord2address.json";

#[derive(Debug, Deserialize)]
struct Resp {
    documents: Vec<Doc>,
}
#[derive(Debug, Deserialize)]
struct Doc {
    address:      Option<Addr>,
    road_address: Option<RoadAddr>,
}
#[derive(Debug, Deserialize)]
struct Addr {
    address_name:       Option<String>,
    region_1depth_name: Option<String>,
    region_2depth_name: Option<String>,
    region_3depth_name: Option<String>,
}
#[derive(Debug, Deserialize)]
struct RoadAddr {
    address_name:  Option<String>,
    building_name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Resolved {
    pub road:     Option<String>,   // "전북 익산시 익산대로 123"
    pub jibun:    Option<String>,   // "전북 익산시 영등동 234-1"
    pub region:   String,           // "전북 익산시 영등동" (간결형)
    pub building: Option<String>,   // "익산터미널"
}

impl Resolved {
    /// 프롬프트에 한 줄로 넣을 수 있는 짧은 표현.
    /// 우선순위: 도로명+건물 > 도로명 > 지번 > 행정구역.
    pub fn short(&self) -> String {
        if let Some(road) = &self.road {
            if let Some(b) = &self.building {
                return format!("{road} ({b})");
            }
            return road.clone();
        }
        if let Some(j) = &self.jibun { return j.clone(); }
        self.region.clone()
    }
}

/// 환경변수 + 좌표 → 주소.
pub async fn reverse(lat: f64, lng: f64) -> anyhow::Result<Resolved> {
    let key = std::env::var("KAKAO_REST_API_KEY")
        .ok().filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("KAKAO_REST_API_KEY not configured"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .build()?;
    reverse_with(&client, &key, lat, lng).await
}

pub async fn reverse_with(client: &Client, key: &str, lat: f64, lng: f64) -> anyhow::Result<Resolved> {
    let url = format!("{URL}?x={lng}&y={lat}");
    let resp: Resp = client.get(&url)
        .header("Authorization", format!("KakaoAK {key}"))
        .send().await?
        .error_for_status()?
        .json().await?;
    let doc = resp.documents.into_iter().next()
        .ok_or_else(|| anyhow::anyhow!("no address"))?;

    let road     = doc.road_address.as_ref().and_then(|r| r.address_name.clone());
    let building = doc.road_address.as_ref().and_then(|r| r.building_name.clone())
        .filter(|s| !s.is_empty());
    let jibun    = doc.address.as_ref().and_then(|a| a.address_name.clone());
    let region = doc.address.as_ref().map(|a| {
        let parts = [
            a.region_1depth_name.as_deref().unwrap_or(""),
            a.region_2depth_name.as_deref().unwrap_or(""),
            a.region_3depth_name.as_deref().unwrap_or(""),
        ];
        parts.iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(" ")
    }).unwrap_or_default();

    Ok(Resolved { road, jibun, region, building })
}

/// 여러 좌표를 동시에 해석 (캐시 미사용 — 호환성용).
/// 신규 코드는 reverse_many_cached 사용 권장.
pub async fn reverse_many(coords: &[(f64, f64)]) -> Vec<Option<Resolved>> {
    let key = match std::env::var("KAKAO_REST_API_KEY").ok().filter(|s| !s.is_empty()) {
        Some(k) => k,
        None => return coords.iter().map(|_| None).collect(),
    };
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(6)).build() {
        Ok(c) => c,
        Err(_) => return coords.iter().map(|_| None).collect(),
    };
    // buffered = 동시성 상한 + 순서 보존 (반환 Vec 이 coords 순서와 일치해야 함).
    //   ※ owned Vec 로 미리 복사 — coords(빌림)를 stream await 너머로 넘기면 handler future 가
    //     non-Send 가 됨(Send is not general enough). into_iter 로 소유 이동.
    let owned: Vec<(f64, f64)> = coords.to_vec();
    futures_util::stream::iter(owned.into_iter().map(|(lat, lng)| {
        let c = client.clone();
        let k = key.clone();
        async move { reverse_with(&c, &k, lat, lng).await.ok() }
    }))
    .buffered(KAKAO_MAX_CONCURRENCY)
    .collect()
    .await
}

#[derive(Debug, FromRow)]
struct CacheRow {
    road:     Option<String>,
    jibun:    Option<String>,
    region:   String,
    building: Option<String>,
}

impl CacheRow {
    fn into_resolved(self) -> Resolved {
        Resolved { road: self.road, jibun: self.jibun, region: self.region, building: self.building }
    }
}

/// DB 캐시를 사용하는 일괄 역지오코딩.
/// 동작:
///   1) 좌표를 양자화 (0.0001도 그리드)
///   2) 같은 셀에 떨어지는 좌표는 한 번만 조회
///   3) 캐시 일괄 조회 → 30일 이내 row 는 즉시 반환
///   4) miss 만 Kakao API 호출 → 결과를 캐시에 upsert
///   5) 원본 coords 순서로 결과 반환
pub async fn reverse_many_cached(db: &PgPool, coords: &[(f64, f64)]) -> Vec<Option<Resolved>> {
    if coords.is_empty() { return vec![]; }

    // 1) 양자화 + 중복 제거. (양자화 셀 → 원본 인덱스 리스트)
    let mut cell_to_indices: std::collections::HashMap<(i32, i32), Vec<usize>> = Default::default();
    for (i, &(lat, lng)) in coords.iter().enumerate() {
        let cell = quantize(lat, lng);
        cell_to_indices.entry(cell).or_default().push(i);
    }
    let unique_cells: Vec<(i32, i32)> = cell_to_indices.keys().copied().collect();

    // 2) 캐시 일괄 조회 (UNNEST)
    let lat_qs: Vec<i32> = unique_cells.iter().map(|c| c.0).collect();
    let lng_qs: Vec<i32> = unique_cells.iter().map(|c| c.1).collect();
    let cached: Vec<(i32, i32, Option<String>, Option<String>, String, Option<String>)> =
        sqlx::query_as(
            r#"SELECT lat_q, lng_q, road, jibun, region, building
                 FROM geocode_cache
                WHERE (lat_q, lng_q) IN (
                  SELECT * FROM UNNEST($1::INT[], $2::INT[])
                )
                  AND fetched_at > NOW() - ($3 || ' days')::interval"#,
        )
        .bind(&lat_qs).bind(&lng_qs).bind(CACHE_TTL_DAYS.to_string())
        .fetch_all(db).await.unwrap_or_default();

    let mut hit_map: std::collections::HashMap<(i32, i32), Resolved> = Default::default();
    for (lat_q, lng_q, road, jibun, region, building) in cached {
        hit_map.insert(
            (lat_q, lng_q),
            CacheRow { road, jibun, region, building }.into_resolved(),
        );
    }

    // 3) miss 셀 — 실제 좌표 (가장 빠른 인덱스의 lat/lng) 로 Kakao 호출
    let miss_cells: Vec<(i32, i32)> = unique_cells.iter()
        .filter(|c| !hit_map.contains_key(c))
        .copied().collect();

    if !miss_cells.is_empty() {
        let key = std::env::var("KAKAO_REST_API_KEY").ok().filter(|s| !s.is_empty());
        if let Some(key) = key {
            if let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(6)).build() {
                // 각 miss 셀의 첫 좌표로 한 번만 호출
                // owned 로 미리 materialize — coords/cell_to_indices(빌림)를 stream await 너머로
                //   넘기면 handler future non-Send. (cell, lat, lng) 소유 튜플로 복사 후 into_iter.
                let miss_inputs: Vec<((i32, i32), f64, f64)> = miss_cells.iter().map(|cell| {
                    let idx = cell_to_indices[cell][0];
                    let (lat, lng) = coords[idx];
                    (*cell, lat, lng)
                }).collect();
                let results: Vec<((i32, i32), Option<Resolved>)> =
                    futures_util::stream::iter(miss_inputs.into_iter().map(|(cell, lat, lng)| {
                        let c = client.clone();
                        let k = key.clone();
                        async move {
                            let r = reverse_with(&c, &k, lat, lng).await.ok();
                            (cell, r)
                        }
                    }))
                    .buffer_unordered(KAKAO_MAX_CONCURRENCY)   // 순서 무관(맵에 삽입) → unordered
                    .collect()
                    .await;
                for (cell, r) in results {
                    if let Some(resolved) = r {
                        // 캐시 upsert
                        let _ = sqlx::query(
                            r#"INSERT INTO geocode_cache (lat_q, lng_q, road, jibun, region, building)
                               VALUES ($1, $2, $3, $4, $5, $6)
                               ON CONFLICT (lat_q, lng_q) DO UPDATE SET
                                  road = EXCLUDED.road,
                                  jibun = EXCLUDED.jibun,
                                  region = EXCLUDED.region,
                                  building = EXCLUDED.building,
                                  fetched_at = NOW()"#,
                        )
                        .bind(cell.0).bind(cell.1)
                        .bind(&resolved.road).bind(&resolved.jibun)
                        .bind(&resolved.region).bind(&resolved.building)
                        .execute(db).await;
                        hit_map.insert(cell, resolved);
                    }
                }
            }
        }
    }

    // 4) 원본 coords 순서로 결과 매핑
    let mut out: Vec<Option<Resolved>> = vec![None; coords.len()];
    for (cell, indices) in cell_to_indices {
        if let Some(resolved) = hit_map.get(&cell) {
            for i in indices {
                out[i] = Some(resolved.clone());
            }
        }
    }
    out
}
