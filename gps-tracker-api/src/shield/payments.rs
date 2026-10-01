//! Shield wallet only. Never reads GPS keys or databases.
use super::*;
use axum::extract::Path;
use serde::Deserialize;

pub const AMOUNTS: [i64; 4] = [10000, 30000, 50000, 100000];
#[derive(Clone)]
pub struct Provider {
    client: reqwest::Client,
    base: String,
    client_key: String,
    secret: String,
    enabled: bool,
}
impl Provider {
    pub fn config(production: bool) -> anyhow::Result<Self> {
        let base = env::var("SHIELD_TOSS_BASE_URL").unwrap_or_else(|_| {
            if production {
                "https://api.tosspayments.com".into()
            } else {
                "http://127.0.0.1:9053".into()
            }
        });
        let client_key = env::var("SHIELD_TOSS_CLIENT_KEY").unwrap_or_default();
        let secret = env::var("SHIELD_TOSS_SECRET_KEY").unwrap_or_default();
        let enabled = env::var("SHIELD_TOSS_ENABLED").as_deref() == Ok("true");
        let url = reqwest::Url::parse(&base)?;
        anyhow::ensure!(
            if production {
                base == "https://api.tosspayments.com"
            } else {
                matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
            },
            "Shield preview payments require a loopback mock"
        );
        if enabled {
            let prefix = if production { "live" } else { "test" };
            anyhow::ensure!(
                client_key.starts_with(&format!("{prefix}_ck_"))
                    && secret.starts_with(&format!("{prefix}_sk_")),
                "Shield payment key mode mismatch"
            );
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            base,
            client_key,
            secret,
            enabled,
        })
    }
    async fn payment(&self, key: &str, order: &str, amount: i64, confirm: bool) -> Option<Value> {
        let req = if confirm {
            self.client
                .post(format!("{}/v1/payments/confirm", self.base))
                .header("Idempotency-Key", order)
                .json(&json!({"paymentKey":key,"orderId":order,"amount":amount}))
        } else {
            self.client.get(format!("{}/v1/payments/{key}", self.base))
        };
        let r = req.basic_auth(&self.secret, Some("")).send().await.ok()?;
        if !r.status().is_success() {
            return None;
        }
        r.json().await.ok()
    }
}
pub async fn config(State(app): State<App>) -> Json<Value> {
    Json(
        json!({"enabled":app.payments.enabled,"amounts":AMOUNTS,"sim_sales_enabled":usim::sales_enabled(),"sim_plans":if usim::sales_enabled(){json!([{"id":"nce-500","mb":500,"cost_credits":usim::price()}])}else{json!([])}}),
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Create {
    amount: i64,
    idempotency_key: Uuid,
}
pub async fn create(
    State(app): State<App>,
    h: HeaderMap,
    Json(v): Json<Create>,
) -> Result<Json<Value>> {
    let user = auth::user(&app, &h).await?;
    if !app.payments.enabled {
        return Err(bad("온라인 포인트 충전을 준비 중입니다."));
    }
    if !AMOUNTS.contains(&v.amount) {
        return Err(bad("충전 금액을 다시 선택해 주세요."));
    }
    auth::rate(&app, format!("payment-create:{user}"), 20).await?;
    let id = format!("shield_{}", Uuid::new_v4().simple());
    let row:(String,i64,String)=sqlx::query_as("INSERT INTO point_orders(id,user_id,amount,idempotency_key) VALUES($1,$2,$3,$4::text::uuid) ON CONFLICT(user_id,idempotency_key) DO UPDATE SET id=point_orders.id RETURNING id,amount,status")
        .bind(id).bind(user).bind(v.amount).bind(v.idempotency_key.to_string()).fetch_one(&app.db).await?;
    if row.1 != v.amount || row.2 != "pending" {
        return Err(bad(
            "이미 사용한 주문 번호입니다. 충전창을 다시 열어 주세요.",
        ));
    }
    Ok(Json(
        json!({"order_id":row.0,"amount":row.1,"client_key":app.payments.client_key,"order_name":format!("Shield {}P 충전",row.1)}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Confirm {
    order_id: String,
    payment_key: String,
    amount: i64,
}
pub async fn confirm(
    State(app): State<App>,
    h: HeaderMap,
    Json(v): Json<Confirm>,
) -> Result<Json<Value>> {
    let user = auth::user(&app, &h).await?;
    if !app.payments.enabled {
        return Err(bad("온라인 포인트 충전을 준비 중입니다."));
    }
    if v.payment_key.is_empty()
        || v.payment_key.len() > 200
        || !v
            .payment_key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        return Err(bad("결제 정보를 확인해 주세요."));
    }
    auth::rate(&app, format!("payment-confirm:{user}"), 30).await?;
    let mut tx = app.db.begin().await?;
    let row: Option<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT amount,status,payment_key FROM point_orders WHERE id=$1 AND user_id=$2 FOR UPDATE",
    )
    .bind(&v.order_id)
    .bind(user)
    .fetch_optional(&mut *tx)
    .await?;
    let (amount, status, key) = row.ok_or_else(missing)?;
    if amount != v.amount || key.as_ref().is_some_and(|k| k != &v.payment_key) {
        return Err(bad("주문 금액 또는 결제 정보가 일치하지 않습니다."));
    }
    if status == "paid" {
        return Ok(Json(json!({"status":"paid","amount":amount})));
    }
    let first = status == "pending";
    if first {
        sqlx::query("UPDATE point_orders SET payment_key=$2,status='confirming',updated_at=now() WHERE id=$1").bind(&v.order_id).bind(&v.payment_key).execute(&mut *tx).await?;
    }
    // Commit before the remote call. A timeout/restart must never trigger a second approval.
    tx.commit().await?;
    let response = app
        .payments
        .payment(&v.payment_key, &v.order_id, amount, first)
        .await;
    settle(&app, user, &v.order_id, &v.payment_key, amount, response).await
}
async fn settle(
    app: &App,
    actor: i64,
    id: &str,
    key: &str,
    amount: i64,
    value: Option<Value>,
) -> Result<Json<Value>> {
    let valid = value.is_some_and(|v| {
        v["status"] == "DONE"
            && v["orderId"] == id
            && v["paymentKey"] == key
            && v["totalAmount"] == amount
            && v["currency"] == "KRW"
            && v["balanceAmount"] == amount
    });
    let mut tx = app.db.begin().await?;
    let (owner, status): (i64, String) =
        sqlx::query_as("SELECT user_id,status FROM point_orders WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if status == "paid" {
        return Ok(Json(json!({"status":"paid","amount":amount})));
    }
    if !valid {
        sqlx::query("UPDATE point_orders SET status='unknown',updated_at=now() WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(Json(
            json!({"status":"unknown","message":"결제 결과를 확인 중입니다. 새로 결제하지 말고 이 주문의 결과를 다시 조회해 주세요."}),
        ));
    }
    let balance: i64 = sqlx::query_scalar(
        "UPDATE users SET credit_balance=credit_balance+$2 WHERE id=$1 RETURNING credit_balance",
    )
    .bind(owner)
    .bind(amount)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO credit_entries(user_id,actor_id,amount,balance_after,kind,reference,note) VALUES($1,$2,$3,$4,'payment',$5,'카드 결제 포인트 충전')")
        .bind(owner).bind(actor).bind(amount).bind(balance).bind(format!("payment:{id}")).execute(&mut *tx).await?;
    sqlx::query("UPDATE point_orders SET status='paid',paid_at=now(),updated_at=now() WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    admin::audit(
        &mut tx,
        Some(actor),
        "payment.paid",
        "point_order",
        id,
        json!({"amount":amount,"user_id":owner}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"status":"paid","amount":amount,"balance":balance}),
    ))
}
pub async fn list(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let user = auth::user(&app, &h).await?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'amount',amount,'status',status,'created_at',created_at,'paid_at',paid_at) FROM point_orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100").bind(user).fetch_all(&app.db).await?;
    Ok(Json(json!(rows)))
}
pub async fn reconcile(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let user = auth::user(&app, &h).await?;
    if !app.payments.enabled {
        return Err(bad("결제 조회 설정을 확인해 주세요."));
    }
    auth::rate(&app, format!("payment-reconcile:{user}"), 30).await?;
    let row: Option<(i64, Option<String>, String)> = sqlx::query_as(
        "SELECT amount,payment_key,status FROM point_orders WHERE id=$1 AND user_id=$2",
    )
    .bind(&id)
    .bind(user)
    .fetch_optional(&app.db)
    .await?;
    let (amount, key, status) = row.ok_or_else(missing)?;
    if status == "paid" {
        return Ok(Json(json!({"status":"paid","amount":amount})));
    }
    let key = key.ok_or_else(|| bad("승인 요청 전인 주문입니다."))?;
    let value = app.payments.payment(&key, &id, amount, false).await;
    settle(&app, user, &id, &key, amount, value).await
}
