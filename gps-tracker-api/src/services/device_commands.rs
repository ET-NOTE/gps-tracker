use crate::error::{AppError, AppResult};
use serde_json::{json, Value};
use sqlx::PgPool;

pub async fn enqueue(
    db: &PgPool,
    device: i64,
    user: i64,
    kind: &str,
    arguments: Value,
) -> AppResult<Value> {
    let mut tx = db.begin().await?;
    let owned: Option<i64> =
        sqlx::query_scalar("SELECT id FROM devices WHERE id=$1 AND owner_id=$2 FOR UPDATE")
            .bind(device)
            .bind(user)
            .fetch_optional(&mut *tx)
            .await?;
    if owned.is_none() {
        return Err(AppError::NotFound);
    }
    let signed: bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM device_credentials WHERE device_id=$1 AND activated_at IS NOT NULL) OR EXISTS(SELECT 1 FROM devices d JOIN hardware_credentials h ON h.auth_uid=d.active_auth_uid WHERE d.id=$1 AND h.activated_at IS NOT NULL AND h.authorized_owner_id=d.owner_id)")
        .bind(device).fetch_one(&mut *tx).await?;
    if !signed {
        return Err(AppError::BadRequest(
            "이 단말기는 인증 펌웨어로 갱신한 뒤 원격 명령을 사용할 수 있습니다.".into(),
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO device_commands(id,device_id,user_id,kind,arguments) VALUES($1::text::uuid,$2,$3,$4,$5)")
        .bind(&id).bind(device).bind(user).bind(kind).bind(arguments).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(json!({"ok":true,"device_id":device,"command_id":id,
        "note":"인증된 다음 통신에서 전달하고, 단말기의 수신 확인까지 재전송합니다."}))
}

pub async fn dispatch(db: &PgPool, device: i64, ack: Option<&str>) -> AppResult<Value> {
    let mut tx = db.begin().await?;
    let owner: Option<i64> =
        sqlx::query_scalar("SELECT owner_id FROM devices WHERE id=$1 FOR UPDATE")
            .bind(device)
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query(
        "UPDATE device_commands SET cancelled_at=now()
        WHERE device_id=$1 AND acknowledged_at IS NULL AND cancelled_at IS NULL
          AND (user_id IS DISTINCT FROM $2 OR requested_at<now()-interval '10 minutes')",
    )
    .bind(device)
    .bind(owner)
    .execute(&mut *tx)
    .await?;
    if let Some(ack) = ack {
        if uuid::Uuid::parse_str(ack).is_err() {
            return Err(AppError::BadRequest(
                "invalid command acknowledgement".into(),
            ));
        }
        sqlx::query(
            "UPDATE device_commands SET acknowledged_at=now()
            WHERE id=$1::text::uuid AND device_id=$2 AND user_id=$3
                AND acknowledged_at IS NULL AND cancelled_at IS NULL",
        )
        .bind(ack)
        .bind(device)
        .bind(owner)
        .execute(&mut *tx)
        .await?;
    }
    let next: Option<(String, String, Value)> = sqlx::query_as(
        "SELECT id::text,kind,arguments FROM device_commands
        WHERE device_id=$1 AND user_id=$2 AND acknowledged_at IS NULL AND cancelled_at IS NULL
        ORDER BY CASE kind WHEN 'reset' THEN 0 ELSE 1 END,requested_at,id LIMIT 1 FOR UPDATE",
    )
    .bind(device)
    .bind(owner)
    .fetch_optional(&mut *tx)
    .await?;
    let mut response = json!({"ok":true});
    if let Some((id, kind, args)) = next {
        sqlx::query("UPDATE device_commands SET delivered_at=now(),attempts=attempts+1 WHERE id=$1::text::uuid")
            .bind(&id).execute(&mut *tx).await?;
        response["command_id"] = json!(id);
        if kind == "post_interval" {
            response["post_interval_s"] = args["seconds"].clone();
        } else {
            response["cmd"] = json!(kind);
        }
    }
    tx.commit().await?;
    Ok(response)
}
