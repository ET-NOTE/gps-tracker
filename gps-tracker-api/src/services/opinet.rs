// (2026-07-28) Stage-4D: 오피넷 (한국석유공사) 전국 평균 유가 실시간 fetch + 캐시.
//
// 목적: 월간 리포트 유류비 추정을 하드코딩 상수 (휘발유 1700 / 경유 1600 / LPG 1000) 대신
// 오피넷 최신 전국 평균으로 자동 갱신.
//
// API: https://www.opinet.co.kr/api/avgAllPrice.do?code=<KEY>&out=json
//   PRODCD: B027 휘발유 · D047 경유 · C004 LPG · B034 고급휘발유 · K015 실내등유
//
// 회원가입 필수 (data.go.kr 또는 opinet 사이트). Key 없으면 기본값 fallback.
//
// 캐시 전략: process-wide RwLock. 캐시가 6시간 이내면 재사용, 초과 시 재fetch.
// 실패해도 마지막 성공값 유지 — API 다운타임 저항.

use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// 기본값 — 오피넷 KEY 미설정이거나 API 실패 시 사용. 정기 리뷰 필요.
const DEFAULT_GASOLINE: i64 = 1700;
const DEFAULT_DIESEL:   i64 = 1600;
const DEFAULT_LPG:      i64 = 1000;

const CACHE_TTL: Duration = Duration::from_secs(6 * 3600);   // 6h
const HTTP_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Serialize)]
pub struct FuelPrices {
    pub gasoline: i64,
    pub diesel:   i64,
    pub lpg:      i64,
    /// "opinet" (실 API) | "default" (fallback)
    pub source:   String,
    pub updated_at: DateTime<Utc>,
}

impl Default for FuelPrices {
    fn default() -> Self {
        Self {
            gasoline: DEFAULT_GASOLINE, diesel: DEFAULT_DIESEL, lpg: DEFAULT_LPG,
            source: "default".into(),
            updated_at: Utc::now(),
        }
    }
}

struct CacheEntry {
    prices:     FuelPrices,
    fetched_at: Instant,
}

pub struct OpinetCache {
    inner: RwLock<Option<CacheEntry>>,
}

impl Default for OpinetCache {
    fn default() -> Self {
        Self { inner: RwLock::new(None) }
    }
}

impl OpinetCache {
    pub fn new() -> Arc<Self> { Arc::new(Self::default()) }

    /// 캐시 조회. 없거나 stale 이면 refetch 시도.
    pub async fn get_or_fetch(&self) -> FuelPrices {
        if let Some((prices, at)) = self.inner.read().ok().and_then(|g|
            g.as_ref().map(|e| (e.prices.clone(), e.fetched_at)))
        {
            if at.elapsed() < CACHE_TTL {
                return prices;
            }
        }
        match fetch_opinet().await {
            Ok(fresh) => {
                if let Ok(mut w) = self.inner.write() {
                    *w = Some(CacheEntry { prices: fresh.clone(), fetched_at: Instant::now() });
                }
                fresh
            }
            Err(e) => {
                tracing::warn!("opinet fetch failed: {e} — fallback to cached/default");
                if let Some(cached) = self.inner.read().ok().and_then(|g| g.as_ref().map(|e| e.prices.clone())) {
                    cached
                } else {
                    FuelPrices::default()
                }
            }
        }
    }

    /// 캐시 스냅샷 (fetch 없이). 캐시 없으면 default.
    pub fn snapshot(&self) -> FuelPrices {
        self.inner.read().ok().and_then(|g| g.as_ref().map(|e| e.prices.clone()))
            .unwrap_or_default()
    }

    /// 백그라운드 워커 — 부팅 후 즉시 첫 fetch + 6h 주기 refetch.
    pub fn spawn_refresh_worker(self: Arc<Self>) {
        tokio::spawn(async move {
            let _ = self.get_or_fetch().await;
            let mut interval = tokio::time::interval(CACHE_TTL);
            interval.tick().await;   // 첫 tick 즉시 소비
            loop {
                interval.tick().await;
                let _ = self.get_or_fetch().await;
            }
        });
    }
}

// ═══════════════════════════════════════════════════════════════
// 실 API 호출
// ═══════════════════════════════════════════════════════════════
#[derive(Debug, Deserialize)]
struct OpinetResp {
    #[serde(rename = "RESULT")]
    result: OpinetResult,
}
#[derive(Debug, Deserialize)]
struct OpinetResult {
    #[serde(rename = "OIL")]
    oil: Vec<OpinetOil>,
}
#[derive(Debug, Deserialize)]
struct OpinetOil {
    #[serde(rename = "PRODCD")]
    prodcd: String,
    #[serde(rename = "PRICE")]
    price: f64,
}

async fn fetch_opinet() -> anyhow::Result<FuelPrices> {
    let key = std::env::var("OPINET_API_KEY").ok().filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("OPINET_API_KEY not set"))?;

    let url = format!("https://www.opinet.co.kr/api/avgAllPrice.do?code={key}&out=json");
    let client = reqwest::Client::builder().timeout(HTTP_TIMEOUT).build()?;
    let resp: OpinetResp = client.get(&url).send().await?.error_for_status()?.json().await?;

    let mut gasoline = DEFAULT_GASOLINE;
    let mut diesel   = DEFAULT_DIESEL;
    let mut lpg      = DEFAULT_LPG;
    for oil in &resp.result.oil {
        let price = oil.price.round() as i64;
        match oil.prodcd.as_str() {
            "B027" => gasoline = price,
            "D047" => diesel   = price,
            "C004" => lpg      = price,
            _ => {}
        }
    }
    tracing::info!("opinet fetched: gasoline={gasoline} diesel={diesel} lpg={lpg}");
    Ok(FuelPrices {
        gasoline, diesel, lpg,
        source: "opinet".into(),
        updated_at: Utc::now(),
    })
}
