//! Dedicated Shield adapter; no GPS environment, worker, DB or provider mutations
//! outside the explicit one-shot topup method. Mirrors the established OAuth flow.
use super::*;
use std::time::Instant;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct Provider {
    client: reqwest::Client,
    base: String,
    version: String,
    id: String,
    secret: String,
    enabled: bool,
    token: Arc<Mutex<Option<(String, Instant)>>>,
}
pub fn normalize_iccid(raw: &str) -> Result<String> {
    if ![19, 20].contains(&raw.len()) || !raw.bytes().all(|c| c.is_ascii_digit()) {
        return Err(bad("USIM 번호는 19~20자리 숫자여야 합니다."));
    }
    Ok(raw[..19].to_string())
}
impl Provider {
    pub fn config(production: bool) -> anyhow::Result<Self> {
        let base =
            env::var("SHIELD_NCE_BASE_URL").unwrap_or("https://api.1nce.com/management-api".into());
        if production {
            anyhow::ensure!(
                base == "https://api.1nce.com/management-api",
                "Unexpected provider URL"
            );
        } else if base != "https://api.1nce.com/management-api" {
            let u = reqwest::Url::parse(&base)?;
            anyhow::ensure!(
                matches!(u.host_str(), Some("localhost" | "127.0.0.1")),
                "Mock provider must be loopback"
            );
        }
        let version = env::var("SHIELD_NCE_API_VERSION").unwrap_or("v1".into());
        anyhow::ensure!(
            ["v1", "v2"].contains(&version.as_str()),
            "Unknown 1NCE version"
        );
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(12))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            base,
            version,
            id: env::var("SHIELD_NCE_CLIENT_ID").unwrap_or_default(),
            secret: env::var("SHIELD_NCE_CLIENT_SECRET").unwrap_or_default(),
            enabled: env::var("SHIELD_NCE_TOPUP_ENABLED").as_deref() == Ok("true"),
            token: Arc::new(Mutex::new(None)),
        })
    }
    pub fn configured(&self) -> bool {
        !self.id.is_empty() && !self.secret.is_empty()
    }
    pub fn can_topup(&self) -> bool {
        self.configured() && self.enabled
    }
    pub fn status(&self) -> Value {
        json!({"configured":self.configured(),"topup_enabled":self.can_topup(),"api_version":self.version})
    }
    async fn token(&self) -> Result<String> {
        if !self.configured() {
            return Err(bad("USIM 조회 설정을 준비 중입니다."));
        }
        let mut guard = self.token.lock().await;
        if let Some((token, at)) = &*guard {
            if at.elapsed() < Duration::from_secs(55 * 60) {
                return Ok(token.clone());
            }
        }
        let response = self
            .client
            .post(format!("{}/oauth/token", self.base))
            .basic_auth(&self.id, Some(&self.secret))
            .json(&json!({"grant_type":"client_credentials"}))
            .send()
            .await
            .map_err(|_| provider_error())?;
        if !response.status().is_success() {
            return Err(provider_error());
        }
        let data: Value = response.json().await.map_err(|_| provider_error())?;
        let token = data["access_token"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(provider_error)?
            .to_owned();
        *guard = Some((token.clone(), Instant::now()));
        Ok(token)
    }
    async fn get(&self, path: &str) -> Result<Value> {
        for attempt in 0..2 {
            let token = self.token().await?;
            let response = self
                .client
                .get(format!("{}/{}/{}", self.base, self.version, path))
                .bearer_auth(token)
                .send()
                .await
                .map_err(|_| provider_error())?;
            if response.status() == StatusCode::UNAUTHORIZED && attempt == 0 {
                *self.token.lock().await = None;
                continue;
            }
            if !response.status().is_success() {
                return Err(provider_error());
            }
            return response.json().await.map_err(|_| provider_error());
        }
        Err(provider_error())
    }
    pub async fn usage(&self, iccid: &str) -> Result<Value> {
        let id = normalize_iccid(iccid)?;
        let info = self.get(&format!("sims/{id}")).await?;
        let quota = self.get(&format!("sims/{id}/quota/data")).await?;
        let remaining = quota["volume"]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0)
            .ok_or_else(provider_error)?;
        let total = quota["total_volume"]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= remaining)
            .ok_or_else(provider_error)?;
        Ok(
            json!({"remaining_mb":remaining,"total_mb":total,"status":info["status"],"expires_at":quota["expiry_date"],"activation_date":info["activation_date"]}),
        )
    }
    pub async fn topup(&self, iccid: &str) -> Result<(u16, Option<String>)> {
        if !self.can_topup() {
            return Err(bad("통신사 충전 실행이 비활성화되어 있습니다."));
        }
        let id = normalize_iccid(iccid)?;
        let token = self.token().await?;
        // Never retry this POST, including timeouts and authentication failures.
        let response = self
            .client
            .post(format!("{}/{}/sims/{id}/topup", self.base, self.version))
            .query(&[("payment_method", "banktransfer")])
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| provider_error())?;
        let order = response
            .headers()
            .get("location")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.trim_end_matches('/').rsplit('/').next())
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 100
                    && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
            .map(str::to_owned);
        Ok((response.status().as_u16(), order))
    }
    pub async fn order(&self, id: &str) -> Result<Value> {
        if id.is_empty()
            || id.len() > 100
            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(bad("주문 번호 형식을 확인해 주세요."));
        }
        // Order API remains v1 independently of the SIM API version.
        let token = self.token().await?;
        let r = self
            .client
            .get(format!("{}/v1/orders/{id}", self.base))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| provider_error())?;
        if !r.status().is_success() {
            return Err(provider_error());
        }
        r.json().await.map_err(|_| provider_error())
    }
}
fn provider_error() -> Error {
    Error(
        StatusCode::BAD_GATEWAY,
        "통신사 응답을 확인하지 못했습니다. 마지막 조회값을 확인해 주세요.".into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn iccid_validation() {
        assert_eq!(
            normalize_iccid("89882806660000000001").unwrap(),
            "8988280666000000000"
        );
        assert!(normalize_iccid("/../../sims").is_err());
        assert!(normalize_iccid("１２３４５６７８９").is_err());
    }
}
