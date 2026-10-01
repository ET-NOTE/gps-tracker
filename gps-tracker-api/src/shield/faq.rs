use super::*;
use axum::extract::Path;
use serde::Deserialize;

pub async fn list(State(app): State<App>) -> Result<Json<Value>> {
    let rows: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'category',category,'question',question,'answer',answer) FROM faqs WHERE published AND NOT archived ORDER BY position,id").fetch_all(&app.db).await?;
    Ok(Json(json!(rows)))
}
pub async fn admin_list(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    admin::require(&app, &h).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(f)-'updated_by' FROM faqs f ORDER BY position,id LIMIT 1000",
    )
    .fetch_all(&app.db)
    .await?;
    Ok(Json(json!(rows)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Edit {
    category: String,
    question: String,
    answer: String,
    published: bool,
    archived: bool,
    position: i32,
    revision: i32,
}
pub async fn save(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<i64>,
    Json(v): Json<Edit>,
) -> Result<Json<Value>> {
    let actor = admin::require(&app, &h).await?;
    if [(&v.category, 40), (&v.question, 200), (&v.answer, 4000)]
        .iter()
        .any(|(s, max)| s.trim().is_empty() || s.chars().count() > *max)
        || !(0..=10000).contains(&v.position)
        || id < 0
        || v.revision < 0
    {
        return Err(bad("분류·질문·답변과 표시 순서를 확인해 주세요."));
    }
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(8043009)")
        .execute(&mut *tx)
        .await?;
    let old: Option<Value> =
        sqlx::query_scalar("SELECT to_jsonb(f) FROM faqs f WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    if old
        .as_ref()
        .map(|x| x["revision"].as_i64().unwrap_or(-1))
        .unwrap_or(0)
        != i64::from(v.revision)
        || (id != 0 && old.is_none())
    {
        return Err(Error(
            StatusCode::CONFLICT,
            "다른 관리자가 수정했습니다. 목록을 새로고침해 주세요.".into(),
        ));
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM faqs")
        .fetch_one(&mut *tx)
        .await?;
    if id == 0 && count >= 1000 {
        return Err(bad("FAQ는 최대 1,000개까지 관리할 수 있습니다."));
    }
    let row: Value = if id == 0 {
        sqlx::query_scalar("INSERT INTO faqs(category,question,answer,published,archived,position,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING to_jsonb(faqs)")
        .bind(v.category.trim()).bind(v.question.trim()).bind(v.answer.trim()).bind(v.published&&!v.archived).bind(v.archived).bind(v.position).bind(actor).fetch_one(&mut *tx).await?
    } else {
        sqlx::query_scalar("UPDATE faqs SET category=$1,question=$2,answer=$3,published=$4,archived=$5,position=$6,updated_by=$7,revision=revision+1,updated_at=now() WHERE id=$8 RETURNING to_jsonb(faqs)")
        .bind(v.category.trim()).bind(v.question.trim()).bind(v.answer.trim()).bind(v.published&&!v.archived).bind(v.archived).bind(v.position).bind(actor).bind(id).fetch_one(&mut *tx).await?
    };
    admin::audit(
        &mut tx,
        Some(actor),
        "faq.save",
        "faq",
        &row["id"].to_string(),
        json!({"before":old,"after":row}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(row))
}
