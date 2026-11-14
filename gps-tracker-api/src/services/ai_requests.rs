use chrono::NaiveDate;
use sqlx::{FromRow, PgPool, Postgres, Transaction};

use super::{credits, openai::ChatResult};
use crate::error::{AppError, AppResult};

pub const COST: i64 = 20;

#[derive(FromRow)]
pub struct SavedAnalysis {
    pub id: i64,
    pub target_date: NaiveDate,
    pub analysis: String,
    pub model: Option<String>,
}

/// A transaction-scoped advisory lock permits one generation per account.
/// No balance is changed until the report, receipt and ledger all commit.
pub async fn begin(pool: &PgPool, user: i64) -> AppResult<Transaction<'static, Postgres>> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='10s'")
        .execute(&mut *tx)
        .await?;
    let acquired: bool =
        sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(format!("gps-ai-analysis:{user}"))
            .fetch_one(&mut *tx)
            .await?;
    if !acquired {
        return Err(AppError::Conflict(
            "AI 분석이 진행 중입니다. 잠시 후 같은 요청으로 다시 확인해 주세요.".into(),
        ));
    }
    Ok(tx)
}

pub async fn replay(
    tx: &mut Transaction<'_, Postgres>,
    user: i64,
    device: i64,
    date: NaiveDate,
    request: Option<&str>,
) -> AppResult<Option<SavedAnalysis>> {
    let receipt: Option<(i64, NaiveDate, Option<i64>)> = if let Some(key) = request {
        sqlx::query_as("SELECT device_id,target_date,analysis_id FROM ai_analysis_requests WHERE user_id=$1 AND request_id=$2")
            .bind(user).bind(key).fetch_optional(&mut **tx).await?
    } else {
        // Older clients lack request IDs. Reuse a recent identical request rather
        // than charging again after a lost response. New clients are explicit.
        sqlx::query_as("SELECT device_id,target_date,analysis_id FROM ai_analysis_requests WHERE user_id=$1 AND device_id=$2 AND target_date=$3 AND created_at > now()-interval '5 minutes' ORDER BY created_at DESC LIMIT 1")
            .bind(user).bind(device).bind(date).fetch_optional(&mut **tx).await?
    };
    let Some((saved_device, saved_date, analysis_id)) = receipt else {
        return Ok(None);
    };
    if saved_device != device || saved_date != date {
        return Err(AppError::Conflict(
            "이미 사용된 분석 요청입니다. 새 분석을 시작해 주세요.".into(),
        ));
    }
    let id = analysis_id.ok_or_else(|| {
        AppError::Gone("이 요청의 분석 결과는 삭제되었습니다. 새 분석을 시작해 주세요.".into())
    })?;
    Ok(Some(
        sqlx::query_as(
            "SELECT id,target_date,analysis,model FROM gps_read_ai_analyses WHERE id=$1 AND user_id=$2",
        )
        .bind(id)
        .bind(user)
        .fetch_one(&mut **tx)
        .await?,
    ))
}

pub struct Purchase<'a> {
    pub user: i64,
    pub device: i64,
    pub date: NaiveDate,
    pub request: &'a str,
    pub free: bool,
}

pub async fn complete(
    mut tx: Transaction<'_, Postgres>,
    purchase: Purchase<'_>,
    result: &ChatResult,
) -> AppResult<(i64, i64)> {
    let Purchase {
        user,
        device,
        date,
        request,
        free,
    } = purchase;
    // Ownership may change while the external model is running.
    let owner: Option<i64> =
        sqlx::query_scalar("SELECT owner_id FROM gps_read_devices WHERE id=$1 FOR SHARE")
            .bind(device)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
    if owner != Some(user) {
        return Err(AppError::NotFound);
    }
    let cost = if free { 0 } else { COST };
    let id: i64 = sqlx::query_scalar("INSERT INTO ai_analyses (user_id,device_id,target_date,analysis,model,tokens_in,tokens_out,cost_credits) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id")
        .bind(user).bind(device).bind(date).bind(&result.text).bind(&result.model)
        .bind(result.tokens_in).bind(result.tokens_out).bind(cost).fetch_one(&mut *tx).await?;
    let balance = if free {
        sqlx::query_scalar("SELECT credits FROM users WHERE id=$1")
            .bind(user)
            .fetch_one(&mut *tx)
            .await?
    } else {
        credits::charge_tx(
            &mut tx,
            user,
            cost,
            "ai_analysis",
            Some(id),
            Some("AI 운행 분석 저장 완료"),
        )
        .await?
        .balance
    };
    sqlx::query("INSERT INTO ai_analysis_requests(user_id,request_id,device_id,target_date,analysis_id) VALUES($1,$2,$3,$4,$5)")
        .bind(user).bind(request).bind(device).bind(date).bind(id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO ai_usage_log(user_id,endpoint,tokens_in,tokens_out,model) VALUES($1,'route_analyze',$2,$3,$4)")
        .bind(user).bind(result.tokens_in).bind(result.tokens_out).bind(&result.model).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok((id, balance))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires a disposable GPS_AI_TEST_DB"]
    async fn analysis_purchase_is_atomic_and_replayable() {
        let url = std::env::var("GPS_AI_TEST_DB").expect("dedicated test DB required");
        assert!(url.ends_with("/gps_ai_test"));
        let pool = PgPool::connect(&url).await.unwrap();
        sqlx::raw_sql(r#"
          CREATE TABLE users(id bigint PRIMARY KEY,credits bigint NOT NULL);
          CREATE TABLE devices(id bigint PRIMARY KEY,owner_id bigint);
          CREATE TABLE credit_log(id bigserial PRIMARY KEY,user_id bigint,delta bigint,balance bigint,reason text,ref_id bigint,note text);
          CREATE TABLE ai_analyses(id bigserial PRIMARY KEY,user_id bigint,device_id bigint,target_date date,analysis text CHECK(analysis <> 'reject'),model text,tokens_in integer,tokens_out integer,cost_credits bigint);
          CREATE TABLE ai_usage_log(user_id bigint,endpoint text,tokens_in integer,tokens_out integer,model text);
          CREATE VIEW gps_read_devices AS TABLE devices; CREATE VIEW gps_read_ai_analyses AS TABLE ai_analyses;
          INSERT INTO users VALUES(1,100),(2,100);
          INSERT INTO devices VALUES(1,1);
        "#).execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/0066_ai_analysis_requests.sql"
        ))
        .execute(&pool)
        .await
        .unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 10, 8).unwrap();
        let purchase = |request| Purchase {
            user: 1,
            device: 1,
            date,
            request,
            free: false,
        };
        let mut result = ChatResult {
            text: "report".into(),
            model: Some("fake".into()),
            tokens_in: Some(1),
            tokens_out: Some(1),
        };
        let tx = begin(&pool, 1).await.unwrap();
        assert!(begin(&pool, 1).await.is_err());
        tx.rollback().await.unwrap();
        let tx = begin(&pool, 1).await.unwrap();
        let (id, balance) = complete(tx, purchase("first"), &result).await.unwrap();
        assert_eq!(balance, 80);
        let mut tx = begin(&pool, 1).await.unwrap();
        assert_eq!(
            replay(&mut tx, 1, 1, date, Some("first"))
                .await
                .unwrap()
                .unwrap()
                .id,
            id
        );
        assert!(replay(&mut tx, 1, 2, date, Some("first")).await.is_err());
        tx.rollback().await.unwrap();

        result.text = "reject".into();
        assert!(complete(
            begin(&pool, 1).await.unwrap(),
            purchase("bad-report"),
            &result
        )
        .await
        .is_err());
        assert_eq!(credits::balance(&pool, 1).await.unwrap(), 80);
        result.text = "report".into();
        // Fail after charge: report, debit, ledger and receipt must all roll back.
        sqlx::raw_sql("CREATE FUNCTION reject_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test outage'; END $$; CREATE TRIGGER usage_outage BEFORE INSERT ON ai_usage_log FOR EACH ROW EXECUTE FUNCTION reject_usage();")
            .execute(&pool).await.unwrap();
        assert!(complete(
            begin(&pool, 1).await.unwrap(),
            purchase("save-failed"),
            &result
        )
        .await
        .is_err());
        assert_eq!(credits::balance(&pool, 1).await.unwrap(), 80);
        sqlx::raw_sql("DROP TRIGGER usage_outage ON ai_usage_log; CREATE FUNCTION slow_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$; CREATE TRIGGER usage_slow BEFORE INSERT ON ai_usage_log FOR EACH ROW EXECUTE FUNCTION slow_usage();")
            .execute(&pool).await.unwrap();
        let tx = begin(&pool, 1).await.unwrap();
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(30),
            complete(tx, purchase("cancelled"), &result)
        )
        .await
        .is_err());
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        assert_eq!(credits::balance(&pool, 1).await.unwrap(), 80);
        sqlx::query("DROP TRIGGER usage_slow ON ai_usage_log")
            .execute(&pool)
            .await
            .unwrap();
        let tx = begin(&pool, 1).await.unwrap();
        sqlx::query("UPDATE devices SET owner_id=2 WHERE id=1")
            .execute(&pool)
            .await
            .unwrap();
        assert!(complete(tx, purchase("changed-owner"), &result)
            .await
            .is_err());
        sqlx::query("UPDATE devices SET owner_id=1 WHERE id=1")
            .execute(&pool)
            .await
            .unwrap();
        let tx = begin(&pool, 1).await.unwrap();
        sqlx::query("UPDATE users SET credits=0 WHERE id=1")
            .execute(&pool)
            .await
            .unwrap();
        assert!(complete(tx, purchase("spent-elsewhere"), &result)
            .await
            .is_err());
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM gps_read_ai_analyses")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM credit_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        sqlx::query("DELETE FROM ai_analyses WHERE id=$1")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        let mut tx = begin(&pool, 1).await.unwrap();
        assert!(replay(&mut tx, 1, 1, date, Some("first")).await.is_err());
        tx.rollback().await.unwrap();
    }
}
